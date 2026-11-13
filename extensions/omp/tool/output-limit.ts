/**
 * 把工具调用画成 codex 的样子。
 *
 * 每次调用一行 `• Ran <命令>`，下一行用 `└` 引出输出的开头几行。折叠时只展示前几行，
 * 其余内容折成一行 `+ N lines (… to expand)`；展开时展示完整正文，最多 100 行，
 * 超出部分换成一行提示。展开与折叠仍然走 ctrl+o 或点击该行。
 *
 * 工具自己画的外框、内边距、背景与耗时行在这里被丢掉，由统一的外壳重新绘制。
 */

import type { Component } from "@earendil-works/pi-tui";
import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ThemeColor,
	ToolRenderers,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Spacer,
	Text,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { currentTheme } from "../lib/codex-style.ts";

/** 展开时正文与调用行文字各自展示的最大行数 */
const MAX_EXPANDED_LINES = 100;

/** 调用行文字里第 1 行是工具自己的标题，标题之后的文字同样按上面的上限截断 */
const CALL_HEADER_LINES = 1;

/** 调用行参数预览的最大字符数 */
const COLLAPSED_ARGS_CHARS = 100;

/** 折叠时输出的预览行数 */
const PREVIEW_LINES = 3;

/** 调用行与正文相对 transcript 左边界的缩进，与消息标记占用的列一致 */
const CARD_INDENT = " ";
const BRANCH = "└";

/** `└` 所在列与正文起始列 */
const BRANCH_LEAD = `${CARD_INDENT}  ${BRANCH} `;
const BRANCH_TAIL = " ".repeat(visibleWidth(BRANCH_LEAD));

/** 状态图标与标题使用的颜色 */
const STATUS_COLOR = "success";
const LABEL_COLOR = "success";

/** 工具名对应的动词，与 codex 的 `Ran`、`Read`、`Edited` 一致 */
const TOOL_LABELS: Record<string, string> = {
	bash: "Ran",
	powershell: "Ran",
	read: "Read",
	edit: "Edited",
	write: "Edited",
	ls: "Listed",
	find: "Searched",
	grep: "Searched",
};

/** shell 工具调用行开头的提示符 */
const SHELL_PROMPT = /^[$%❯>]\s+/;

/** 执行中的 spinner 帧与刷新间隔 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

/** pi 传给工具渲染器的上下文，state 由工具自己使用 */
type RenderContext = NonNullable<Parameters<NonNullable<ToolRenderers["renderCall"]>>[2]>;

/** 工具结果里的内容片段，只关心文本部分 */
type ToolContent = ReadonlyArray<{ type: string; text?: string }>;

/** 一个工具行由本扩展维护的渲染状态 */
interface CallRenderState {
	/** 调用行组件 */
	callLine?: CallLine;
	/** 交给工具自己的渲染器复用的调用行组件 */
	innerCall?: Component;
	/** 交给工具自己的渲染器复用的结果组件 */
	innerResult?: Component;
	/** 工具自己的渲染器使用的状态，与调用行分开 */
	inner?: Record<string, unknown>;
}

/** 本扩展的渲染上下文，state 换成自己的类型 */
type CallContext = Omit<RenderContext, "state"> & { state: CallRenderState };

/** 在执行中的工具，按渲染状态登记重绘回调，spinner 才会转动 */
const spinnerTargets = new Map<CallRenderState, () => void>();
let spinnerTimer: ReturnType<typeof setInterval> | undefined;

function trackSpinner(context: CallContext): void {
	if (!context.isPartial) {
		if (spinnerTargets.delete(context.state) && spinnerTargets.size === 0 && spinnerTimer !== undefined) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
		return;
	}
	spinnerTargets.set(context.state, context.invalidate);
	if (spinnerTimer === undefined) {
		spinnerTimer = setInterval(() => {
			for (const invalidate of spinnerTargets.values()) {
				invalidate();
			}
		}, SPINNER_INTERVAL_MS);
	}
}

/** 停止全部 spinner 重绘，会话开始与结束时清掉遗留的定时器 */
function clearSpinnerTargets(): void {
	spinnerTargets.clear();
	if (spinnerTimer !== undefined) {
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	}
}

/** 只有空白的行，包括渲染器补齐到整行的空白行 */
function isBlank(line: string | undefined): boolean {
	return line === undefined || stripTerminalSequences(line).trim() === "";
}

/** 去掉正文首尾的空行，`└` 要贴在真正的内容上 */
function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlank(lines[start])) {
		start++;
	}
	while (end > start && isBlank(lines[end - 1])) {
		end--;
	}
	return lines.slice(start, end);
}

/** 文字里的非空行数，只有颜色的行不算内容 */
function nonEmptyLineCount(lines: string[]): number {
	return lines.filter((line) => !isBlank(line)).length;
}

/** 调用行左侧的状态图标：执行中为 spinner，完成时为圆点，失败时为红色叉 */
function statusIcon(context: CallContext, theme: Theme): string {
	if (context.isPartial) {
		const frame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!;
		return theme.fg(STATUS_COLOR, frame);
	}
	return context.isError ? theme.fg("error", "✗") : theme.fg(STATUS_COLOR, "•");
}

/** 折叠时看不到的行数提示 */
function hiddenHint(hidden: number, theme: Theme): string {
	const count = theme.fg("dim", `+ ${hidden} line${hidden === 1 ? "" : "s"} `);
	return count + theme.fg("dim", "(") + keyHint("app.tools.expand", "to expand") + theme.fg("dim", ")");
}

/** 正文超出上限时的提示行 */
function overflowHint(rest: number, action: string, theme: Theme): string {
	return `${theme.fg("muted", `... (${rest} more line${rest === 1 ? "" : "s"}, `)}${keyHint("app.tools.expand", action)}${theme.fg("muted", ")")}`;
}

/** 正文行数上限：首行是渲染器加的空白分隔行，不占额度 */
function limitBody(component: Component, theme: Theme): Component {
	return {
		render: (width: number) => {
			const lines = component.render(width);
			const capacity = MAX_EXPANDED_LINES + (isBlank(lines[0]) ? 1 : 0);
			if (lines.length <= capacity) {
				return lines;
			}
			const rest = lines.length - capacity;
			return [...lines.slice(0, capacity), truncateToWidth(overflowHint(rest, "to collapse", theme), width, "...")];
		},
		invalidate: () => component.invalidate?.(),
	};
}

/**
 * 收集组件里的文字行。容器自带的背景色与内边距不参与，由调用行统一绘制。
 * 无法取出文字的组件交给调用行自己渲染。
 */
function componentLines(component: Component | undefined): string[] {
	if (component === undefined) {
		return [];
	}
	const text = (component as { text?: unknown }).text;
	if (typeof text === "string") {
		return text.split("\n");
	}
	if (component instanceof Spacer) {
		return [""];
	}
	const children = (component as { children?: unknown }).children;
	if (!Array.isArray(children)) {
		return [];
	}
	return children.flatMap((child) => componentLines(child as Component));
}

/** 第 capacity 个之后的第一个非空行的位置，空行不占额度 */
function capIndex(lines: string[], capacity: number): number {
	let count = 0;
	for (let index = 0; index < lines.length; index++) {
		if (!isBlank(lines[index])) {
			count++;
			if (count > capacity) {
				return index;
			}
		}
	}
	return lines.length;
}

/** 折叠时只取标题的第一行，多行标题补上省略号，表示后面还有内容 */
function withMoreMarker(raw: string): string {
	const firstLine = raw.split("\n")[0]!.replace(/ +$/, "");
	return raw.includes("\n") ? `${firstLine} ...` : firstLine;
}

/** 调用行组件：状态图标 + 标题，折叠时只占一行，展开时按宽度折行 */
class CallLine implements Component {
	private text?: string;
	private inner?: Component;
	private trailer = "";
	private icon = "";
	private expanded = false;

	setText(text: string | undefined): void {
		this.text = text;
	}

	setInner(inner: Component): void {
		this.inner = inner;
	}

	setTrailer(trailer: string): void {
		this.trailer = trailer;
	}

	setIcon(icon: string): void {
		this.icon = icon;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	render(width: number): string[] {
		const raw = this.text ?? (this.inner ? (this.inner.render(width)[0] ?? "") : "");
		const prefix = `${CARD_INDENT}${this.icon} `;
		const prefixWidth = visibleWidth(prefix);
		const contentWidth = Math.max(1, width - prefixWidth);
		if (!this.expanded) {
			return [prefix + truncateToWidth(withMoreMarker(raw), contentWidth, "...")];
		}
		const indent = " ".repeat(prefixWidth);
		const rendered = wrapTextWithAnsi(raw, contentWidth).map((line, index) =>
			((index === 0 ? prefix : indent) + line).replace(/ +$/, ""),
		);
		if (this.trailer) {
			rendered.push(truncateToWidth(this.trailer, width, "..."));
		}
		return rendered;
	}

	invalidate(): void {
		this.inner?.invalidate();
	}
}

/** 结果渲染要改写的调用行组件 */
function callLineOf(context: CallContext): CallLine {
	const existing = context.state.callLine;
	if (existing !== undefined) {
		return existing;
	}
	const created = new CallLine();
	context.state.callLine = created;
	return created;
}

/** 图标、展开状态与重绘登记，调用行的每次渲染都要刷新 */
function applyCallState(line: CallLine, context: CallContext, theme: Theme): void {
	line.setIcon(statusIcon(context, theme));
	line.setExpanded(Boolean(context.expanded));
	trackSpinner(context);
}

/** 工具自己的渲染器使用的状态对象，首次取用时创建 */
function innerStateOf(state: CallRenderState): Record<string, unknown> {
	state.inner ??= {};
	return state.inner;
}

/** 交给工具自己的渲染器使用的上下文：展开状态与计时由调用行统一处理 */
function innerContext(context: CallContext, lastComponent: Component | undefined): RenderContext {
	return {
		...context,
		state: innerStateOf(context.state),
		lastComponent,
		// 折叠与展开由本扩展决定，工具总是按展开态绘制完整内容
		expanded: true,
		// 结果已经由本扩展按最终态呈现，工具不必再区分流式阶段
		isPartial: false,
		// 耗时不再进入调用行，工具也不必写入耗时行
		durationMs: undefined,
	};
}

/** 工具自己的渲染器会写入起始时刻以便绘制耗时行，这里清掉，避免正文多出一行耗时 */
function clearInnerTimer(context: CallContext): void {
	const state = innerStateOf(context.state) as { startedAt?: number; endedAt?: number };
	state.startedAt = undefined;
	state.endedAt = undefined;
}

/** 命令输出的解析结果，按 content 数组缓存：spinner 每次重绘拿到的都是同一份内容 */
const outputCache = new WeakMap<ToolContent, string>();

/** 取出结果里的文本内容，去掉终端控制序列与回车符 */
function extractOutput(content: ToolContent): string {
	const cached = outputCache.get(content);
	if (cached !== undefined) {
		return cached;
	}
	const output = content
		.filter((part) => part.type === "text")
		.map((part) => stripTerminalSequences(part.text ?? "").replace(/\r/g, ""))
		.join("\n")
		.trim();
	outputCache.set(content, output);
	return output;
}

/** 没有自带渲染器的工具使用的调用行：工具名加参数预览 */
function genericCallText(toolName: string, args: unknown): string {
	if (args == null) {
		return toolName;
	}
	const entries = typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [["args", args]];
	if (entries.length === 0) {
		return toolName;
	}
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
	return `${toolName} ${preview}`;
}

/** 没有自带结果渲染器的工具：结果文本按正文样式展示 */
function genericResult(result: AgentToolResult<unknown>, theme: Theme, color: ThemeColor): Component {
	const text = extractOutput(result.content);
	return text ? new Text(`\n${theme.fg(color, text)}`, 0, 0) : new Container();
}

/** 调用行只展示主要参数，超时这类执行细节不进入调用行 */
function callArgs(args: unknown): unknown {
	if (args === null || typeof args !== "object" || Array.isArray(args)) {
		return args;
	}
	const copy = { ...(args as Record<string, unknown>) };
	delete copy.timeout;
	return copy;
}

/** 工具名对应的动词 */
function displayLabel(toolName: string): string {
	return TOOL_LABELS[toolName] ?? toolName;
}

/**
 * 去掉工具自己写的标题前缀，只留参数部分。shell 的标题以 `$` 开头，其他工具以工具名开头，
 * 都不属于参数，统一换成 codex 的动词作为标题。
 */
function callBody(toolName: string, plain: string): string {
	if (plain === toolName) {
		return "";
	}
	if (plain.startsWith(`${toolName} `)) {
		return plain.slice(toolName.length).trimStart();
	}
	return plain.replace(SHELL_PROMPT, "");
}

/**
 * 调用行的标题：`Ran <命令>` 这类动词加参数，工具名开头的标题换成动词，
 * 其余文字用正文颜色重画，同一条命令不会出现两种颜色。
 */
function callTitle(toolName: string, lines: string[], theme: Theme): string[] {
	const label = theme.fg(LABEL_COLOR, displayLabel(toolName));
	const first = lines.findIndex((line) => !isBlank(line));
	if (first === -1) {
		return [label];
	}
	const plain = stripTerminalSequences(lines[first]!).trimStart();
	const body = callBody(toolName, plain);
	// 标题之后的文字可能是 diff 或命令的续行，保留工具自己的配色
	const rewritten = lines.map((line, index) => (index === first || !isBlank(line) ? line : ""));
	rewritten[first] = body ? `${label} ${theme.fg("text", body)}` : label;
	return rewritten;
}

/**
 * 结果正文：折叠时只取前几行，展开时全部展示。
 * `└` 贴在第一条正文行，续行缩进到正文起始列。
 */
class BranchBody implements Component {
	constructor(
		private readonly inner: Component,
		private readonly expanded: boolean,
	) {}

	render(width: number): string[] {
		const theme = currentTheme();
		const contentWidth = Math.max(1, width - BRANCH_TAIL.length);
		const source = this.expanded ? limitBody(this.inner, theme) : this.inner;
		const lines = trimBlankEdges(source.render(contentWidth));
		if (lines.length === 0) {
			return [];
		}
		const lead = theme.fg("dim", BRANCH_LEAD);
		const tail = theme.fg("dim", BRANCH_TAIL);
		if (this.expanded) {
			return lines.map((line, index) => (index === 0 ? lead : tail) + line);
		}
		const shown = lines.slice(0, PREVIEW_LINES);
		const hidden = nonEmptyLineCount(lines.slice(PREVIEW_LINES));
		const rendered = shown.map((line, index) => (index === 0 ? lead : tail) + theme.fg("muted", line));
		if (hidden > 0) {
			rendered.push(tail + hiddenHint(hidden, theme));
		}
		return rendered;
	}

	invalidate(): void {
		this.inner.invalidate?.();
	}
}

/** 所有工具共用的渲染方式 */
function createUniformRenderers(toolName: string, base: ToolRenderers | undefined): ToolRenderers {
	return {
		renderShell: "self",

		renderCall(args, theme, context: CallContext) {
			const inner = base?.renderCall
				? base.renderCall(callArgs(args), theme, innerContext(context, context.state.innerCall))
				: new Text(genericCallText(toolName, args), 0, 0);
			context.state.innerCall = inner;
			clearInnerTimer(context);

			const lines = callTitle(toolName, componentLines(inner), theme);
			const capacity = MAX_EXPANDED_LINES + CALL_HEADER_LINES;
			const shown = lines.slice(0, capIndex(lines, capacity));
			const hiddenLines = nonEmptyLineCount(lines) - capacity;

			const line = callLineOf(context);
			line.setInner(inner);
			line.setText(shown.length > 0 ? shown.join("\n") : undefined);
			line.setTrailer(hiddenLines > 0 ? overflowHint(hiddenLines, "to collapse", theme) : "");
			applyCallState(line, context, theme);
			return line;
		},

		renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: CallContext) {
			const inner = base?.renderResult
				? base.renderResult(result, { expanded: true, isPartial: false }, theme, innerContext(context, context.state.innerResult))
				: genericResult(result, theme, context.isError ? "error" : "toolOutput");
			context.state.innerResult = inner;
			clearInnerTimer(context);
			return new BranchBody(inner, options.expanded);
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		clearSpinnerTargets();
	});
	pi.on("session_shutdown", () => {
		clearSpinnerTargets();
	});

	pi.registerToolRenderer((toolName, next) => createUniformRenderers(toolName, next()));
}
