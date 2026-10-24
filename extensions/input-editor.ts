/**
 * 把输入框改成 Claude Code 的样子。
 *
 * 保留 Pi 默认的上下两条横线，不再铺灰色背景。第一行行首的缩进换成提示箭头，
 * 文字统一缩进箭头宽度，多行输入时输入区域随之变高。
 * 输入以 ! 开头进入 bash 模式时，箭头换成 $ 符号，提示当前会执行 shell 命令。
 * 横线固定使用 accent 颜色，不随思考强度变化，字符换成加粗的横线样式。
 */

import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, sliceByColumn, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";

/** 提示箭头占用的列数，同时也是输入文字的缩进 */
const PROMPT_WIDTH = 2;

/** 提示箭头字符与 bash 模式下替换的符号 */
const PROMPT_GLYPH = "❯";
const BASH_PROMPT_GLYPH = "$";
const PROMPT_COLOR = "accent";

/** 上下横线使用的加粗横线字符与颜色 */
const BORDER_GLYPH = "━";
const BORDER_COLOR = "accent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const theme = ctx.ui.theme;
		const borderColor = (text: string) => theme.fg(BORDER_COLOR, text);

		/** 与 Pi 自带的滚动提示排版一致，只把横线字符换成加粗样式 */
		const scrollBorder = (direction: string, hiddenLineCount: number, width: number): string => {
			const label = ` ${direction} ${hiddenLineCount} more `;
			const labelWidth = visibleWidth(label);
			if (labelWidth + 2 <= width) {
				const leftWidth = Math.floor((width - labelWidth) / 2);
				return (
					BORDER_GLYPH.repeat(leftWidth) + label + BORDER_GLYPH.repeat(width - leftWidth - labelWidth)
				);
			}
			const indicator = `${BORDER_GLYPH.repeat(3)} ${direction} ${hiddenLineCount} more `;
			const remaining = width - visibleWidth(indicator);
			if (remaining >= 0) {
				return indicator + BORDER_GLYPH.repeat(remaining);
			}
			const ellipsis = "...".slice(0, width);
			return sliceByColumn(indicator, 0, width - visibleWidth(ellipsis), true) + ellipsis;
		};

		class ArrowEditor extends CustomEditor {
			constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, editorTheme, keybindings, { paddingX: PROMPT_WIDTH });
			}

			/** 文字缩进固定为箭头宽度，主题设置不应改变它 */
			setPaddingX(): void {
				super.setPaddingX(PROMPT_WIDTH);
			}

			protected override renderTopBorder(width: number, hiddenLineCount: number): string {
				return borderColor(this.borderLine(width, hiddenLineCount, "↑"));
			}

			protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
				return borderColor(this.borderLine(width, hiddenLineCount, "↓"));
			}

			private borderLine(width: number, hiddenLineCount: number, direction: string): string {
				return hiddenLineCount > 0 ? scrollBorder(direction, hiddenLineCount, width) : BORDER_GLYPH.repeat(width);
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
