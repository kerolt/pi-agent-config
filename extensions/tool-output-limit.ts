/**
 * 限制工具输出在终端 transcript 中展示的行数。
 *
 * bash 与 powershell：折叠状态只显示命令行本身，输出全部隐藏。
 * edit：折叠状态只显示文件路径，diff 全部隐藏；展开后最多展示 MAX_DIFF_LINES 行。
 * write：折叠状态只显示文件路径，写入内容全部隐藏；展开后最多展示 MAX_WRITE_LINES 行。
 * 所有工具都可以按 ctrl+o 或点击该行展开，命令行尾部的附注给出被隐藏的数量。
 */

import type { EditToolDetails, ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	getLanguageFromPath,
	highlightCode,
	keyHint,
	renderDiff,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences } from "@earendil-works/pi-tui";

/** 展开状态下 edit diff 展示的最大行数 */
const MAX_DIFF_LINES = 100;

/** 展开状态下 write 内容展示的最大行数 */
const MAX_WRITE_LINES = 100;

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

/** 命令行尾部的附注 */
function formatSuffix(parts: string[], withExpandKey: boolean, theme: any): string {
	if (parts.length === 0) {
		return "";
	}
	const body = parts.join(", ");
	if (!withExpandKey) {
		return ` ${theme.fg("muted", `... (${body})`)}`;
	}
	return ` ${theme.fg("muted", `... (${body}, `)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

/** 记录调用行文本，并把调用行组件存入 state 供结果渲染改写附注 */
function updateCallHeader(context: any, headerText: string, suffix = ""): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	context.state.headerText = headerText;
	context.state.callComponent = text;
	text.setText(headerText + suffix);
	return text;
}

function setCallSuffix(context: any, suffix: string): void {
	const state = context.state;
	if (state.callComponent instanceof Text && typeof state.headerText === "string") {
		state.callComponent.setText(state.headerText + suffix);
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
			const command = typeof args?.command === "string" ? args.command : "";
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

		const lines = contentLines(content);
		const label = lineLabel(lines.length);
		const text = updateCallHeader(context, header, formatSuffix([label], !context.expanded, theme));
		if (!context.expanded || lines.length === 0) {
			return text;
		}

		const shown = lines.slice(0, MAX_WRITE_LINES);
		const lang = path ? getLanguageFromPath(path) : undefined;
		const highlighted = lang ? highlightCode(shown.join("\n").replace(/\t/g, "   "), lang) : undefined;
		const body = shown
			.map((line, index) => highlighted?.[index] ?? theme.fg("toolOutput", line.replace(/\t/g, "   ")))
			.join("\n");

		let output = `${header}${formatSuffix([label], false, theme)}\n\n${body}`;
		if (lines.length > MAX_WRITE_LINES) {
			const rest = lines.length - MAX_WRITE_LINES;
			output += `\n${theme.fg("muted", `... (${rest} more lines, ${label} total, `)}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`;
		}
		text.setText(output);
		return text;
	},

	renderResult(result, _options, theme, context) {
		if (!context.isError) {
			return new Container();
		}
		const output = result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
		if (!output) {
			return new Container();
		}
		return new Text(`\n${theme.fg("error", output)}`, 0, 0);
	},
};

const shellRenderers: Record<string, ToolRenderers> = {
	bash: createShellRenderers("$"),
	powershell: createShellRenderers("PS>"),
};

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
		return next();
	});
}
