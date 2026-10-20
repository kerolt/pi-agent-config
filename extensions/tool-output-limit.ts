/**
 * 统一工具调用行在终端 transcript 中的展示方式。
 *
 * 所有工具都走同一条渲染路径：工具自身提供的调用行文字与正文被取出来，重新画成
 * 一行调用行（状态图标 + 工具标题）加一块展开后的正文面板，不再按工具名分支。
 * 调用行文字以工具名开头时保留它自己的配色，否则换成工具名加 muted 的参数文字；
 * 超时这类执行细节不进入调用行。
 * 折叠时整张卡只有一行：调用行末尾接上耗时、被隐藏的行数与展开提示。
 * 展开后工具的描述文字与正文各最多展示 100 行，超出部分换成一行提示。
 * 展开与折叠都可以按 ctrl+o 或点击该行触发。
 *
 * 工具自己绘制的外框、内边距与耗时行在这里被丢掉，由统一的外壳重新绘制。
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

/** 展开时正文与调用行文字各自展示的最大行数 */
const MAX_EXPANDED_LINES = 100;

/** 调用行文字里第 1 行是工具自己的标题，标题之后的文字同样按上面的上限截断 */
const CALL_HEADER_LINES = 1;

/** 调用行参数预览的最大字符数 */
const COLLAPSED_ARGS_CHARS = 100;

/** 工具名用主题的强调色，参数与耗时等附注统一用 muted，与正文的强调部分分开 */
const TOOL_NAME_COLOR = "accent";
const TOOL_ARG_COLOR = "muted";

/** 把工具自己的渲染器用到的主题色换成调用行的配色：名字 accent、参数 muted。只影响颜色字符串 */
function toolCallTheme(theme: Theme): Theme {
	return new Proxy(theme, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (property !== "fg" || typeof value !== "function") {
				return value;
			}
			return (color: ThemeColor, text: string) =>
				target.fg(color === "toolTitle" ? TOOL_NAME_COLOR : color === "accent" ? TOOL_ARG_COLOR : color, text);
		},
	});
}

/** 工具内容相对左边界缩进的列数 */
const INDENT = 1;
const INDENT_TEXT = " ".repeat(INDENT);

/** 执行中的 spinner 帧与刷新间隔 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

/** pi 传给工具渲染器的上下文，state 由工具自己使用 */
type RenderContext = NonNullable<Parameters<NonNullable<ToolRenderers["renderCall"]>>[2]>;

/** 工具结果里的内容片段，只关心文本部分 */
type ToolContent = ReadonlyArray<{ type: string; text?: string }>;

/** 一个工具行由本扩展维护的渲染状态 */
interface CallRenderState {
	/** 开始执行的时刻，执行中用它与结束时刻算出已耗时 */
	startedAt?: number;
	/** 结束执行的时刻 */
	endedAt?: number;
	/** 结果渲染时改写附注的调用行组件 */
	callLine?: CallLine;
	/** 调用行文字的非空行数，折叠时用来数被隐藏的行 */
	callLineCount?: number;
	/** 交给工具自己的渲染器复用的调用行组件 */
	innerCall?: Component;
	/** 交给工具自己的渲染器复用的结果组件 */
	innerResult?: Component;
	/** 工具自己的渲染器使用的状态，与调用行的计时分开 */
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

/** 调用行左侧的状态图标：执行中为 spinner，完成时与工具名同色，失败时为红色叉 */
function statusIcon(context: CallContext, theme: Theme): string {
	if (context.isPartial) {
		const frame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
		return theme.fg(TOOL_NAME_COLOR, frame);
	}
	return context.isError ? theme.fg("error", "✗") : theme.fg(TOOL_NAME_COLOR, "✓");
}

/** 在内容左侧补上进缩进列 */
function inset(component: Component): Component {
	return {
		render: (width: number) =>
			component.render(Math.max(1, width - INDENT)).map((line) => INDENT_TEXT + line),
		invalidate: () => component.invalidate?.(),
	};
}

/**
 * 展开后的正文区：整行铺满 userMessageBg，与 transcript 的其他部分区分开。
 * 高亮与 diff 行自带的 SGR 复位会把背景色清掉，所以每遇到复位就重新打开背景色。
 */
function panel(component: Component, theme: Theme): Component {
	return {
		render: (width: number) => {
			const bgOpen = theme.getBgAnsi("userMessageBg");
			return component.render(Math.max(1, width - INDENT)).map((line) => {
				const painted = INDENT_TEXT + line.split("\x1b[0m").join(`\x1b[0m${bgOpen}`);
				const padding = " ".repeat(Math.max(0, width - visibleWidth(painted)));
				return `${bgOpen}${painted}${padding}\x1b[49m`;
			});
		},
		invalidate: () => component.invalidate?.(),
	};
}

/** 结果包装：展开时铺背景面板，其余只做缩进 */
function wrapResult(component: Component, theme: Theme, expanded: boolean): Component {
	return expanded ? panel(component, theme) : inset(component);
}

/** 只有空白的行，包括渲染器补齐到整行的空白行 */
function isBlank(line: string | undefined): boolean {
	return line === undefined || stripTerminalSequences(line).trim() === "";
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

/** 超出上限时的提示行，附注里带上展开或折叠的快捷键 */
function overflowHint(rest: number, action: string, theme: Theme): string {
	return `${theme.fg("muted", `... (${rest} more line${rest === 1 ? "" : "s"}, `)}${keyHint("app.tools.expand", action)}${theme.fg("muted", ")")}`;
}

/** 文字里的非空行数，只有颜色的行不算内容 */
function nonEmptyLineCount(lines: string[]): number {
	return lines.filter((line) => stripTerminalSequences(line).trim() !== "").length;
}

function lineLabel(count: number): string {
	return `${count} line${count === 1 ? "" : "s"}`;
}

function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) {
		return `${seconds.toFixed(1)}s`;
	}
	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) {
		return `${minutes}m ${remainder}s`;
	}
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** 调用行尾部的附注，不含前面的省略号分隔符 */
function formatSuffix(parts: string[], withExpandKey: boolean, theme: Theme): string {
	if (parts.length === 0) {
		return "";
	}
	const body = parts.join(", ");
	if (!withExpandKey) {
		return theme.fg("muted", `(${body})`);
	}
	return `${theme.fg("muted", `(${body}, `)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

/**
 * 把调用行文字与附注合成一行：附注优先保留，文字过长时截断。
 * 文字已经以省略号结尾时不再重复加分隔的省略号。
 */
function composeCallLine(text: string, suffix: string, width: number): string {
	const separator = " ... ";
	if (!suffix) {
		return truncateToWidth(text, width, "...");
	}
	const suffixWidth = visibleWidth(suffix);
	if (width <= suffixWidth + separator.length) {
		return truncateToWidth(suffix, width, "...");
	}
	const textWidth = Math.max(1, width - suffixWidth - visibleWidth(separator));
	const truncated = truncateToWidth(text, textWidth, "...");
	const ended = stripTerminalSequences(truncated).trimEnd().endsWith("...");
	return truncated + (ended ? " " : separator) + suffix;
}

/** 折叠时只取标题的第一行，多行标题补上省略号，表示后面还有内容 */
function withMoreMarker(raw: string): string {
	const firstLine = raw.split("\n")[0].replace(/ +$/, "");
	return raw.includes("\n") ? `${firstLine} ...` : firstLine;
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

/**
 * 调用行组件：状态图标 + 工具标题，折叠时只占一行，附注接在末尾，超出宽度截断。
 * 展开时标题按宽度折行，完整展示命令与工具自己的预览。
 */
class CallLine implements Component {
	private text?: string;
	private inner?: Component;
	private suffix = "";
	private trailer = "";
	private icon = "";
	private expanded = false;

	setText(text: string | undefined): void {
		this.text = text;
	}

	setInner(inner: Component): void {
		this.inner = inner;
	}

	setSuffix(suffix: string): void {
		this.suffix = suffix;
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
		const prefix = this.icon ? `${this.icon} ` : "";
		const prefixWidth = visibleWidth(prefix);
		const contentWidth = Math.max(1, width - prefixWidth);
		if (!this.expanded) {
			return [prefix + composeCallLine(withMoreMarker(raw), this.suffix, contentWidth)];
		}
		const indent = " ".repeat(prefixWidth);
		const rendered = wrapTextWithAnsi(raw, contentWidth).map((line, index) =>
			((index === 0 ? prefix : indent) + line).replace(/ +$/, ""),
		);
		if (this.suffix) {
			const last = rendered[rendered.length - 1] ?? prefix;
			if (visibleWidth(last) + visibleWidth(this.suffix) + 1 <= width) {
				rendered[rendered.length - 1] = `${last} ${this.suffix}`;
			} else {
				rendered.push(truncateToWidth(this.suffix, width, "..."));
			}
		}
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

function setCallSuffix(context: CallContext, suffix: string): void {
	context.state.callLine?.setSuffix(suffix);
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
		// 耗时由调用行展示，工具不再重复写入耗时行
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

/** 折叠时看不到的行数：调用行文字里被折掉的部分加整段正文 */
function hiddenLineCount(context: CallContext, body: Component): number {
	const callLines = context.state.callLineCount ?? 1;
	return Math.max(0, callLines - 1) + nonEmptyLineCount(componentLines(body));
}

/** 调用行的耗时文字，执行中用 Elapsed，结束后用 Took */
function durationText(context: CallContext): string | undefined {
	const state = context.state;
	let durationMs = context.durationMs;
	if (durationMs === undefined && state.startedAt !== undefined) {
		durationMs = (state.endedAt ?? Date.now()) - state.startedAt;
	}
	if (durationMs === undefined) {
		return undefined;
	}
	return `${context.isPartial ? "Elapsed" : "Took"} ${formatDuration(durationMs)}`;
}

/** 没有自带渲染器的工具使用的调用行：工具名加参数预览 */
function genericCallText(toolName: string, args: unknown, theme: Theme): string {
	const header = theme.fg(TOOL_NAME_COLOR, theme.bold(toolName));
	if (args == null) {
		return header;
	}
	const entries = typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [["args", args]];
	if (entries.length === 0) {
		return header;
	}
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
	return `${header} ${theme.fg(TOOL_ARG_COLOR, preview)}`;
}

/** 没有自带结果渲染器的工具：结果文本按正文样式展示 */
function genericResult(result: AgentToolResult<unknown>, theme: Theme, color: ThemeColor): Component {
	const text = extractOutput(result.content);
	return text ? new Text(`\n${theme.fg(color, text)}`, 0, 0) : new Container();
}

/** 第 capacity 个之后的非空行的位置，空行不占额度 */
function capIndex(lines: string[], capacity: number): number {
	let count = 0;
	for (let index = 0; index < lines.length; index++) {
		if (stripTerminalSequences(lines[index] ?? "").trim() !== "") {
			count++;
			if (count > capacity) {
				return index;
			}
		}
	}
	return lines.length;
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

/**
 * 调用行的标题：工具自己的文字以工具名开头时保留它的配色，否则（例如 shell 的提示符）
 * 改用工具名当标题，其余文字用 muted 重画，同一条命令不会出现两种颜色。
 */
function callTitle(toolName: string, lines: string[], theme: Theme): string[] {
	const header = theme.fg(TOOL_NAME_COLOR, theme.bold(toolName));
	const first = lines.findIndex((line) => !isBlank(line));
	if (first === -1) {
		return [header];
	}
	const plain = stripTerminalSequences(lines[first] ?? "").trimStart();
	const [, head, rest] = plain.match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [plain, plain, ""];
	if (head === toolName) {
		return lines;
	}
	const rewritten = lines.map((line) => (isBlank(line) ? "" : theme.fg(TOOL_ARG_COLOR, stripTerminalSequences(line))));
	rewritten[first] = rest ? `${header} ${theme.fg(TOOL_ARG_COLOR, rest)}` : header;
	return rewritten;
}

/** 所有工具共用的渲染方式 */
function createUniformRenderers(toolName: string, base: ToolRenderers | undefined): ToolRenderers {
	return {
		renderShell: "self",

		renderCall(args, theme, context: CallContext) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}

			const inner = base?.renderCall
				? base.renderCall(callArgs(args), toolCallTheme(theme), innerContext(context, state.innerCall))
				: new Text(genericCallText(toolName, args, theme), 0, 0);
			state.innerCall = inner;
			clearInnerTimer(context);

			const lines = callTitle(toolName, componentLines(inner), theme);
			const callLineCount = nonEmptyLineCount(lines);
			const capacity = MAX_EXPANDED_LINES + CALL_HEADER_LINES;
			const shown = lines.slice(0, capIndex(lines, capacity));
			const rest = callLineCount - Math.min(callLineCount, capacity);
			state.callLineCount = callLineCount;
			const line = callLineOf(context);
			line.setInner(inner);
			line.setText(shown.length > 0 ? shown.join("\n") : undefined);
			line.setTrailer(rest > 0 ? overflowHint(rest, "to collapse", theme) : "");
			line.setSuffix("");
			applyCallState(line, context, theme);
			return wrapResult(line, theme, context.expanded);
		},

		renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: CallContext) {
			const state = context.state;
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
			}

			const inner = base?.renderResult
				? base.renderResult(result, { expanded: true, isPartial: false }, theme, innerContext(context, state.innerResult))
				: genericResult(result, theme, context.isError ? "error" : "toolOutput");
			state.innerResult = inner;
			clearInnerTimer(context);

			const hidden = hiddenLineCount(context, inner);
			const parts: string[] = [];
			const duration = durationText(context);
			if (duration !== undefined) {
				parts.push(duration);
			}
			if (!options.expanded && hidden > 0) {
				parts.push(lineLabel(hidden));
			}
			setCallSuffix(context, formatSuffix(parts, !options.expanded && hidden > 0, theme));

			if (!options.expanded) {
				return new Container();
			}
			return panel(limitBody(inner, theme), theme);
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
