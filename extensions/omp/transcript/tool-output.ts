/**
 * 工具调用使用 codex 风格的标题与结果缩进。
 * 内置工具直接根据参数生成标题，第三方组件通过公开的 Component Interface 参与渲染。
 * 折叠时展示结果的前 3 行，展开时最多展示 100 行。
 */

import type {
	AgentToolResult,
	BashToolDetails,
	ExtensionAPI,
	Theme,
	ThemeColor,
	ToolRenderers,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { formatReadLineRange, getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Text,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { currentTheme } from "../lib/codex-style.ts";

const MAX_EXPANDED_LINES = 100;
const PREVIEW_LINES = 3;
const CARD_INDENT = " ";
const BRANCH_LEAD = `${CARD_INDENT}  └ `;
const BRANCH_TAIL = " ".repeat(visibleWidth(BRANCH_LEAD));

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

type RenderContext = NonNullable<Parameters<NonNullable<ToolRenderers["renderCall"]>>[2]>;
type KeyHint = RenderContext["keyHint"];
type ToolContent = ReadonlyArray<{ type: string; text?: string }>;

interface CallRenderState {
	callLine?: CallLine;
	innerCall?: Component;
	innerResult?: Component;
	writePreview?: { path: unknown; content: string; theme: Theme; text: string };
	/** 原渲染器的状态在调用与结果之间共享，由原渲染器维护。 */
	inner?: Record<string, unknown>;
}

type CallContext = Omit<RenderContext, "state"> & { state: CallRenderState };

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

	// 所有执行中的调用行共用一个定时器，最后一项结束后停止刷新。
	spinnerTargets.set(context.state, context.invalidate);
	if (spinnerTimer === undefined) {
		spinnerTimer = setInterval(() => {
			for (const invalidate of spinnerTargets.values()) {
				invalidate();
			}
		}, SPINNER_INTERVAL_MS);
	}
}

function clearSpinnerTargets(): void {
	spinnerTargets.clear();

	if (spinnerTimer !== undefined) {
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	}
}

function isBlank(line: string | undefined): boolean {
	return line === undefined || stripTerminalSequences(line).trim() === "";
}

function statusIcon(context: CallContext, theme: Theme): string {
	if (context.isPartial) {
		const frame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!;
		return theme.fg("success", frame);
	}

	return context.isError ? theme.fg("error", "✗") : theme.fg("success", "•");
}

function hiddenHint(hidden: number, theme: Theme, keyHint: KeyHint): string {
	return theme.fg("dim", `+ ${hidden} line${hidden === 1 ? "" : "s"} (`) +
		keyHint("app.tools.expand", "to expand") + theme.fg("dim", ")");
}

function overflowHint(rest: number, theme: Theme, keyHint: KeyHint): string {
	return theme.fg("muted", `... (${rest} more line${rest === 1 ? "" : "s"}, `) +
		keyHint("app.tools.expand", "to collapse") + theme.fg("muted", ")");
}

function withMoreMarker(raw: string): string {
	const firstLine = raw.split("\n")[0]!.replace(/ +$/, "");
	return raw.includes("\n") ? `${firstLine} ...` : firstLine;
}

/** 标题内容保存完整文字，第三方组件自行生成展示行。 */
class CallLine implements Component {
	private content: string | Component = "";
	private icon = "";
	private expanded = false;
	private prefixWidth = 0;
	private innerWidth = 0;
	private innerRows = 0;

	constructor(private readonly keyHint: KeyHint) {}

	update(content: string | Component, context: CallContext, theme: Theme): void {
		this.content = content;
		this.icon = statusIcon(context, theme);
		this.expanded = context.expanded;
	}

	render(width: number): string[] {
		this.innerRows = 0;
		if (width <= 0) {
			return [];
		}

		const prefix = truncateToWidth(`${CARD_INDENT}${this.icon} `, width, "");
		this.prefixWidth = visibleWidth(prefix);
		this.innerWidth = Math.max(1, width - this.prefixWidth);

		let lines: string[];
		if (typeof this.content === "string") {
			lines = this.expanded
				? wrapTextWithAnsi(this.content, this.innerWidth)
				: [truncateToWidth(withMoreMarker(this.content), this.innerWidth, "...")];
		}
		else {
			lines = this.content.render(this.innerWidth);
			this.innerRows = lines.length;
		}

		const capacity = MAX_EXPANDED_LINES + 1;
		const shown = this.expanded ? lines.slice(0, capacity) : lines;

		// 鼠标事件仅转发到原组件实际显示的行，超限提示由外层处理。
		this.innerRows = Math.min(this.innerRows, shown.length);
		const indent = " ".repeat(this.prefixWidth);
		const rendered = shown.map((line, index) =>
			truncateToWidth((index === 0 ? prefix : indent) + line, width, ""),
		);

		if (this.expanded && lines.length > capacity) {
			rendered.push(truncateToWidth(overflowHint(lines.length - capacity, currentTheme(), this.keyHint), width, "..."));
		}

		return rendered;
	}

	invalidate(): void {
		if (typeof this.content !== "string") {
			this.content.invalidate();
		}
	}

	handleInput(data: string): void {
		if (typeof this.content !== "string") {
			this.content.handleInput?.(data);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (typeof this.content === "string" || event.x < this.prefixWidth || event.y < 0 || event.y >= this.innerRows) {
			return undefined;
		}

		return this.content.handleMouse?.({ ...event, x: event.x - this.prefixWidth, width: this.innerWidth, height: this.innerRows });
	}
}

/** 仅替换组件复用信息，执行状态与参数保持原值。 */
function innerContext(context: CallContext, lastComponent: Component | undefined): RenderContext {
	context.state.inner ??= {};
	return { ...context, state: context.state.inner, lastComponent };
}

const outputCache = new WeakMap<ToolContent, string>();

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

function displayArg(value: unknown): string {
	if (value == null) {
		return "...";
	}

	return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

/** 内置工具的标题与写入预览直接使用参数生成。 */
function builtinCallText(toolName: string, args: unknown, theme: Theme, context: CallContext): string | undefined {
	const values = args !== null && typeof args === "object" && !Array.isArray(args)
		? args as Record<string, unknown>
		: {};
	const path = values.file_path ?? values.path;
	let label: string;
	let body: string;

	switch (toolName) {
		case "bash":
		case "powershell":
			label = "Ran";
			body = displayArg(values.command);
			break;

		case "read":
			label = "Read";
			body = displayArg(path) + formatReadLineRange(values.offset, values.limit);
			break;

		case "edit":
		case "write":
			label = "Edited";
			body = displayArg(path);
			break;

		case "ls":
			label = "Listed";
			body = displayArg(path ?? ".");
			if (values.limit != null) body += ` (limit ${displayArg(values.limit)})`;
			break;

		case "find":
		case "grep":
			label = "Searched";
			body = `${displayArg(values.pattern)} in ${displayArg(path ?? ".")}`;
			if (values.glob) body += ` (${displayArg(values.glob)})`;
			if (values.limit != null) body += ` (limit ${displayArg(values.limit)})`;
			break;

		default:
			return undefined;
	}

	let text = `${theme.fg("success", label)} ${theme.fg("text", body)}`;

	// 折叠时标记存在预览，展开后按内容、路径和主题复用高亮结果。
	if (toolName === "write" && typeof values.content === "string" && values.content.length > 0) {
		if (!context.expanded) {
			return text + "\n";
		}

		let preview = context.state.writePreview;
		if (preview === undefined || preview.path !== path || preview.content !== values.content || preview.theme !== theme) {
			const content = values.content.replace(/\r/g, "").replace(/\t/g, "   ");
			const language = typeof path === "string" ? getLanguageFromPath(path) : undefined;
			const lines = language ? highlightCode(content, language) : content.split("\n");
			preview = { path, content: values.content, theme, text: lines.join("\n") };
			context.state.writePreview = preview;
		}

		text += "\n\n" + preview.text;
	}

	return text;
}

/** 完整参数保留到 CallLine，折叠时才限制展示宽度。 */
function genericCallText(toolName: string, args: unknown, theme: Theme): string {
	const label = theme.fg("success", toolName);
	if (args == null) {
		return label;
	}

	const entries = typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [["args", args]];
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	return pairs ? `${label} ${theme.fg("text", pairs)}` : label;
}

function genericResult(result: AgentToolResult<unknown>, theme: Theme, color: ThemeColor): Component {
	const text = extractOutput(result.content);
	return text ? new Text(theme.fg(color, text), 0, 0) : new Container();
}

/** shell 的正文由结果数据生成，截断信息与完整输出路径保留。 */
function shellResult(result: AgentToolResult<unknown>, theme: Theme, context: CallContext): Component {
	const text = extractOutput(result.content);
	const details = result.details as BashToolDetails | undefined;
	const lines = text ? [theme.fg(context.isError ? "error" : "toolOutput", text)] : [];

	if (details?.fullOutputPath && !text.includes(details.fullOutputPath)) {
		lines.push(theme.fg("warning", `[Full output: ${details.fullOutputPath}]`));
	}

	if (context.isPartial && details?.truncation?.truncated) {
		const truncation = details.truncation;
		lines.push(theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`));
	}

	return new Text(lines.join("\n"), 0, 0);
}

/** 结果正文的预览与缩进由外层处理，鼠标坐标转换到原组件。 */
class BranchBody implements Component {
	private contentStart = 0;
	private contentRows = 0;
	private contentWidth = 0;

	constructor(
		private readonly inner: Component,
		private readonly expanded: boolean,
		private readonly keyHint: KeyHint,
	) {}

	render(width: number): string[] {
		this.contentStart = 0;
		this.contentRows = 0;
		if (width <= 0) {
			return [];
		}

		const theme = currentTheme();
		this.contentWidth = Math.max(1, width - BRANCH_TAIL.length);
		const source = this.inner.render(this.contentWidth);

		// 首尾空行不占预览额度，保留原数组下标用于鼠标坐标转换。
		let end = source.length;
		while (this.contentStart < end && isBlank(source[this.contentStart])) this.contentStart++;
		while (end > this.contentStart && isBlank(source[end - 1])) end--;

		const capacity = this.expanded ? MAX_EXPANDED_LINES : PREVIEW_LINES;
		const shownEnd = Math.min(end, this.contentStart + capacity);
		this.contentRows = shownEnd - this.contentStart;

		const rendered: string[] = [];
		for (let row = this.contentStart; row < shownEnd; row++) {
			const line = source[row]!;
			const prefix = theme.fg("dim", row === this.contentStart ? BRANCH_LEAD : BRANCH_TAIL);
			const body = this.expanded ? line : theme.fg("dim", stripTerminalSequences(line));
			rendered.push(truncateToWidth(prefix + body, width, ""));
		}

		// 折叠提示只统计非空隐藏行，展开提示统计全部剩余行。
		let hidden = end - shownEnd;
		if (!this.expanded) {
			hidden = 0;
			for (let row = shownEnd; row < end; row++) {
				if (!isBlank(source[row])) hidden++;
			}
		}

		if (hidden > 0) {
			const hint = this.expanded
				? overflowHint(hidden, theme, this.keyHint)
				: hiddenHint(hidden, theme, this.keyHint);
			rendered.push(truncateToWidth(theme.fg("dim", BRANCH_TAIL) + hint, width, "..."));
		}

		return rendered;
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	handleInput(data: string): void {
		this.inner.handleInput?.(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.x < BRANCH_TAIL.length || event.y < 0 || event.y >= this.contentRows) {
			return undefined;
		}

		// 原组件使用完整正文坐标，需要补回已隐藏的开头空行。
		return this.inner.handleMouse?.({
			...event,
			x: event.x - BRANCH_TAIL.length,
			y: event.y + this.contentStart,
			width: this.contentWidth,
			height: this.contentStart + this.contentRows,
		});
	}
}

function createUniformRenderers(toolName: string, base: ToolRenderers | undefined): ToolRenderers {
	return {
		renderShell: "self",

		renderCall(args, theme, context: CallContext) {
			let content: string | Component;
			const builtin = builtinCallText(toolName, args, theme, context);
			if (builtin !== undefined) {
				content = builtin;
			}
			else if (base?.renderCall) {
				content = base.renderCall(args, theme, innerContext(context, context.state.innerCall));
				context.state.innerCall = content;
			}
			else {
				content = genericCallText(toolName, args, theme);
			}

			const line = context.state.callLine ??= new CallLine(context.keyHint);
			line.update(content, context, theme);
			trackSpinner(context);
			return line;
		},

		renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: CallContext) {
			let inner: Component;
			if (toolName === "bash" || toolName === "powershell") {
				inner = shellResult(result, theme, context);
			}
			else if (toolName === "write") {
				inner = context.isError ? genericResult(result, theme, "error") : new Container();
			}
			else if (base?.renderResult) {
				// BranchBody 管理正文预览，原渲染器仍然收到真实的流式状态与耗时。
				const nextContext = { ...innerContext(context, context.state.innerResult), expanded: true };
				inner = base.renderResult(result, { ...options, expanded: true }, theme, nextContext);
				context.state.innerResult = inner;
			}
			else {
				inner = genericResult(result, theme, context.isError ? "error" : "toolOutput");
			}

			return new BranchBody(inner, options.expanded, context.keyHint);
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", clearSpinnerTargets);
	pi.on("session_shutdown", clearSpinnerTargets);

	pi.registerToolRenderer((toolName, next) => createUniformRenderers(toolName, next()));
}
