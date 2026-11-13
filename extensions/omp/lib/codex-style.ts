/**
 * codex 风格共用的背景绘制与行首标记。
 *
 * codex 的用户消息与输入框都铺一块中性灰背景，主题里的 userMessageBg 带蓝调，这里换成
 * 固定色值，并按主题明暗选择深色或浅色。所有绘制都补满整行，换行处重新打开背景色，
 * 避免主题的复位序列把背景清掉。
 */

import { backgroundAnsi, parseColor, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

/** 深色主题与浅色主题下块状背景的色值 */
const DARK_BLOCK = "#303030";
const LIGHT_BLOCK = "#ececec";

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

/** codex 的块背景色，跟随主题明暗 */
export function codexBlockAnsi(theme: Theme): string {
	const color = parseColor(theme.appearance === "light" ? LIGHT_BLOCK : DARK_BLOCK);
	return backgroundAnsi(color, theme.getColorMode());
}

/** 把一行铺成整行宽度的 codex 背景块 */
export function paintBlock(theme: Theme, text: string, width: number): string {
	const bg = codexBlockAnsi(theme);
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
