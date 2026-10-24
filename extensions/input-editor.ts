/**
 * 把输入框改成 Claude Code 的样子。
 *
 * 保留 Pi 默认的上下两条横线，不再铺灰色背景。第一行行首的缩进换成提示箭头，
 * 文字统一缩进箭头宽度，多行输入时输入区域随之变高。
 * 输入以 ! 开头进入 bash 模式时，箭头换成 $ 符号，提示当前会执行 shell 命令。
 */

import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, truncateToWidth, type TUI } from "@earendil-works/pi-tui";

/** 提示箭头占用的列数，同时也是输入文字的缩进 */
const PROMPT_WIDTH = 2;

/** 提示箭头字符与 bash 模式下替换的符号 */
const PROMPT_GLYPH = "❯";
const BASH_PROMPT_GLYPH = "$";
const PROMPT_COLOR = "accent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const theme = ctx.ui.theme;

		class ArrowEditor extends CustomEditor {
			constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, editorTheme, keybindings, { paddingX: PROMPT_WIDTH });
			}

			/** 文字缩进固定为箭头宽度，主题设置不应改变它 */
			setPaddingX(): void {
				super.setPaddingX(PROMPT_WIDTH);
			}

			render(width: number): string[] {
				const lines = super.render(width);
				// 与 Editor 内部一致地计算实际缩进，窄终端下会小于 PROMPT_WIDTH
				const paddingX = Math.min(PROMPT_WIDTH, Math.max(0, Math.floor((width - 1) / 2)));
				// 第 0 行是顶部横线，第 1 行是第一行正文
				const contentIndex = 1;
				const line = lines[contentIndex];
				if (paddingX === 0 || line === undefined) {
					return lines;
				}

				const isBashMode = this.getText().trimStart().startsWith("!");
				const prompt = truncateToWidth(
					theme.fg(PROMPT_COLOR, isBashMode ? BASH_PROMPT_GLYPH : PROMPT_GLYPH) + " ".repeat(PROMPT_WIDTH),
					paddingX,
					"",
					true,
				);
				// 第一行行首的缩进替换成箭头，光标列与文字排版都保持不变
				lines[contentIndex] = prompt + line.slice(paddingX);
				return lines;
			}
		}

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new ArrowEditor(tui, editorTheme, keybindings));
	});
}
