/**
 * 限制工具输出在终端 transcript 中展示的行数。
 *
 * 内置工具折叠时都只显示调用行本身，输出结果完全隐藏，调用行尾部的附注给出被隐藏的数量。
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
	Spacer,
	Text,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

/** 展开状态下结果展示的最大行数 */
const MAX_RESULT_LINES = 100;

/** 展开状态下 edit diff 展示的最大行数 */
const MAX_DIFF_LINES = 100;

/** 展开状态下 write 内容展示的最大行数 */
const MAX_WRITE_LINES = 100;

/** 调用行参数预览的最大字符数 */
const COLLAPSED_ARGS_CHARS = 100;

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

/**
 * 调用行组件：始终只渲染一行，超出宽度用省略号截断，附注接在同一行末尾。
 * 结果渲染后可以改写附注，不需要重建组件。
 */
class HeaderLine implements Component {
	private suffix = "";

	constructor(public text: string) {}

	setText(text: string): void {
		this.text = text;
	}

	setSuffix(suffix: string): void {
		this.suffix = suffix;
	}

	render(width: number): string[] {
		return [composeCallLine(this.text, this.suffix, width)];
	}

	invalidate(): void {}
}

/** 记录调用行文本，并把调用行组件存入 state 供结果渲染改写附注 */
function updateCallHeader(context: any, headerText: string, suffix = ""): HeaderLine {
	const line = context.lastComponent instanceof HeaderLine ? context.lastComponent : new HeaderLine("");
	context.state.headerText = headerText;
	context.state.callComponent = line;
	line.setText(headerText);
	line.setSuffix(suffix);
	return line;
}

function setCallSuffix(context: any, suffix: string): void {
	const state = context.state;
	if (state.callComponent instanceof HeaderLine) {
		state.callComponent.setSuffix(suffix);
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

function createShellRenderers(prompt: string): ToolRenderers {
	return {
		renderCall(args, theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const rawCommand = typeof args?.command === "string" ? args.command : "";
			// 多行命令（例如用 heredoc 写脚本）只展示第一行，其余用省略号代替
			const firstLine = rawCommand.split("\n")[0];
			const command = rawCommand.includes("\n") ? `${firstLine} ...` : firstLine;
			const timeout = args?.timeout ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
			return updateCallHeader(context, theme.fg("toolTitle", theme.bold(`${prompt} ${command}`)) + timeout);
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
				component.addChild(new Spacer(1));
				component.addChild(new Text(`\n${styled}`, 0, 0));
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
				component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
			}

			component.invalidate();
			return component;
		},
	};
}

const editRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const path = typeof args?.path === "string" ? args.path : "";
		return updateCallHeader(context, `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path)}`);
	},

	renderResult(result, options, theme, context) {
		const textPart = result.content.find((part) => part.type === "text");
		const text = textPart && textPart.type === "text" ? textPart.text : "";

		if (context.isError) {
			setCallSuffix(context, "");
			return new Text(theme.fg("error", text), 0, 0);
		}

		const diff = (result.details as EditToolDetails | undefined)?.diff;
		if (!diff) {
			setCallSuffix(context, "");
			return new Text(theme.fg("toolOutput", text), 0, 0);
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
		return new Text(body, 0, 0);
	},
};

const writeRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const path = typeof args?.path === "string" ? args.path : "";
		const header = `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path)}`;
		const content = typeof args?.content === "string" ? args.content : null;

		if (content === null) {
			return updateCallHeader(context, header, formatSuffix([`invalid content arg - expected string`], false, theme));
		}

		const label = lineLabel(contentLines(content).length);
		return updateCallHeader(context, header, formatSuffix([label], !context.expanded, theme));
	},

	renderResult(result, options, theme, context) {
		if (context.isError) {
			const output = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
			return output ? new Text(`\n${theme.fg("error", output)}`, 0, 0) : new Container();
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
		return new Text(output, 0, 0);
	},
};

const shellRenderers: Record<string, ToolRenderers> = {
	bash: createShellRenderers("$"),
	powershell: createShellRenderers("PS>"),
};

/** 在调用行末尾接上附注的包装组件，只渲染一行，不依赖内置渲染器返回的组件类型 */
class CallLine implements Component {
	private suffix = "";

	constructor(private readonly inner: Component) {}

	setSuffix(suffix: string): void {
		this.suffix = suffix;
	}

	render(width: number): string[] {
		// 内置渲染器的调用行会自己换行，这里只保留第一行
		const base = (this.inner.render(width)[0] ?? "").replace(/ +$/, "");
		return [composeCallLine(base, this.suffix, width)];
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

/** 没有专属渲染器的工具使用的调用行：工具名加参数预览 */
function genericCallText(toolName: string, args: unknown, theme: any): string {
	const header = theme.fg("toolTitle", theme.bold(toolName));
	if (args == null) {
		return header;
	}
	const entries = typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [["args", args]];
	if (entries.length === 0) {
		return header;
	}
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
	return `${header} ${theme.fg("muted", preview)}`;
}

/** 折叠结果、限制展开行数的通用渲染包装 */
function createGenericRenderers(toolName: string, base: ToolRenderers | undefined): ToolRenderers {
	return {
		renderShell: base?.renderShell,

		renderCall(args, theme, context) {
			const inner = base?.renderCall
				? base.renderCall(args, theme, { ...context, lastComponent: context.state.innerCall })
				: new Text(genericCallText(toolName, args, theme), 0, 0);
			const line = new CallLine(inner);
			const innerText: unknown = (inner as any)?.text;
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
				return component;
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
				return container;
			}

			const component = renderInner(result, options, "toolOutput");
			state.innerResult = component;
			return component;
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
