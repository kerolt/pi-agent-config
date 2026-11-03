/**
 * 把连续的工具调用合并成一组。
 *
 * 相邻的工具行收进一张分组卡：折叠时是一行头部加上每个工具一行摘要，展开时按分支
 * 把每个工具自己的调用行与正文铺开。edit / write / apply_patch 保持独立，diff 单独展示。
 * 分组在子组件加入容器时完成，渲染不出内容的助手消息不打断分组。
 * 头部的数量与状态每帧现算，执行中的工具跟着自己的 spinner 一起动。
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  attach,
  detach,
  parentOf,
  patchChatTree,
  setChildAddedHook,
  setChildRemovedHook,
  sharedObject,
} from "./chat-tree.ts";
import type { ChatContainer } from "./chat-tree.ts";
import { loadBundle } from "../lib/pi-bundle.ts";

/** 分支符号占的列数，工具行自己左侧还有一格缩进 */
const PREFIX_WIDTH = 2;

/** 往前找同组工具时最多跳过的空白组件个数 */
const MAX_SKIPPED = 3;

/** diff 类工具与 subagent 独立展示，不进分组 */
const NON_GROUPABLE = new Set(["edit", "apply_patch", "subagent"]);

/** Pi 把当前主题放在这个全局符号下，分组卡不经过渲染器回调，只能从这里取色 */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

type ToolStatus = "pending" | "success" | "error";

/** 只用到 ToolExecutionComponent 里与分组有关的部分 */
type ToolRow = {
  toolName: string;
  expanded: boolean;
  result?: { isError?: boolean };
  isPartial?: boolean;
  executionStarted?: boolean;
  rendererState?: Record<string, unknown>;
  render: (width: number) => string[];
  setExpanded?: (expanded: boolean) => void;
  invalidate?: () => void;
};

type ToolRowClass = {
  new (...args: unknown[]): ToolRow;
  prototype: ToolRow;
};

/** 只用到 AssistantMessageComponent 里判断有没有可见内容的部分 */
type AssistantRowClass = {
  new (...args: unknown[]): { contentContainer?: { children?: unknown[] } };
};

type ContainerComponent = ChatContainer & {
  addChild(child: unknown): void;
  render(width: number): string[];
  invalidate?(): void;
};

/** 分组是否已经装好，重复的 session_start 不再重复安装 */
let installed = false;

function currentTheme(): Theme {
  const theme = (globalThis as Record<symbol, Theme | undefined>)[THEME_KEY];
  if (theme === undefined) {
    throw new Error("主题尚未初始化，工具分组无法取色");
  }
  return theme;
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || stripTerminalSequences(line).trim() === "";
}

/**
 * 只画空白的叶子组件（Spacer）。不拿类引用做判断：打包产物里的 Spacer 与扩展导入的
 * 不是同一个类，按结构认更可靠。
 */
function isBlankRow(value: unknown): boolean {
  if (value === null || typeof value !== "object" || "children" in value) {
    return false;
  }
  const render = (value as { render?: unknown }).render;
  if (typeof render !== "function") {
    return false;
  }
  const lines = (render as (width: number) => string[]).call(value, 1);
  return (
    Array.isArray(lines) &&
    lines.every((line) => stripTerminalSequences(String(line)).trim() === "")
  );
}

/** 工具名的显示形式：bash -> Bash，ask_user_question -> Ask User Question */
function humanizeToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusOf(tool: ToolRow): ToolStatus {
  if (tool.result?.isError) {
    return "error";
  }
  if (
    tool.isPartial === true ||
    (tool.executionStarted === true && tool.result === undefined)
  ) {
    return "pending";
  }
  return tool.result === undefined ? "pending" : "success";
}

/** 一组里出现多个工具名时的清单：bash×2, read */
function toolNameList(tools: ToolRow[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    counts.set(tool.toolName, (counts.get(tool.toolName) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
    .join(", ");
}

/** 分组卡自己不再画耗时与展开提示，交给头部统一展示 */
function setGrouped(tool: ToolRow, grouped: boolean): void {
  const state = tool.rendererState;
  if (state === undefined || state.grouped === grouped) {
    return;
  }
  state.grouped = grouped;
  tool.invalidate?.();
}

/** 分组卡：头部一行汇总，下面是每个工具自己的行 */
function createGroupClass(base: new () => ContainerComponent) {
  return class ToolGroup extends base {
    expanded = false;

    constructor(tools: ToolRow[], expanded: boolean) {
      super();
      this.expanded = expanded;
      for (const tool of tools) {
        this.adopt(tool);
      }
    }

    /** 把一个工具收进分组 */
    adopt(tool: ToolRow): void {
      this.addChild(tool);
      setGrouped(tool, true);
      tool.setExpanded?.(this.expanded);
    }

    /** 分组的展开状态是唯一来源，同时套到组内每个工具上 */
    setExpanded(expanded: boolean): void {
      if (this.expanded === expanded) {
        return;
      }
      this.expanded = expanded;
      for (const tool of this.children as ToolRow[]) {
        tool.setExpanded?.(expanded);
      }
    }

    render(width: number): string[] {
      const theme = currentTheme();
      const tools = this.children as ToolRow[];
      const lines = [
        "",
        truncateToWidth(this.headerLine(theme, tools), width, "..."),
      ];
      const childWidth = Math.max(1, width - PREFIX_WIDTH);
      // 展开时整块铺 userMessageBg，分支符号也要在背景上，否则左侧会缺一条
      const bgOpen = this.expanded ? theme.getBgAnsi("userMessageBg") : "";
      tools.forEach((tool, index) => {
        const last = index === tools.length - 1;
        const branch = last ? "└" : "├";
        const continuation = last ? "  " : "│ ";
        const rendered = tool.render(childWidth);
        const visible =
          rendered.length > 0 && isBlank(rendered[0])
            ? rendered.slice(1)
            : rendered;
        visible.forEach((line, lineIndex) => {
          const glyph = lineIndex === 0 ? branch : continuation;
          lines.push(`${bgOpen} ${theme.fg("dim", glyph)}${line}`);
        });
      });
      return lines;
    }

    /** 点分组任意一行切换展开，空行不响应 */
    handleMouse(event: TuiMouseEvent): unknown {
      if (event.type !== "click" || event.button !== "left" || event.y <= 0) {
        return undefined;
      }
      this.setExpanded(!this.expanded);
      return { handled: true };
    }

    invalidate(): void {
      for (const tool of this.children as ToolRow[]) {
        tool.invalidate?.();
      }
    }

    private headerLine(theme: Theme, tools: ToolRow[]): string {
      const counts = { pending: 0, success: 0, error: 0 };
      for (const tool of tools) {
        counts[statusOf(tool)]++;
      }
      const parts: string[] = [];
      if (counts.pending > 0) {
        parts.push(theme.fg("accent", `${counts.pending} running`));
      }
      if (counts.success > 0) {
        parts.push(theme.fg("success", `${counts.success} done`));
      }
      if (counts.error > 0) {
        parts.push(theme.fg("error", `${counts.error} failed`));
      }
      const overall =
        counts.error > 0 ? "error" : counts.pending > 0 ? "accent" : "success";
      const names = [...new Set(tools.map((tool) => tool.toolName))];
      const label =
        names.length === 1
          ? humanizeToolName(names[0] ?? "")
          : "Multiple Tools";
      const nameList =
        names.length > 1
          ? ` ${theme.fg("dim", `• ${toolNameList(tools)}`)}`
          : "";
      const hint = this.expanded
        ? ""
        : ` ${theme.fg("dim", "•")} ${keyHint("app.tools.expand", "to expand")}`;
      const bullet = theme.fg(overall, "●");
      return ` ${bullet} ${theme.bold(theme.fg("accent", label))}: ${parts.join(theme.fg("dim", " • "))}${nameList}${hint}`;
    }
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    if (installed) {
      return;
    }
    const bundle = await loadBundle();
    const toolClass = bundle.ToolExecutionComponent as ToolRowClass | undefined;
    const assistantClass = bundle.AssistantMessageComponent as
      | AssistantRowClass
      | undefined;
    if (!toolClass || !assistantClass) {
      throw new Error(
        "打包入口里没有 ToolExecutionComponent 或 AssistantMessageComponent，工具不分组",
      );
    }
    patchChatTree(toolClass);

    const base = Object.getPrototypeOf(toolClass.prototype)
      .constructor as new () => ContainerComponent;
    // 重新加载扩展时沿用同一个分组类，旧分组才能被新回调识别
    const ToolGroup = sharedObject("tool-group", () => createGroupClass(base));

    const groupable = (value: unknown): value is ToolRow =>
      value instanceof toolClass && !NON_GROUPABLE.has(value.toolName);

    /** 空行组件与渲染不出内容的助手消息都不算分组边界 */
    const ignorable = (value: unknown): boolean => {
      if (value instanceof assistantClass) {
        const children = value.contentContainer?.children;
        return Array.isArray(children) && children.length === 0;
      }
      return isBlankRow(value);
    };

    /** 往前找到第一个能看见的同级组件，跳过空行与空白助手消息 */
    const anchorOf = (
      children: unknown[],
      start: number,
    ): { child: unknown; index: number } | undefined => {
      let skipped = 0;
      for (let index = start; index >= 0; index--) {
        const child = children[index];
        if (ignorable(child) && skipped < MAX_SKIPPED) {
          skipped++;
          continue;
        }
        return { child, index };
      }
      return undefined;
    };

    /** 分组只剩一个工具时拆回普通工具行 */
    const dissolve = (group: InstanceType<typeof ToolGroup>): void => {
      const parent = parentOf(group);
      if (parent === undefined) {
        return;
      }
      const index = parent.children.indexOf(group);
      if (index < 0) {
        return;
      }
      const tools = [...(group.children as ToolRow[])];
      group.children.length = 0;
      for (const tool of tools) {
        detach(tool);
        setGrouped(tool, false);
      }
      parent.children.splice(index, 1, ...tools);
      for (const tool of tools) {
        attach(parent, tool);
      }
      detach(group);
    };

    setChildAddedHook((parent, child) => {
      if (!groupable(child) || parent instanceof ToolGroup) {
        return;
      }
      const index = parent.children.indexOf(child);
      if (index <= 0) {
        return;
      }
      const anchor = anchorOf(parent.children, index - 1);
      if (anchor === undefined) {
        return;
      }
      if (anchor.child instanceof ToolGroup) {
        parent.children.splice(index, 1);
        detach(child);
        anchor.child.adopt(child);
        return;
      }
      if (!groupable(anchor.child)) {
        return;
      }
      const group = new ToolGroup([anchor.child, child], child.expanded);
      parent.children.splice(index, 1);
      detach(child);
      parent.children.splice(anchor.index, 1, group);
      attach(parent, group);
    });

    setChildRemovedHook((parent, child) => {
      if (parent instanceof ToolGroup) {
        if (parent.children.length < 2) {
          dissolve(parent);
        }
        return;
      }
      if (child instanceof ToolGroup) {
        for (const tool of child.children as ToolRow[]) {
          detach(tool);
          setGrouped(tool, false);
        }
        child.children.length = 0;
      }
    });

    installed = true;
  });
}
