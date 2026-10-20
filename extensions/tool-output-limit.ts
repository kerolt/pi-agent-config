/**
 * 限制工具输出在终端 transcript 中展示的行数。
 *
 * 工具调用自身使用 renderShell: "self"，不再走 pi 默认的带背景色和上下留白的框，
 * 折叠时整张卡只有一行：调用行末尾接上被隐藏的行数与展开提示。
 * 调用行始终只占一行，命令换行或过长时用省略号截断。
 * 展开后结果最多展示 100 行（edit 的 diff 与 write 的内容各自使用同样的上限）。
 * 展开与折叠都可以按 ctrl+o 或点击该行触发。
 *
 * 自带渲染器的扩展工具（例如 subagent 的运行进度）保留自己的展示方式。
 */

import type { Component } from "@earendil-works/pi-tui";
import type {
	AgentToolResult,
	BashToolDetails,
	EditToolDetails,
	ExtensionAPI,
	Theme,
	ThemeColor,
	ToolRenderers,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	getLanguageFromPath,
	highlightCode,
	keyHint,
	keyText,
	renderDiff,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Text,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** 展开状态下结果展示的最大行数，内置工具的结果、edit 的 diff 与 write 的内容共用这个上限 */
const MAX_EXPANDED_LINES = 100;

/** 调用行参数预览的最大字符数 */
const COLLAPSED_ARGS_CHARS = 100;

/** 工具名用主题的强调色，参数与耗时等附注统一用 muted，与正文的强调部分分开 */
const TOOL_NAME_COLOR = "accent";
const TOOL_ARG_COLOR = "muted";

/** 把内置渲染器用到的主题色换成工具调用的配色：名字 accent、参数 muted。只影响颜色字符串 */
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

/** pi 在同一个工具调用的所有渲染之间共享的渲染状态 */
interface CallRenderState {
	/** 开始执行的时刻，执行中用它与结束时刻算出已耗时 */
	startedAt?: number;
	/** 结束执行的时刻 */
	endedAt?: number;
	/** 调用行组件，结果渲染时改写它的附注 */
	callLine?: CallLine;
	/** 内置渲染器返回的调用行组件，借用它的文字 */
	innerCall?: Component;
	/** 内置渲染器返回的结果组件，借用它的渲染 */
	innerResult?: Component;
}

/** pi 传给渲染器的上下文，state 换成我们自己的类型 */
type CallContext = Omit<NonNullable<Parameters<NonNullable<ToolRenderers["renderCall"]>>[2]>, "state"> & {
	state: CallRenderState;
};

/** 工具结果里的内容片段，只关心文本部分 */
type ToolContent = ReadonlyArray<{ type: string; text?: string }>;

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

/** 结果正文：按展开状态包上背景面板或缩进 */
function resultBody(text: string, theme: Theme, expanded: boolean): Component {
	return wrapResult(new Text(text, 0, 0), theme, expanded);
}

/** 需要折叠结果的内置工具 */
const FOLDED_BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** 从工具参数里取字符串字段，参数缺失或类型不对时按不存在处理 */
function readString(args: unknown, field: string): string | undefined {
	if (args === null || typeof args !== "object") {
		return undefined;
	}
	const value = (args as Record<string, unknown>)[field];
	return typeof value === "string" ? value : undefined;
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
 * 调用行组件：状态图标 + 工具标题，折叠时只占一行，附注接在末尾，超出宽度截断。
 * 展开时标题按宽度折行，完整展示命令本身。
 * 标题可以来自内置渲染器返回的原始文本，也可以由组件自己提供。
 */
class CallLine implements Component {
	private text?: string;
	private inner?: Component;
	private suffix = "";
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

	setIcon(icon: string): void {
		this.icon = icon;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	/** 调用行文字里是否已经包含这段内容，用来判断内置渲染器是否自带展开提示 */
	hasText(part: string): boolean {
		return part.length > 0 && (this.text ?? "").includes(part);
	}

	render(width: number): string[] {
		const raw = this.text ?? (this.inner ? (this.inner.render(width)[0] ?? "") : "");
		const prefix = this.icon ? `${this.icon} ` : "";
		const prefixWidth = visibleWidth(prefix);
		const contentWidth = Math.max(1, width - prefixWidth);
		if (!this.expanded) {
			return [prefix + composeCallLine(withMoreMarker(raw), this.suffix, contentWidth)];
		}
		return this.renderExpanded(raw, prefix, prefixWidth, contentWidth, width);
	}

	/** 展开时把标题完整折行，附注在末行放得下就接在末行，否则另起一行 */
	private renderExpanded(raw: string, prefix: string, prefixWidth: number, contentWidth: number, width: number): string[] {
		const indent = " ".repeat(prefixWidth);
		const trailingTrimmed = wrapTextWithAnsi(raw, contentWidth).map((line) => line.replace(/ +$/, ""));
		const rendered = trailingTrimmed.map((line, index) => (index === 0 ? prefix : indent) + line);
		if (!this.suffix) {
			return rendered;
		}
		const lastIndex = rendered.length - 1;
		const last = rendered[lastIndex] ?? prefix;
		if (visibleWidth(last) + visibleWidth(this.suffix) + 1 <= width) {
			rendered[lastIndex] = `${last} ${this.suffix}`;
			return rendered;
		}
		return [...rendered, this.suffix];
	}

	invalidate(): void {
		this.inner?.invalidate();
	}
}

/** 取出内置渲染器写进调用行组件的文字；pi-tui 的 Text 把文本存在实例字段上 */
function componentText(component: Component | undefined): string | undefined {
	const text = (component as { text?: unknown } | undefined)?.text;
	return typeof text === "string" ? text : undefined;
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

/** 记录标题与附注，并把组件存入 state 供结果渲染改写 */
function updateCallHeader(context: CallContext, theme: Theme, headerText: string, suffix = ""): Component {
	const line = callLineOf(context);
	line.setText(headerText);
	line.setSuffix(suffix);
	applyCallState(line, context, theme);
	return wrapResult(line, theme, context.expanded);
}

function setCallSuffix(context: CallContext, suffix: string): void {
	context.state.callLine?.setSuffix(suffix);
}

/** 命令输出的解析结果，按 content 数组缓存：spinner 每次重绘拿到的都是同一份内容 */
const outputCache = new WeakMap<ToolContent, string>();

/** 取出命令输出文本，去掉终端控制序列与回车符 */
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

/** 去掉末尾空行后的内容行 */
function contentLines(content: string): string[] {
	const lines = content.replace(/\r/g, "").split("\n");
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

/** diff 的行与加减统计，按 details 对象缓存 */
const diffCache = new WeakMap<EditToolDetails, { lines: string[]; stats: string }>();

function diffSummary(details: EditToolDetails): { lines: string[]; stats: string } {
	const cached = diffCache.get(details);
	if (cached !== undefined) {
		return cached;
	}
	const lines = details.diff.split("\n");
	let additions = 0;
	let removals = 0;
	for (const line of lines) {
		if (line.startsWith("+") && !line.startsWith("+++")) {
			additions++;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			removals++;
		}
	}
	const summary = { lines, stats: `+${additions} / -${removals}` };
	diffCache.set(details, summary);
	return summary;
}

/** write 正文的高亮结果，按参数对象缓存；流式写入时参数会变，取用前比对原文 */
const writeBodyCache = new WeakMap<object, { source: string; rendered: string[]; total: number }>();

function writeBody(cacheKey: object | undefined, content: string, path: string, theme: Theme): { rendered: string[]; total: number } {
	const cached = cacheKey === undefined ? undefined : writeBodyCache.get(cacheKey);
	if (cached !== undefined && cached.source === content) {
		return cached;
	}
	const lines = contentLines(content);
	const shown = lines.slice(0, MAX_EXPANDED_LINES);
	const lang = path ? getLanguageFromPath(path) : undefined;
	const highlighted = lang ? highlightCode(shown.join("\n").replace(/\t/g, "   "), lang) : undefined;
	const rendered = shown.map((line, index) => highlighted?.[index] ?? theme.fg("toolOutput", line.replace(/\t/g, "   ")));
	const body = { source: content, rendered, total: lines.length };
	if (cacheKey !== undefined) {
		writeBodyCache.set(cacheKey, body);
	}
	return body;
}

function createShellRenderers(toolName: string): ToolRenderers {
	return {
		renderShell: "self",

		renderCall(args, theme, context: CallContext) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const rawCommand = readString(args, "command") ?? "";
			// 完整命令交给调用行处理：折叠时取第一行，展开时按宽度折行
			const header = `${theme.fg(TOOL_NAME_COLOR, theme.bold(toolName))} ${theme.fg(TOOL_ARG_COLOR, rawCommand)}`;
			return updateCallHeader(context, theme, header);
		},

		renderResult(result: AgentToolResult<BashToolDetails>, options: ToolRenderResultOptions, theme: Theme, context: CallContext) {
			const state = context.state;
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
			}

			let output = extractOutput(result.content);
			const truncation = result.details?.truncation;
			const fullOutputPath = result.details?.fullOutputPath;

			// 截断说明由下方单独展示，避免在输出里重复出现
			if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
				const footerStart = output.lastIndexOf("\n\n[");
				if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
					output = output.slice(0, footerStart).trimEnd();
				}
			}

			const outputLines = output ? output.split("\n") : [];
			let durationMs = context.durationMs;
			if (durationMs === undefined && state.startedAt !== undefined) {
				durationMs = (state.endedAt ?? Date.now()) - state.startedAt;
			}

			const parts: string[] = [];
			if (durationMs !== undefined) {
				parts.push(`${options.isPartial ? "Elapsed" : "Took"} ${formatDuration(durationMs)}`);
			}
			if (!options.expanded && outputLines.length > 0) {
				parts.push(lineLabel(outputLines.length));
			}
			setCallSuffix(context, formatSuffix(parts, !options.expanded && outputLines.length > 0, theme));

			const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
			component.clear();

			if (options.expanded && outputLines.length > 0) {
				const styled = outputLines.map((line) => theme.fg("toolOutput", line)).join("\n");
				component.addChild(panel(new Text(`\n${styled}`, 0, 0), theme));
			}

			if (truncation?.truncated || fullOutputPath) {
				const warnings: string[] = [];
				if (fullOutputPath) {
					warnings.push(`Full output: ${fullOutputPath}`);
				}
				if (truncation?.truncated) {
					if (truncation.truncatedBy === "lines") {
						warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
					} else {
						warnings.push(
							`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
						);
					}
				}
				component.addChild(resultBody(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, theme, options.expanded));
			}

			return component;
		},
	};
}

const editRenderers: ToolRenderers = {
	renderShell: "self",

	renderCall(args, theme, context: CallContext) {
		const path = readString(args, "path") ?? "";
		return updateCallHeader(context, theme, `${theme.fg(TOOL_NAME_COLOR, theme.bold("edit"))} ${theme.fg(TOOL_ARG_COLOR, path)}`);
	},

	renderResult(result: AgentToolResult<EditToolDetails>, options: ToolRenderResultOptions, theme: Theme, context: CallContext) {
		const textPart = result.content.find((part) => part.type === "text");
		const text = textPart && textPart.type === "text" ? textPart.text : "";

		if (context.isError) {
			setCallSuffix(context, "");
			return resultBody(theme.fg("error", text), theme, options.expanded);
		}

		if (!result.details?.diff) {
			setCallSuffix(context, "");
			return resultBody(theme.fg("toolOutput", text), theme, options.expanded);
		}

		const { lines, stats } = diffSummary(result.details);

		if (!options.expanded) {
			setCallSuffix(context, formatSuffix([stats], true, theme));
			return new Container();
		}

		setCallSuffix(context, formatSuffix([stats], false, theme));
		const shown = lines.slice(0, MAX_EXPANDED_LINES);
		let body = renderDiff(shown.join("\n"));
		if (lines.length > MAX_EXPANDED_LINES) {
			const rest = lines.length - MAX_EXPANDED_LINES;
			body += `\n${theme.fg("muted", `... (${rest} more diff lines, `)}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`;
		}
		return panel(new Text(`\n${body}`, 0, 0), theme);
	},
};

const writeRenderers: ToolRenderers = {
	renderShell: "self",

	renderCall(args, theme, context: CallContext) {
		const path = readString(args, "path") ?? "";
		const header = `${theme.fg(TOOL_NAME_COLOR, theme.bold("write"))} ${theme.fg(TOOL_ARG_COLOR, path)}`;
		const content = readString(args, "content");

		if (content === undefined) {
			return updateCallHeader(context, theme, header, formatSuffix([`invalid content arg - expected string`], false, theme));
		}

		const label = lineLabel(contentLines(content).length);
		return updateCallHeader(context, theme, header, formatSuffix([label], !context.expanded, theme));
	},

	renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: CallContext) {
		if (context.isError) {
			const output = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
			return output ? resultBody(`\n${theme.fg("error", output)}`, theme, options.expanded) : new Container();
		}

		// 写入内容放在结果区，展开时才展示，调用行保持一行的样式
		if (!options.expanded) {
			return new Container();
		}
		const content = readString(context.args, "content");
		if (content === undefined) {
			return new Container();
		}
		const path = readString(context.args, "path") ?? "";
		const cacheKey = typeof context.args === "object" && context.args !== null ? context.args : undefined;
		const body = writeBody(cacheKey, content, path, theme);
		if (body.total === 0) {
			return new Container();
		}

		let output = `\n${body.rendered.join("\n")}`;
		if (body.total > MAX_EXPANDED_LINES) {
			const rest = body.total - MAX_EXPANDED_LINES;
			output += `\n${theme.fg("muted", `... (${rest} more lines, ${lineLabel(body.total)} total, `)}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`;
		}
		return panel(new Text(output, 0, 0), theme);
	},
};

const shellRenderers: Record<string, ToolRenderers> = {
	bash: createShellRenderers("bash"),
	powershell: createShellRenderers("powershell"),
};

/** 没有专属渲染器的工具使用的调用行：工具名加参数预览 */
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

/** 折叠结果、限制展开行数的通用渲染包装 */
function createGenericRenderers(toolName: string, base: ToolRenderers | undefined): ToolRenderers {
	return {
		renderShell: "self",

		renderCall(args, theme, context: CallContext) {
			const inner = base?.renderCall
				? base.renderCall(args, toolCallTheme(theme), { ...context, lastComponent: context.state.innerCall })
				: new Text(genericCallText(toolName, args, theme), 0, 0);
			context.state.innerCall = inner;

			const line = callLineOf(context);
			line.setInner(inner);
			line.setText(componentText(inner));
			line.setSuffix("");
			applyCallState(line, context, theme);
			return wrapResult(line, theme, context.expanded);
		},

		renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: CallContext) {
			const state = context.state;
			// 内置渲染器通过 lastComponent 复用上次返回的组件，包装层不能占用这个位置
			const innerContext: CallContext = { ...context, lastComponent: state.innerResult };
			const output = extractOutput(result.content);
			const lines = output ? output.split("\n") : [];
			// 内置的紧凑调用行已经自带展开提示，不再重复添加
			const hinted = state.callLine?.hasText(keyText("app.tools.expand")) ?? false;

			const renderInner = (target: AgentToolResult<unknown>, targetOptions: ToolRenderResultOptions, colorKey: ThemeColor): Component => {
				if (base?.renderResult) {
					return base.renderResult(target, targetOptions, theme, innerContext);
				}
				const text = extractOutput(target.content);
				return text ? new Text(`\n${theme.fg(colorKey, text)}`, 0, 0) : new Container();
			};

			if (context.isError) {
				const component = renderInner(result, options, "error");
				state.innerResult = component;
				return wrapResult(component, theme, options.expanded);
			}

			if (!options.expanded) {
				if (lines.length > 0 && !hinted) {
					setCallSuffix(context, formatSuffix([lineLabel(lines.length)], true, theme));
				}
				return new Container();
			}

			if (lines.length > MAX_EXPANDED_LINES) {
				const limited: AgentToolResult<unknown> = {
					...result,
					content: [{ type: "text", text: lines.slice(0, MAX_EXPANDED_LINES).join("\n") }],
				};
				const inner = renderInner(limited, options, "toolOutput");
				state.innerResult = inner;
				const rest = lines.length - MAX_EXPANDED_LINES;
				const hint = `${theme.fg("muted", `... (${rest} more lines, `)}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`;
				const container = new Container();
				container.addChild(inner);
				container.addChild(new Text(`\n${hint}`, 0, 0));
				return panel(container, theme);
			}

			const component = renderInner(result, options, "toolOutput");
			state.innerResult = component;
			return panel(component, theme);
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

	pi.registerToolRenderer((toolName, next): ToolRenderers | undefined => {
		const shell = shellRenderers[toolName];
		if (shell) {
			return shell;
		}
		if (toolName === "edit") {
			return editRenderers;
		}
		if (toolName === "write") {
			return writeRenderers;
		}
		const base = next();
		// 扩展工具自带的结果渲染器保留自己的展示，没有渲染器的工具才做折叠
		if (FOLDED_BUILTIN_TOOLS.has(toolName) || !base?.renderResult) {
			return createGenericRenderers(toolName, base);
		}
		return base;
	});
}
