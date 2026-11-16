/**
 * 对话正文的 Markdown 改写。
 *
 * 使用 pi 公开的 registerMarkdownTransformer：它拿到渲染前的 Markdown 源文本，
 * 返回改过的文本，一个扩展只能注册一个改写函数。这里做两件事：加行首标记，
 * 让一、二级标题带下划线并保留井号前缀。思考块不在注册范围内，保持原样。
 *
 * 行首标记：用户消息 `›`，助手正文 `•`。最后一轮回复不加标记：这一轮的结尾会补
 * 一行耗时，标记与那一行重复。认出最后一轮回复有两条路：从会话记录重新渲染时，
 * 用条目 id 比对最后一条助手消息；正在显示的消息没有条目 id，改用文字比对，
 * 消息结束时记下不含工具调用的回复正文分段。
 *
 * 标记是正文里的普通字符，颜色由主题的 text 决定，这里只负责位置。首行是
 * Markdown 块级语法时（围栏、标题、列表、引用、表格、缩进代码），单独起一行
 * 放标记，避免破坏原来的块。
 */

import type { ExtensionAPI, MarkdownMessageType, MarkdownTransformContext } from "@earendil-works/pi-coding-agent";

/** 每种消息面使用的标记，没有登记的面不处理 */
const GLYPHS: Partial<Record<MarkdownMessageType, string>> = {
	user: "›",
	assistant: "•",
};

/** 首行属于 Markdown 块级语法时不能直接在行首插入字符 */
const BLOCK_START = /^\s{0,3}(?:```|~~~|#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|\|)/;

/** 四个空格以上的缩进是代码块，同样不能插入 */
const INDENTED_CODE = /^ {4,}\S/;

/** 围栏代码块的开始与结束标记 */
const FENCE = /^ {0,3}(```|~~~)/;

/** 一、二级标题：行首最多三个空格，一到两个井号，后面接文字 */
const TOP_HEADING = /^( {0,3})(#{1,2})(?!#)\s+(\S.*)$/;

/** 会话记录里最后一条助手消息的条目 id，由 session_start 绑定 */
let lastAssistantId: () => string | undefined = () => undefined;

/** 最近一轮回复的正文分段，用于认出正在显示的最后一条回复 */
let finalReply: readonly string[] = [];

/** 在第一条非空行前放标记，已有标记时不重复添加 */
export function markFirstLine(markdown: string, glyph: string): string {
	if (markdown.startsWith(`${glyph} `)) {
		return markdown;
	}

	const lines = markdown.split("\n");
	const index = lines.findIndex((line) => line.trim() !== "");
	if (index < 0) {
		return markdown;
	}

	const line = lines[index]!;
	if (BLOCK_START.test(line) || INDENTED_CODE.test(line)) {
		lines.splice(index, 0, glyph);
	}
	else {
		lines[index] = `${glyph} ${line}`;
	}

	return lines.join("\n");
}

/**
 * 给一、二级标题加下划线，并把井号前缀写进标题文字里。
 *
 * 渲染组件只给一级标题加下划线，二级没有下划线，三级及以下保留 `#` 前缀。
 * 这里把一、二级都变成一级标题，原来的井号当普通文字写进标题内部，于是这两级
 * 同时得到下划线与 `#` / `##` 前缀；三级及更深保持原样，只有前缀。
 * 围栏代码块里的行不动，围栏外的缩进代码不会被匹配。
 */
export function underlineHeadings(markdown: string): string {
	const lines = markdown.split("\n");
	let fence: string | undefined;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const marker = FENCE.exec(line)?.[1];
		if (marker !== undefined) {
			// 只有同种围栏才关闭，``` 与 ~~~ 各自计数
			if (fence === undefined) {
				fence = marker;
			}
			else if (fence === marker) {
				fence = undefined;
			}
			continue;
		}

		if (fence !== undefined) {
			continue;
		}

		const match = TOP_HEADING.exec(line);
		if (match !== null) {
			lines[index] = `${match[1]}# ${match[2]} ${match[3]}`;
		}
	}

	return lines.join("\n");
}

/** 这段 Markdown 是否属于最后一轮回复 */
function isFinalReply(markdown: string, context: MarkdownTransformContext): boolean {
	if (context.messageType !== "assistant") {
		return false;
	}

	if (context.messageId !== undefined) {
		return context.messageId === lastAssistantId();
	}

	const text = markdown.trim();
	return text !== "" && finalReply.some((part) => part.trim() === text);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		let cachedKey = "";
		let cachedId: string | undefined;

		// 倒序查找比每次重算全部条目便宜，用条目数与会话 id 判断记录是否变化
		lastAssistantId = () => {
			const manager = ctx.sessionManager;
			const entries = manager.getEntries();
			const key = `${manager.getSessionId()}:${entries.length}:${manager.getLeafId()}`;
			if (key === cachedKey) {
				return cachedId;
			}

			cachedId = undefined;
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index]!;
				if (entry.type === "message" && entry.message.role === "assistant") {
					cachedId = entry.id;
					break;
				}
			}
			cachedKey = key;

			return cachedId;
		};
	});

	pi.on("message_end", ({ message }) => {
		if (message.role !== "assistant") {
			return;
		}

		// 带工具调用的回复后面还有内容，照旧保留标记
		if (message.content.some((part) => part.type === "toolCall")) {
			finalReply = [];
			return;
		}

		finalReply = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text);
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		const glyph = GLYPHS[context.messageType];
		const body = underlineHeadings(markdown);
		if (glyph === undefined || isFinalReply(markdown, context)) {
			return body;
		}

		return markFirstLine(body, glyph);
	}, { messageTypes: ["user", "assistant"] });
}
