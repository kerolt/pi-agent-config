/**
 * 输入框的背景绘制与共用取色。
 *
 * 用户消息的底色由主题的 userMessageBg 决定，这里只负责输入框：整块中性灰，
 * 不画上下横线。绘制补满整行，遇到复位序列重新打开背景色，避免主题的复位序列
 * 把底色清掉。
 */

import { backgroundAnsi, parseColor, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { markDegraded } from "./degrade.ts";

/** 深色主题下输入框的背景色，与 codex 的 One Dark 配色一致 */
const DARK_EDITOR = "#41454c";

/** 浅色主题下输入框的背景色 */
const LIGHT_EDITOR = "#ececec";

/** Pi 把当前主题放在这个全局符号下 */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

/** 背景色复位序列 */
const BG_RESET = "\x1b[49m";

/** 全屏复位序列，行内出现时要重新打开背景 */
const SGR_RESET = "\x1b[0m";

/** 取当前主题，模块加载后由 Pi 写入 */
export function currentTheme(): Theme {
	const theme = (globalThis as Record<symbol, Theme | undefined>)[THEME_KEY];
	if (theme === undefined) {
		throw new Error("主题尚未初始化");
	}

	return theme;
}

/** 渲染可能早于主题初始化，保留原生展示行可避免重绘持续报错。 */
export function tryCurrentTheme(): Theme | undefined {
	try {
		return currentTheme();
	}
	catch (error) {
		markDegraded(`无法取得当前主题：${String(error)}`);
		return undefined;
	}
}

/** 输入框在深色与浅色主题下的背景色 */
function editorColor(theme: Theme): string {
	return theme.appearance === "light" ? LIGHT_EDITOR : DARK_EDITOR;
}

/** 把一行铺成整行宽度的输入框背景 */
export function paintBlock(theme: Theme, text: string, width: number): string {
	const bg = backgroundAnsi(parseColor(editorColor(theme)), theme.getColorMode());
	const padding = " ".repeat(Math.max(0, width - visibleWidth(text)));

	return bg + (text + padding).split(SGR_RESET).join(SGR_RESET + bg) + BG_RESET;
}

/** 把行首的 indent 个空格换成标记，宽度不够时保持原样 */
export function replaceIndent(
	theme: Theme,
	line: string,
	indent: number,
	glyph: string,
	color: ThemeColor,
): string {
	const spaces = " ".repeat(indent);
	if (indent <= 0 || !line.startsWith(spaces)) {
		return line;
	}

	if (indent === 1) {
		return theme.fg(color, glyph) + line.slice(1);
	}

	return ` ${theme.fg(color, glyph)}${" ".repeat(indent - 2)}${line.slice(indent)}`;
}
