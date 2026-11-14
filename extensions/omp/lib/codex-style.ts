/**
 * codex 风格共用的背景绘制与行首标记。
 *
 * codex 的用户消息与输入框都铺一块中性灰背景，主题里的 userMessageBg 带蓝调，这里换成
 * 固定色值，并按主题明暗选择深色或浅色。用户消息与吸附条用亮一档的颜色，输入框稍暗，
 * 与 codex 的层次一致。所有绘制都补满整行，换行处重新打开背景色，避免主题的复位序列把背景清掉。
 */

import { backgroundAnsi, parseColor, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { markDegraded } from "./degrade.ts";

/** 块状背景的两种用途：用户消息（含吸附条）与输入框 */
export type CodexSurface = "message" | "editor";

/** 深色主题下块状背景的色值，与 codex 的 One Dark 配色一致 */
const DARK_MESSAGE = "#4b4d54";
const DARK_EDITOR = "#41454c";

/** 浅色主题下块状背景的色值，用户消息比输入框深一档 */
const LIGHT_MESSAGE = "#e2e2e2";
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

/** 按主题明暗与块的用途取色值 */
function surfaceColor(theme: Theme, surface: CodexSurface): string {
	if (theme.appearance === "light") {
		return surface === "editor" ? LIGHT_EDITOR : LIGHT_MESSAGE;
	}

	return surface === "editor" ? DARK_EDITOR : DARK_MESSAGE;
}

/** codex 的块背景色，跟随主题明暗与块的用途 */
export function codexSurfaceAnsi(theme: Theme, surface: CodexSurface = "message"): string {
	const color = parseColor(surfaceColor(theme, surface));
	return backgroundAnsi(color, theme.getColorMode());
}

/** 用户消息与吸附条的背景色 */
export function codexBlockAnsi(theme: Theme): string {
	return codexSurfaceAnsi(theme, "message");
}

/** 把一行铺成整行宽度的 codex 背景块 */
export function paintBlock(
	theme: Theme,
	text: string,
	width: number,
	surface: CodexSurface = "message",
): string {
	const bg = codexSurfaceAnsi(theme, surface);
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
