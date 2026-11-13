/**
 * 给用户消息与助手消息加上 codex 的标记。
 *
 * 用户消息保留整块背景，把主题里的 userMessageBg 换成中性灰，并在第一条正文行首画 `›`。
 * 助手消息的每个正文块在行首画 `•`，正文统一从第 3 列开始，与用户消息的文字位置相同。
 * 两处的缩进都从 Pi 传给组件的 outputPad 走，组件重建时 Markdown 才会带上新的左缩进。
 *
 * 助手消息只标记正文块，思考块保持原样。正文块是 updateContent 建出来的 Markdown 实例，
 * 这里在每个实例的 render 上包一层，只改第一条非空行。
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { codexBlockAnsi, currentTheme, replaceIndent } from "./lib/codex-style.ts";
import { loadBundle } from "./lib/pi-bundle.ts";

/** 打补丁的标记，避免重复包装同一批方法 */
const USER_PATCH_FLAG = Symbol.for("pi.ompi.codex.user");
const ASSISTANT_PATCH_FLAG = Symbol.for("pi.ompi.codex.assistant");
const TEXT_PATCH_FLAG = Symbol.for("pi.ompi.codex.text");

/** 用户消息与助手消息的左缩进，也决定标记所在的列 */
const MARK_INDENT = 3;

/** 用户消息与助手正文各自的标记 */
const USER_GLYPH = "›";
const ASSISTANT_GLYPH = "•";

/** 用户消息里的提示符占用的列数，与输出框的缩进一致 */
const USER_PROMPT_WIDTH = MARK_INDENT;

type TextBlock = { render: (width: number) => string[] };

type UserClass = {
	new (...args: never[]): object;
	prototype: {
		outputPad: number;
		setOutputPad: (padding: number) => void;
		render: (width: number) => string[];
		[USER_PATCH_FLAG]?: boolean;
	};
};

type AssistantSlot = { kind: string; markdown: TextBlock };

type AssistantClass = {
	new (...args: never[]): object;
	prototype: {
		outputPad: number;
		markdownSlots?: AssistantSlot[];
		updateContent: (message: unknown, isStreaming?: boolean) => void;
		[ASSISTANT_PATCH_FLAG]?: boolean;
	};
};

/** 第一条非空可见行，背景色与缩进都不算内容 */
function firstVisibleLine(lines: string[]): number {
	return lines.findIndex((line) => stripTerminalSequences(line).trim() !== "");
}

/** 在背景色之后把行首的三个空格换成提示符 */
function insertPrompt(theme: Theme, line: string, bg: string): string {
	const at = line.indexOf(bg);
	if (at < 0) {
		return line;
	}
	const head = line.slice(0, at + bg.length);
	const tail = line.slice(at + bg.length);
	if (!tail.startsWith(" ".repeat(USER_PROMPT_WIDTH))) {
		return line;
	}
	// 提示符的颜色复位会同时清掉背景，复位后重新打开
	return head + ` ${theme.fg("muted", USER_GLYPH)}${bg} ` + tail.slice(USER_PROMPT_WIDTH);
}

/** 用户消息：换背景色并加上提示符 */
function markUserLines(theme: Theme, lines: string[]): string[] {
	const themed = theme.getBgAnsi("userMessageBg");
	const block = codexBlockAnsi(theme);
	// 行内的整行复位会清掉背景，复位后重新打开
	const recolored = lines.map((line) =>
		line.split(themed).join(block).split("\x1b[0m").join(`\x1b[0m${block}`),
	);
	const index = firstVisibleLine(recolored);
	if (index >= 0) {
		recolored[index] = insertPrompt(theme, recolored[index]!, block);
	}
	return recolored;
}

/** 助手正文块：第一条非空行换成 `•` 标记 */
function markTextBlock(markdown: TextBlock): void {
	const target = markdown as TextBlock & { [TEXT_PATCH_FLAG]?: boolean };
	if (target[TEXT_PATCH_FLAG]) {
		return;
	}
	const originalRender = markdown.render;
	const patchedRender = function (this: TextBlock, width: number): string[] {
		const lines = originalRender.call(this, width);
		const index = firstVisibleLine(lines);
		if (index >= 0) {
			lines[index] = replaceIndent(currentTheme(), lines[index]!, MARK_INDENT, ASSISTANT_GLYPH, "muted");
		}
		return lines;
	};
	Object.defineProperty(markdown, TEXT_PATCH_FLAG, { value: true });
	markdown.render = patchedRender;
}

function patchUserMessage(userClass: UserClass): void {
	const prototype = userClass.prototype;
	if (prototype[USER_PATCH_FLAG]) {
		return;
	}
	const originalRender = prototype.render;
	const patchedRender = function (this: UserClass["prototype"], width: number): string[] {
		if (this.outputPad !== MARK_INDENT) {
			this.setOutputPad(MARK_INDENT);
		}
		return markUserLines(currentTheme(), originalRender.call(this, width));
	};
	Object.defineProperty(prototype, USER_PATCH_FLAG, { value: true });
	prototype.render = patchedRender;
}

function patchAssistantMessage(assistantClass: AssistantClass): void {
	const prototype = assistantClass.prototype;
	if (prototype[ASSISTANT_PATCH_FLAG]) {
		return;
	}
	const originalUpdateContent = prototype.updateContent;
	const patchedUpdateContent = function (
		this: AssistantClass["prototype"],
		message: unknown,
		isStreaming?: boolean,
	): void {
		// 改缩进必须丢掉旧的 Markdown 实例，构造时用的 paddingX 已经固定
		if (this.outputPad !== MARK_INDENT) {
			this.outputPad = MARK_INDENT;
			this.markdownSlots = [];
		}
		originalUpdateContent.call(this, message, isStreaming);
		for (const slot of this.markdownSlots ?? []) {
			if (slot.kind === "text") {
				markTextBlock(slot.markdown);
			}
		}
	};
	Object.defineProperty(prototype, ASSISTANT_PATCH_FLAG, { value: true });
	prototype.updateContent = patchedUpdateContent;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, _ctx) => {
		const bundle = await loadBundle();
		const userClass = bundle.UserMessageComponent as UserClass | undefined;
		const assistantClass = bundle.AssistantMessageComponent as AssistantClass | undefined;
		if (userClass === undefined || assistantClass === undefined) {
			throw new Error("打包入口里缺少 UserMessageComponent 或 AssistantMessageComponent");
		}
		patchUserMessage(userClass);
		patchAssistantMessage(assistantClass);
	});
}
