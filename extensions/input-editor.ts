/**
 * 把输入框换成类似 Codex 的样子。
 *
 * 去掉 Pi 默认的上下两条横线，改成整块带背景色的输入区域：上下各留一行同样背景色的空白，
 * 第一行行首是提示箭头，文字统一缩进箭头宽度，多行输入时输入区域随之变高。
 * 内容超出一屏时，滚动提示居中显示在留白行里。
 * 输入以 ! 开头进入 bash 模式时，提示箭头换成另一种颜色，配合被移除的横线提示当前模式。
 */

import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";

/** 输入区域的背景色，取自主题里的面板颜色 */
const EDITOR_BG = "toolPendingBg";

/** 提示箭头占用的列数，同时也是输入文字的缩进 */
const PROMPT_WIDTH = 2;

/** 提示箭头字符与颜色 */
const PROMPT_GLYPH = "❯";
const PROMPT_COLOR = "accent";

/** bash 模式下提示箭头使用的颜色，主题里 bashMode 与 accent 相同时靠这个区分 */
const BASH_PROMPT_COLOR = "warning";

/** 输入区域上下各留的留白行数 */
const PADDING_Y = 1;

/** 标记原有上下横线位置的内部标记，不会出现在渲染结果里 */
const TOP_MARK = "\u0000pi-editor-top\u0000";
const BOTTOM_MARK = "\u0000pi-editor-bottom\u0000";

const BG_CLOSE = "\x1b[49m";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const theme = ctx.ui.theme;
		const bgOpen = theme.getBgAnsi(EDITOR_BG);

		/** 整行铺上输入区域的背景色，行内出现 SGR 复位时重新铺一次 */
		const paint = (line: string): string => {
			const restored = line.split("\x1b[0m").join(`\x1b[0m${bgOpen}`);
			return `${bgOpen}${restored}${BG_CLOSE}`;
		};

		/** 留白行，可选地在中间放一段滚动提示 */
		const paddingRow = (width: number, hint: string): string => {
			if (!hint) {
				return paint(" ".repeat(width));
			}
			const label = ` ${hint} `;
			const labelWidth = visibleWidth(label);
			if (labelWidth > width) {
				return paint(truncateToWidth(theme.fg("muted", hint), width, "...", true));
			}
			const left = Math.floor((width - labelWidth) / 2);
			return paint(" ".repeat(left) + theme.fg("muted", label) + " ".repeat(width - left - labelWidth));
		};

		class BoxedEditor extends CustomEditor {
			private hiddenAbove = 0;
			private hiddenBelow = 0;

			constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, editorTheme, keybindings, { paddingX: PROMPT_WIDTH });
			}

			/** 文字缩进固定为箭头宽度，主题设置不应改变它 */
			setPaddingX(): void {
				super.setPaddingX(PROMPT_WIDTH);
			}

			renderTopBorder(_width: number, hiddenLineCount: number): string {
				this.hiddenAbove = hiddenLineCount;
				return TOP_MARK;
			}

			renderBottomBorder(_width: number, hiddenLineCount: number): string {
				this.hiddenBelow = hiddenLineCount;
				return BOTTOM_MARK;
			}

			render(width: number): string[] {
				const lines = super.render(width);
				const topIndex = lines.indexOf(TOP_MARK);
				const bottomIndex = lines.indexOf(BOTTOM_MARK);
				if (topIndex === -1 || bottomIndex <= topIndex) {
					return lines;
				}

				const content = lines.slice(topIndex + 1, bottomIndex);
				// 与 Editor 内部一致地计算实际缩进，窄终端下会小于 PROMPT_WIDTH
				const paddingX = Math.min(PROMPT_WIDTH, Math.max(0, Math.floor((width - 1) / 2)));
				if (paddingX > 0 && content.length > 0) {
					const isBashMode = this.getText().trimStart().startsWith("!");
					const prompt = truncateToWidth(
						theme.fg(isBashMode ? BASH_PROMPT_COLOR : PROMPT_COLOR, PROMPT_GLYPH) + " ".repeat(PROMPT_WIDTH),
						paddingX,
						"",
						true,
					);
					// 第一行行首的缩进替换成箭头，光标列与文字排版都保持不变
					content[0] = prompt + content[0].slice(paddingX);
				}

				const block: string[] = [];
				for (let i = 0; i < PADDING_Y; i++) {
					block.push(paddingRow(width, this.hiddenAbove > 0 ? `↑ ${this.hiddenAbove} more` : ""));
				}
				for (const line of content) {
					block.push(paint(line));
				}
				for (let i = 0; i < PADDING_Y; i++) {
					block.push(paddingRow(width, this.hiddenBelow > 0 ? `↓ ${this.hiddenBelow} more` : ""));
				}
				// 自动补全列表留在输入区域之外，保持弹出列表的样子
				return [...block, ...lines.slice(bottomIndex + 1)];
			}
		}

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new BoxedEditor(tui, editorTheme, keybindings));
	});
}
