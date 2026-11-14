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
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { paintBlock, replaceIndent, tryCurrentTheme } from "../lib/codex-style.ts";
import { markDegraded } from "../lib/degrade.ts";
import { loadBundle } from "../lib/pi-bundle.ts";

/** 打补丁的标记，避免重复包装同一批方法 */
const USER_PATCH_TOKEN_KEY = Symbol.for("pi.ompi.codex.user.patch");
const USER_PATCH_TOKEN = Symbol("pi.ompi.codex.user.patch.token");
const ASSISTANT_PATCH_FLAG = Symbol.for("pi.ompi.codex.assistant");
const TEXT_PATCH_FLAG = Symbol.for("pi.ompi.codex.text");

/** 用户消息与助手消息的左缩进，也决定标记所在的列 */
const MARK_INDENT = 3;

/** 用户消息与助手正文各自的标记 */
const USER_GLYPH = "›";
const ASSISTANT_GLYPH = "•";

/** 行首的 OSC 133 标记，写到屏幕之前会被 Pi 整体剥掉，重铺背景时必须留在最前面 */
const OSC133_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

type TextBlock = { render: (width: number) => string[] };

type UserClass = {
	new (...args: never[]): object;
	prototype: {
		outputPad: number;
		setOutputPad: (padding: number) => void;
		render: (width: number) => string[];
		[USER_PATCH_TOKEN_KEY]?: symbol;
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

/** 在第一条非空行的行首补上提示符，已经有的不再重复 */
function withUserPrompt(theme: Theme, line: string): string {
	const chars = [...stripTerminalSequences(line)];
	if (chars[0] === " " && chars[1] === USER_GLYPH && chars[2] === " ") {
		return line;
	}

	return line.replace(
		/^((?:\x1b\][^\x07]*\x07|\x1b\[[0-9;]*m)*) {3}/,
		(_match, prefix: string) => `${prefix} ${theme.fg("muted", USER_GLYPH)} `,
	);
}

/**
 * 用户消息：整行重铺中性灰背景并加上提示符。
 * 先把所有背景序列剥掉，旧版本已经铺过的背景色在扩展重新加载后也能被覆盖。
 */
function markUserLines(theme: Theme, lines: string[]): string[] {
	if (lines.length === 0) {
		return lines;
	}

	const width = visibleWidth(lines[0]!);
	if (width === 0) {
		return lines;
	}

	const stripped = lines.map((line) =>
		line.replace(/\x1b\[48;[0-9;]*m/g, "").split("\x1b[49m").join(""),
	);

	const index = firstVisibleLine(stripped);
	if (index >= 0) {
		stripped[index] = withUserPrompt(theme, stripped[index]!);
	}

	return stripped.map((line) => {
		// OSC 133 标记必须留在行首，否则 Pi 剥不掉，会直接写到终端里
		const lead = line.match(OSC133_PREFIX)?.[0] ?? "";
		return lead + paintBlock(theme, line.slice(lead.length), width);
	});
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
		const theme = tryCurrentTheme();
		if (theme === undefined) {
			return lines;
		}
		const index = firstVisibleLine(lines);
		if (index >= 0) {
			lines[index] = replaceIndent(theme, lines[index]!, MARK_INDENT, ASSISTANT_GLYPH, "muted");
		}

		return lines;
	};

	Object.defineProperty(markdown, TEXT_PATCH_FLAG, { value: true });
	markdown.render = patchedRender;
}

function patchUserMessage(userClass: UserClass): void {
	const prototype = userClass.prototype;
	if (prototype[USER_PATCH_TOKEN_KEY] === USER_PATCH_TOKEN) {
		return;
	}

	Object.defineProperty(prototype, USER_PATCH_TOKEN_KEY, { value: USER_PATCH_TOKEN, configurable: true });

	const originalRender = prototype.render;
	const patchedRender = function (this: UserClass["prototype"], width: number): string[] {
		const theme = tryCurrentTheme();
		if (theme === undefined) {
			return originalRender.call(this, width);
		}
		if (this.outputPad !== MARK_INDENT) {
			this.setOutputPad(MARK_INDENT);
		}

		return markUserLines(theme, originalRender.call(this, width));
	};

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
		// 先确认字段，避免创建空数组掩盖 Pi 已经更换内部结构的情况。
		if (!Array.isArray(this.markdownSlots)) {
			originalUpdateContent.call(this, message, isStreaming);
			markDegraded("助手消息组件缺少 markdownSlots");
			return;
		}

		// 改缩进必须丢掉旧的 Markdown 实例，构造时用的 paddingX 已经固定
		if (this.outputPad !== MARK_INDENT) {
			this.outputPad = MARK_INDENT;
			this.markdownSlots = [];
		}

		originalUpdateContent.call(this, message, isStreaming);
		const slots = this.markdownSlots;
		if (!Array.isArray(slots)) {
			markDegraded("助手消息组件缺少 markdownSlots");
			return;
		}

		// updateContent 可能复用 Markdown，只给正文实例安装一次标记处理。
		for (const slot of slots) {
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
		if (bundle === undefined) {
			return;
		}

		const userClass = bundle.UserMessageComponent as UserClass | undefined;
		const assistantClass = bundle.AssistantMessageComponent as AssistantClass | undefined;
		if (typeof userClass !== "function" || userClass.prototype === undefined ||
			typeof userClass.prototype.render !== "function" || typeof userClass.prototype.setOutputPad !== "function") {
			markDegraded("用户消息组件缺少 render/setOutputPad");
		}
		else {
			patchUserMessage(userClass);
		}

		if (typeof assistantClass !== "function" || assistantClass.prototype === undefined ||
			typeof assistantClass.prototype.updateContent !== "function") {
			markDegraded("助手消息组件缺少 updateContent");
		}
		else {
			patchAssistantMessage(assistantClass);
		}
	});
}
