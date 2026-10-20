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
import type { EditToolDetails, ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
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

/** 展开状态下结果展示的最大行数 */
const MAX_RESULT_LINES = 100;

/** 展开状态下 edit diff 展示的最大行数 */
const MAX_DIFF_LINES = 100;

/** 展开状态下 write 内容展示的最大行数 */
const MAX_WRITE_LINES = 100;

/** 调用行参数预览的最大字符数 */
const COLLAPSED_ARGS_CHARS = 100;

/** 工具名用主题的强调色，参数与耗时等附注统一用 muted，与正文的强调部分分开 */
const TOOL_NAME_COLOR = "accent";
const TOOL_ARG_COLOR = "muted";

/** 把内置渲染器用到的主题色换成工具调用的配色：名字 accent、参数 muted。只影响颜色字符串 */
function toolCallTheme(theme: any): any {
	return new Proxy(theme, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (property !== "fg" || typeof value !== "function") {
				return value;
			}
			return (color: string, text: string) => target.fg(color === "toolTitle" ? TOOL_NAME_COLOR : color === "accent" ? TOOL_ARG_COLOR : color, text);
		},
	});
}

/** 工具内容相对左边界缩进的列数 */
const INDENT = 1;
const INDENT_TEXT = " ".repeat(INDENT);

/** 执行中的 spinner 帧与刷新间隔 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

/** 在执行中的工具，按渲染状态登记重绘回调，spinner 才会转动 */
const spinnerTargets = new Map<unknown, () => void>();
let spinnerTimer: ReturnType<typeof setInterval> | undefined;

function trackSpinner(context: any): void {
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

/** 调用行左侧的状态图标：执行中为 spinner，完成时与工具名同色，失败时为红色叉 */
function statusIcon(context: any, theme: any): string {
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
function panel(component: Component, theme: any): Component {
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
function wrapResult(component: Component, theme: any, expanded: boolean): Component {
	return expanded ? panel(component, theme) : inset(component);
}

/** 需要折叠结果的内置工具 */
const FOLDED_BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls"]);

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
function formatSuffix(parts: string[], withExpandKey: boolean, theme: any): string {
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
 * 结果渲染后改写图标与附注，不需要重建组件。
 */
class CallLine implements Component {
	private text?: string;
	private suffix = "";
	private icon = "";
	private background = "";
	private expanded = false;

	constructor(private readonly inner?: Component) {}

	setText(text: string | undefined): void {
		this.text = text;
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

	/** 展开时和正文面板使用同一背景色，形成一块连续的区域 */
	setBackground(background: string | undefined): void {
		this.background = background ?? "";
	}

	render(width: number): string[] {
		const raw = this.text ?? (this.inner ? (this.inner.render(Math.max(1, width - INDENT))[0] ?? "") : "");
		const prefix = INDENT_TEXT + (this.icon ? `${this.icon} ` : "");
		const prefixWidth = visibleWidth(prefix);
		const contentWidth = Math.max(1, width - prefixWidth);
		const lines = this.expanded
			? this.renderExpanded(raw, prefix, prefixWidth, contentWidth, width)
			: [prefix + composeCallLine(withMoreMarker(raw), this.suffix, contentWidth)];
		if (!this.background) {
			return lines;
		}
		return lines.map((line) => {
			const painted = line.split("\x1b[0m").join(`\x1b[0m${this.background}`);
			const padding = " ".repeat(Math.max(0, width - visibleWidth(painted)));
			return `${this.background}${painted}${padding}\x1b[49m`;
		});
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
		return [...rendered, `${INDENT_TEXT}${this.suffix}`];
	}

	invalidate(): void {
		this.inner?.invalidate();
	}
}

/** 记录标题、图标与附注，并把组件存入 state 供结果渲染改写 */
function updateCallHeader(context: any, theme: any, headerText: string, suffix = ""): CallLine {
	const line = context.lastComponent instanceof CallLine ? context.lastComponent : new CallLine();
	context.state.callComponent = line;
	line.setText(headerText);
	line.setIcon(statusIcon(context, theme));
	line.setSuffix(suffix);
	line.setExpanded(Boolean(context.expanded));
	line.setBackground(context.expanded ? theme.getBgAnsi("userMessageBg") : undefined);
	trackSpinner(context);
	return line;
}

function setCallSuffix(context: any, suffix: string): void {
	const line = context.state.callComponent;
	if (line instanceof CallLine) {
		line.setSuffix(suffix);
	}
}

/** 取出命令输出文本，去掉终端控制序列与回车符 */
function extractOutput(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((part) => part.type === "text")
		.map((part) => stripTerminalSequences(part.text ?? "").replace(/\r/g, ""))
		.join("\n")
		.trim();
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

function createShellRenderers(toolName: string): ToolRenderers {
	return {
		renderShell: "self",

		renderCall(args, theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const rawCommand = typeof args?.command === "string" ? args.command : "";
			// 完整命令交给调用行处理：折叠时取第一行，展开时按宽度折行
			const header = `${theme.fg(TOOL_NAME_COLOR, theme.bold(toolName))} ${theme.fg(TOOL_ARG_COLOR, rawCommand)}`;
			return updateCallHeader(context, theme, header);
		},

		renderResult(result, options, theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
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
				component.addChild(wrapResult(new Text(`\n${styled}`, 0, 0), theme, true));
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
				component.addChild(wrapResult(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0), theme, options.expanded));
			}

			component.invalidate();
			return component;
		},
	};
}

const editRenderers: ToolRenderers = {
	renderShell: "self",

	renderCall(args, theme, context) {
		const path = typeof args?.path === "string" ? args.path : "";
		return updateCallHeader(context, theme, `${theme.fg(TOOL_NAME_COLOR, theme.bold("edit"))} ${theme.fg(TOOL_ARG_COLOR, path)}`);
	},

	renderResult(result, options, theme, context) {
		const textPart = result.content.find((part) => part.type === "text");
		const text = textPart && textPart.type === "text" ? textPart.text : "";

		if (context.isError) {
			setCallSuffix(context, "");
			return wrapResult(new Text(theme.fg("error", text), 0, 0), theme, options.expanded);
		}

		const diff = (result.details as EditToolDetails | undefined)?.diff;
		if (!diff) {
			setCallSuffix(context, "");
			return wrapResult(new Text(theme.fg("toolOutput", text), 0, 0), theme, options.expanded);
		}

		const lines = diff.split("\n");
		let additions = 0;
		let removals = 0;
		for (const line of lines) {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				additions++;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				removals++;
			}
		}
		const stats = `+${additions} / -${removals}`;

		if (!options.expanded) {
			setCallSuffix(context, formatSuffix([stats], true, theme));
			return new Container();
		}

		setCallSuffix(context, formatSuffix([stats], false, theme));
		const shown = lines.slice(0, MAX_DIFF_LINES);
		let body = renderDiff(shown.join("\n"));
		if (lines.length > MAX_DIFF_LINES) {
			const rest = lines.length - MAX_DIFF_LINES;
			body += `\n${theme.fg("muted", `... (${rest} more diff lines, `)}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`;
		}
		return wrapResult(new Text(`\n${body}`, 0, 0), theme, true);
	},
};

const writeRenderers: ToolRenderers = {
	renderShell: "self",

	renderCall(args, theme, context) {
		const path = typeof args?.path === "string" ? args.path : "";
		const header = `${theme.fg(TOOL_NAME_COLOR, theme.bold("write"))} ${theme.fg(TOOL_ARG_COLOR, path)}`;
		const content = typeof args?.content === "string" ? args.content : null;

		if (content === null) {
			return updateCallHeader(context, theme, header, formatSuffix([`invalid content arg - expected string`], false, theme));
		}

		const label = lineLabel(contentLines(content).length);
		return updateCallHeader(context, theme, header, formatSuffix([label], !context.expanded, theme));
	},

	renderResult(result, options, theme, context) {
		if (context.isError) {
			const output = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
			return output ? wrapResult(new Text(`\n${theme.fg("error", output)}`, 0, 0), theme, options.expanded) : new Container();
		}

		// 写入内容放在结果区，展开时才展示，调用行保持一行的样式
		if (!options.expanded) {
			return new Container();
		}
		const content = typeof context.args?.content === "string" ? context.args.content : null;
		if (content === null) {
			return new Container();
		}
		const lines = contentLines(content);
		if (lines.length === 0) {
			return new Container();
		}
		const path = typeof context.args?.path === "string" ? context.args.path : "";
		const shown = lines.slice(0, MAX_WRITE_LINES);
		const lang = path ? getLanguageFromPath(path) : undefined;
		const highlighted = lang ? highlightCode(shown.join("\n").replace(/\t/g, "   "), lang) : undefined;
		const body = shown
			.map((line, index) => highlighted?.[index] ?? theme.fg("toolOutput", line.replace(/\t/g, "   ")))
			.join("\n");

		let output = `\n${body}`;
		if (lines.length > MAX_WRITE_LINES) {
			const rest = lines.length - MAX_WRITE_LINES;
			output += `\n${theme.fg("muted", `... (${rest} more lines, ${lineLabel(lines.length)} total, `)}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`;
		}
		return wrapResult(new Text(output, 0, 0), theme, true);
	},
};

const shellRenderers: Record<string, ToolRenderers> = {
	bash: createShellRenderers("bash"),
	powershell: createShellRenderers("powershell"),
};

/** 没有专属渲染器的工具使用的调用行：工具名加参数预览 */
function genericCallText(toolName: string, args: unknown, theme: any): string {
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

		renderCall(args, theme, context) {
			const inner = base?.renderCall
				? base.renderCall(args, toolCallTheme(theme), { ...context, lastComponent: context.state.innerCall })
				: new Text(genericCallText(toolName, args, theme), 0, 0);
			const line = new CallLine(inner);
			const innerText: unknown = (inner as any)?.text;
			line.setText(typeof innerText === "string" ? innerText : undefined);
			line.setIcon(statusIcon(context, theme));
			line.setExpanded(Boolean(context.expanded));
			line.setBackground(context.expanded ? theme.getBgAnsi("userMessageBg") : undefined);
			trackSpinner(context);
			context.state.innerCall = inner;
			context.state.callLine = line;
			// 内置的紧凑调用行已经自带展开提示，不再重复添加
			context.state.innerCallText = typeof innerText === "string" ? innerText : "";
			return line;
		},

		renderResult(result, options, theme, context) {
			const state = context.state;
			// 内置渲染器通过 lastComponent 复用上次返回的组件，包装层不能占用这个位置
			const innerContext = { ...context, lastComponent: state.innerResult };
			const output = extractOutput(result.content);
			const lines = output ? output.split("\n") : [];
			const expandKey = keyText("app.tools.expand");
			const hinted = expandKey.length > 0 && String(state.innerCallText).includes(expandKey);

			const renderInner = (target: any, targetOptions: any, colorKey: string) => {
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
					state.callLine?.setSuffix(formatSuffix([lineLabel(lines.length)], true, theme));
				}
				return new Container();
			}

			if (lines.length > MAX_RESULT_LINES) {
				const limited = { ...result, content: [{ type: "text", text: lines.slice(0, MAX_RESULT_LINES).join("\n") }] };
				const inner = renderInner(limited, options, "toolOutput");
				state.innerResult = inner;
				const rest = lines.length - MAX_RESULT_LINES;
				const hint = `${theme.fg("muted", `... (${rest} more lines, `)}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`;
				const container = new Container();
				container.addChild(inner);
				container.addChild(new Text(`\n${hint}`, 0, 0));
				return wrapResult(container, theme, true);
			}

			const component = renderInner(result, options, "toolOutput");
			state.innerResult = component;
			return wrapResult(component, theme, true);
		},
	};
}

export default function (pi: ExtensionAPI) {
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
