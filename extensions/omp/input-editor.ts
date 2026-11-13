/**
 * 把输入框改成 codex 的样子。
 *
 * 整块铺中性灰背景，不再画上下横线；左侧一个 `›` 提示符，输入文字缩进到提示符右侧。
 * 内容超出可视行数时，隐藏的行数写在顶部或底部的背景行里。输入为空时显示一行暗色占位文字。
 * 输入以 ! 开头进入 bash 模式时，提示符换成 $。
 */

import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { currentTheme, paintBlock, replaceIndent } from "./lib/codex-style.ts";

/** 提示符与输入文字的缩进列数 */
const PROMPT_WIDTH = 3;

/** 提示符字符与 bash 模式下替换的符号 */
const PROMPT_GLYPH = "›";
const BASH_PROMPT_GLYPH = "$";

/** 输入为空时的占位文字 */
const PLACEHOLDER = "Ask Pi to do anything";

/** 编辑器内部只对外暴露了这几项 */
type EditorInternals = {
	renderedAutocompleteHeight: number;
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		class CodexEditor extends CustomEditor {
			constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, editorTheme, keybindings, { paddingX: PROMPT_WIDTH });
			}

			/** 文字缩进固定为提示符宽度，主题设置不应改变它 */
			setPaddingX(): void {
				super.setPaddingX(PROMPT_WIDTH);
			}

			protected override renderTopBorder(width: number, hiddenLineCount: number): string {
				const theme = currentTheme();
				const hint = hiddenLineCount > 0 ? ` ${theme.fg("dim", `↑ ${hiddenLineCount} more`)}` : "";
				return paintBlock(theme, truncateToWidth(hint, width, ""), width);
			}

			protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
				const theme = currentTheme();
				const hint = hiddenLineCount > 0 ? ` ${theme.fg("dim", `↓ ${hiddenLineCount} more`)}` : "";
				return paintBlock(theme, truncateToWidth(hint, width, ""), width);
			}

			render(width: number): string[] {
				const lines = super.render(width);
				const autocompleteHeight = (this as unknown as EditorInternals).renderedAutocompleteHeight;
				if (typeof autocompleteHeight !== "number") {
					throw new Error("编辑器内部字段 renderedAutocompleteHeight 不存在，输入框背景无法绘制");
				}
				// 第 0 行与自动补全之前的最后一行是上下留白，中间才是输入内容
				const contentEnd = lines.length - 1 - autocompleteHeight;
				const paddingX = Math.min(PROMPT_WIDTH, Math.max(0, Math.floor((width - 1) / 2)));
				const theme = currentTheme();
				const empty = this.getText().length === 0;
				const isBashMode = this.getText().trimStart().startsWith("!");
				const glyph = isBashMode ? BASH_PROMPT_GLYPH : PROMPT_GLYPH;

				for (let index = 1; index < contentEnd; index++) {
					let line = lines[index] ?? "";
					if (index === 1 && paddingX > 0) {
						line = replaceIndent(theme, line, paddingX, glyph, "muted");
					}
					if (index === 1 && empty) {
						// 光标已经画在提示符后面，占位文字接在它后面
						line = line.replace(/ +$/, "");
						const remaining = Math.max(0, width - visibleWidth(line));
						line += truncateToWidth(` ${theme.fg("dim", PLACEHOLDER)}`, remaining, "");
					}
					lines[index] = paintBlock(theme, line, width);
				}
				return lines;
			}
		}

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new CodexEditor(tui, editorTheme, keybindings));
	});
}
