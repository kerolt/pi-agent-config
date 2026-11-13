/**
 * 整屏模式下 transcript 的用户消息导航。
 *
 * 参考 dsh-tui 的 turn navigator：右侧留出两列，每条用户消息一个刻度，刻度位置只表示会话顺序，
 * 不按滚动比例伸缩。占据视口顶行的那条消息显示为 `━━`，其余显示为 ` ─`。刻度列上下各有一个
 * ` ▴` 与 ` ▾`，分别跳到视口上方最近、视口下方最近且滚得到的那条消息。点击刻度按内容行号跳转，
 * 目标消息落到视口顶部。
 *
 * 当前用户消息滚出视口顶部后，它的首行以同样的灰底固定在 transcript 顶部，点击回到这条消息的
 * 起始行。吸附条只在需要时占一行，其余时候让出整行给正文。
 *
 * 刻度条与吸附条靠改写布局根装上：把布局根里 transcript 那一项换成
 * VStack(吸附条, HStack(transcript, 刻度条))，正文因此让出两列，不会被刻度条覆盖。
 *
 * 每条消息的起始行直接从布局帧里读，不需要自己再排一遍：帧里带着滚动盒子这一帧渲染出的正文行，
 * 用户消息的首行由 Pi 自己打了 OSC 133 提示符标记，本扩展把这个标记再加一个，扫描行首就能
 * 把用户消息与同样带标记的助手消息区分开。依赖的内部事实有四件：
 *
 * - 布局根是 Stack，entries 与 children 同步，可以用 clear 与 addChild 重新排列；
 * - 布局节点用 Symbol.for 作键，本扩展导入的 pi-tui 建出来的 VStack 与 HStack 能被 Pi 自己的排版识别；
 * - TuiAltScreen.currentLayout 是最近一帧的排版结果，帧里的 scrollContentLines 就是那一帧的正文；
 * - 渲染时带头的 OSC 133 序列在写到屏幕上之前会被剥掉，重复一份不影响显示与排版宽度。
 *
 * 普通模式（transcript 在终端回滚区里）没有布局根，刻度条与吸附条都不出现。
 */

import {
	HStack,
	Key,
	VStack,
	isViewportTUI,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { paintBlock } from "./lib/codex-style.ts";
import { loadBundle } from "./lib/pi-bundle.ts";

/** 刻度条占用的列数，等于最宽刻度的宽度 */
const RAIL_WIDTH = 2;
/** 终端窄于这个宽度时收起刻度条，把列还给正文 */
const MIN_TERMINAL_WIDTH = 60;
/** 少于这么多条用户消息时刻度条没有意义 */
const MIN_TURNS = 2;
/** 视口不足这么多行时放不下刻度加两个箭头 */
const MIN_VIEWPORT_ROWS = 3;

/** Pi 在用户消息与助手消息的首行都加这个标记，这里再给用户消息加一份用作区分 */
const OSC133_ZONE_START = "\x1b]133;A\x07";
const USER_TURN_MARK = OSC133_ZONE_START + OSC133_ZONE_START;

/** 刻度字形，可见宽度都等于 RAIL_WIDTH */
const TICK_ACTIVE = "━━";
const TICK_IDLE = " ─";
const CHEVRON_UP = " ▴";
const CHEVRON_DOWN = " ▾";

/** 拿 TUI 引用用的空 widget */
const WIDGET_KEY = "ompi-user-rail";

/** Pi 把当前主题放在这个全局符号下，刻度条不经过渲染器回调，只能从这里取色 */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

/** 跨扩展重新加载共享的状态：包装好的布局根与刻度条组件都留在旧模块里 */
const STATE_KEY = Symbol.for("pi.ompi.user-rail");

/** 标记已经包装过的 HStack，避免重复包装 */
const STACK_MARK = Symbol.for("pi.ompi.user-rail.stack");

/** 标记外层的 VStack，吸附条与刻度条都装在里面 */
const STICKY_MARK = Symbol.for("pi.ompi.user-rail.sticky");

/** 标记已经给用户消息补过首行标记的原型方法 */
const TURN_MARK_FLAG = Symbol.for("pi.ompi.user-rail.turn-mark");

type Rect = { x: number; y: number; width: number; height: number };

/** 布局帧里的一个盒子，只用到位置、子节点、滚动视口与这一帧的正文 */
type LayoutBox = {
	rect: Rect;
	children: LayoutBox[];
	scrollView?: unknown;
	scrollContentLines?: readonly string[];
};

type LayoutFrame = { root: LayoutBox };

/** 全屏 TUI 上与刻度条相关的部分 */
type RailHost = TUI & {
	readonly currentLayout?: LayoutFrame;
	readonly layoutRoot?: StackLike;
};

/** 滚动视口，transcript 就是其中一个 */
type ScrollViewLike = {
	readonly scrollTop: number;
	readonly isFollowingEnd: boolean;
	scrollTo(row: number): void;
};

/** Stack 的条目与本扩展用到的排列操作 */
type StackEntryLike = {
	component: Component;
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
	maxSize?: number;
	visible?: (viewport: { width: number; height: number }) => boolean;
};

type StackLike = {
	entries: StackEntryLike[];
	clear(): void;
	addChild(component: Component, options?: Omit<StackEntryLike, "component">): void;
};

/** 打包产物里的用户消息组件类 */
type UserMessageClass = {
	new (...args: never[]): object;
	prototype: { render: (width: number) => string[] };
};

/** 一条用户消息在文档里的起始行 */
type Turn = { top: number };

/** 一帧之内需要用到的全部测量结果 */
type RailView = {
	frame: LayoutFrame;
	turns: Turn[];
	/** 这一帧的正文行，吸附条从这里取消息的首行 */
	lines: readonly string[];
	/** 视口高度 */
	viewportRows: number;
	/** 文档总高度 */
	contentHeight: number;
};

/** 测量结果按帧缓存，同一帧里可见性判断与渲染共用一次遍历 */
type RailCache = {
	frame: LayoutFrame;
	tui: RailHost;
	transcript: ScrollViewLike;
	view: RailView;
};

/** 刻度列的行布局，渲染与点击共用同一份结果 */
type RailGeometry = {
	windowStart: number;
	windowEnd: number;
	upRow: number;
	tickTop: number;
	downRow: number;
	activeIndex: number;
	upIndex: number | undefined;
	downIndex: number | undefined;
};

type RailState = {
	tui: RailHost | undefined;
	transcript: ScrollViewLike | undefined;
	/** 刻度条组件本身，扩展重新加载后继续复用 */
	rail: Component | undefined;
	/** 吸附条组件本身，扩展重新加载后继续复用 */
	sticky: Component | undefined;
	/** 吸附条当前指向的消息起始行，点击时用它跳转 */
	stickyTop: number | undefined;
	/** 最近一帧的测量结果与刻度布局，点击时按它们算目标行 */
	view: RailView | undefined;
	geometry: RailGeometry | undefined;
	cache: RailCache | undefined;
	/** 显示开关，只在本次进程内有效 */
	enabled: boolean;
	/** 布局根的结构与预期不同，刻度条装不进去 */
	broken: boolean;
	notify: ((message: string, type?: "info" | "warning" | "error") => void) | undefined;
};

function railState(): RailState {
	const existing = (globalThis as Record<symbol, RailState | undefined>)[STATE_KEY];
	if (existing !== undefined) {
		return existing;
	}
	const created: RailState = {
		tui: undefined,
		transcript: undefined,
		rail: undefined,
		sticky: undefined,
		stickyTop: undefined,
		view: undefined,
		geometry: undefined,
		cache: undefined,
		enabled: true,
		broken: false,
		notify: undefined,
	};
	(globalThis as Record<symbol, RailState | undefined>)[STATE_KEY] = created;
	return created;
}

function currentTheme(): Theme {
	const theme = (globalThis as Record<symbol, Theme | undefined>)[THEME_KEY];
	if (theme === undefined) {
		throw new Error("主题尚未初始化，用户消息刻度条无法取色");
	}
	return theme;
}

/** 布局根里标了 primary 的滚动视口就是 transcript */
function isTranscript(component: Component): component is Component & ScrollViewLike {
	const candidate = component as Partial<ScrollViewLike> & { primary?: boolean };
	return candidate.primary === true && typeof candidate.scrollTo === "function";
}

/** 在布局帧里找 transcript 的滚动盒子 */
function findScrollBox(box: LayoutBox, transcript: ScrollViewLike): LayoutBox | undefined {
	if (box.scrollView === transcript) {
		return box;
	}
	for (const child of box.children) {
		const found = findScrollBox(child, transcript);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

/**
 * 给用户消息的首行再加一个同样的 OSC 133 标记。
 *
 * 助手消息不带工具调用时首行也有一个，两份标记叠在一起的就是用户消息。首行开头的 OSC 133 序列
 * 会在写到屏幕上之前被整体剥掉，重复一份不影响显示，也不占可见宽度。
 */
function patchUserMessage(userClass: UserMessageClass): void {
	const prototype = userClass.prototype;
	if (Object.prototype.hasOwnProperty.call(prototype, TURN_MARK_FLAG)) {
		return;
	}
	const originalRender = prototype.render;
	const patchedRender = function (this: object, width: number): string[] {
		const lines = originalRender.call(this, width);
		if (lines.length > 0) {
			lines[0] = OSC133_ZONE_START + lines[0]!;
		}
		return lines;
	};
	Object.defineProperty(prototype, TURN_MARK_FLAG, { value: true });
	prototype.render = patchedRender;
}

/** 在一帧的正文里按行首标记找用户消息 */
function collectTurns(lines: readonly string[]): Turn[] {
	const turns: Turn[] = [];
	for (let row = 0; row < lines.length; row++) {
		if (lines[row]?.startsWith(USER_TURN_MARK) === true) {
			turns.push({ top: row });
		}
	}
	return turns;
}

/** 占据视口顶行的那条消息；起始行在视口上方时由第一条顶上 */
function activeIndexOf(turns: Turn[], scrollTop: number): number {
	let active = 0;
	for (let index = 0; index < turns.length; index++) {
		if (turns[index]!.top <= scrollTop) {
			active = index;
		}
	}
	return active;
}

/** 视口上方最近的一条 */
function upIndexOf(turns: Turn[], scrollTop: number): number | undefined {
	let target: number | undefined;
	for (let index = 0; index < turns.length; index++) {
		if (turns[index]!.top < scrollTop) {
			target = index;
		}
	}
	return target;
}

/** 视口下方最近且滚得到的一条：超过最大滚动位置的消息落不到视口顶行 */
function downIndexOf(turns: Turn[], scrollTop: number, maxScroll: number): number | undefined {
	for (let index = 0; index < turns.length; index++) {
		const top = turns[index]!.top;
		if (top > scrollTop && top <= maxScroll) {
			return index;
		}
	}
	return undefined;
}

/** 测量当前帧：正文总行数、视口行数与每条用户消息的起始行 */
function measure(state: RailState): RailView | undefined {
	const tui = state.tui;
	const transcript = state.transcript;
	if (tui === undefined || transcript === undefined) {
		return undefined;
	}
	const cache = state.cache;
	const reusable = cache !== undefined && cache.tui === tui && cache.transcript === transcript;
	const frame = tui.currentLayout;
	if (frame === undefined) {
		// Pi 强制重绘时会先把上一帧的排版结果清掉，这一帧沿用上一帧的测量，
		// 否则刻度条会闪一帧空白、正文跟着变宽一次
		return reusable ? cache.view : undefined;
	}
	if (reusable && cache.frame === frame) {
		return cache.view;
	}
	const scrollBox = findScrollBox(frame.root, transcript);
	const lines = scrollBox?.scrollContentLines;
	if (scrollBox === undefined || lines === undefined) {
		return undefined;
	}
	const view: RailView = {
		frame,
		turns: collectTurns(lines),
		lines,
		viewportRows: Math.max(0, Math.floor(scrollBox.rect.height)),
		contentHeight: lines.length,
	};
	state.cache = { frame, tui, transcript, view };
	return view;
}

/** 刻度条是否该出现：宽度、消息条数、视口行数与内容是否超出视口 */
function railEligible(state: RailState, view: RailView, terminalWidth: number): boolean {
	return (
		state.enabled &&
		terminalWidth >= MIN_TERMINAL_WIDTH &&
		view.turns.length >= MIN_TURNS &&
		view.viewportRows >= MIN_VIEWPORT_ROWS &&
		view.contentHeight > view.viewportRows
	);
}

/**
 * 刻度列的窗口：消息多到放不下时按当前阅读位置滑动，滚到底时贴着末尾，
 * 任何情况下都不把当前那条挤出窗口，否则没有刻度会被点亮。
 */
function computeGeometry(
	turnCount: number,
	viewportRows: number,
	activeIndex: number,
	upIndex: number | undefined,
	downIndex: number | undefined,
	atBottom: boolean,
): RailGeometry | undefined {
	const maxTicks = viewportRows - 2;
	if (turnCount < MIN_TURNS || maxTicks < 1) {
		return undefined;
	}
	let windowStart = 0;
	if (turnCount > maxTicks) {
		const tailStart = turnCount - maxTicks;
		windowStart = atBottom
			? Math.min(activeIndex, tailStart)
			: Math.min(Math.max(0, activeIndex - Math.floor(maxTicks / 2)), tailStart);
	}
	const shown = Math.min(turnCount, maxTicks);
	// 上箭头、刻度、下箭头作为一整块在列内垂直居中
	const blockTop = Math.max(0, Math.floor((viewportRows - (shown + 2)) / 2));
	return {
		windowStart,
		windowEnd: windowStart + shown,
		upRow: blockTop,
		tickTop: blockTop + 1,
		downRow: blockTop + 1 + shown,
		activeIndex,
		upIndex,
		downIndex,
	};
}

/** 点击落在哪一段上，整列宽度都是可点区域 */
function hitTest(
	geometry: RailGeometry,
	row: number,
): { kind: "up" } | { kind: "down" } | { kind: "tick"; index: number } | undefined {
	if (row === geometry.upRow) {
		return { kind: "up" };
	}
	if (row === geometry.downRow) {
		return { kind: "down" };
	}
	if (row >= geometry.tickTop) {
		const offset = row - geometry.tickTop;
		if (offset < geometry.windowEnd - geometry.windowStart) {
			return { kind: "tick", index: geometry.windowStart + offset };
		}
	}
	return undefined;
}

/** 一格定宽的内容，余下的列补空格，避免上一帧的字形残留 */
function railCell(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** 把目标消息滚到视口顶行 */
function jumpTo(state: RailState, index: number): void {
	const transcript = state.transcript;
	const turn = state.view?.turns[index];
	if (transcript === undefined || turn === undefined) {
		return;
	}
	transcript.scrollTo(turn.top);
	state.tui?.requestRender();
}

function createRail(state: RailState): Component {
	return {
		invalidate(): void {},

		render(width: number): string[] {
			const view = measure(state);
			const transcript = state.transcript;
			if (view === undefined || transcript === undefined) {
				state.view = undefined;
				state.geometry = undefined;
				return [];
			}
			state.view = view;
			if (!railEligible(state, view, view.frame.root.rect.width)) {
				state.geometry = undefined;
				return [];
			}
			const scrollTop = transcript.scrollTop;
			const maxScroll = Math.max(0, view.contentHeight - view.viewportRows);
			const activeIndex = activeIndexOf(view.turns, scrollTop);
			const geometry = computeGeometry(
				view.turns.length,
				view.viewportRows,
				activeIndex,
				upIndexOf(view.turns, scrollTop),
				downIndexOf(view.turns, scrollTop, maxScroll),
				transcript.isFollowingEnd || scrollTop >= maxScroll,
			);
			state.geometry = geometry;
			if (geometry === undefined) {
				return [];
			}

			const theme = currentTheme();
			const lines: string[] = [];
			for (let row = 0; row < view.viewportRows; row++) {
				lines.push(" ".repeat(width));
			}
			const set = (row: number, text: string): void => {
				if (row >= 0 && row < lines.length) {
					lines[row] = railCell(text, width);
				}
			};
			set(geometry.upRow, theme.fg(geometry.upIndex === undefined ? "dim" : "muted", CHEVRON_UP));
			for (let row = geometry.tickTop; row < geometry.downRow; row++) {
				const active = geometry.windowStart + (row - geometry.tickTop) === activeIndex;
				set(row, theme.fg(active ? "accent" : "dim", active ? TICK_ACTIVE : TICK_IDLE));
			}
			set(geometry.downRow, theme.fg(geometry.downIndex === undefined ? "dim" : "muted", CHEVRON_DOWN));
			return lines;
		},

		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			const geometry = state.geometry;
			if (event.button !== "left" || event.type !== "click" || geometry === undefined) {
				return undefined;
			}
			const hit = hitTest(geometry, event.y);
			if (hit === undefined) {
				return undefined;
			}
			const index = hit.kind === "up" ? geometry.upIndex : hit.kind === "down" ? geometry.downIndex : hit.index;
			// 没有目标的箭头是个空操作，点击已经吃掉，不再往下传给文本选择
			if (index === undefined) {
				return { handled: true };
			}
			jumpTo(state, index);
			return { handled: true, render: true };
		},
	};
}

/** 当前该吸附在顶部的用户消息；消息首行还在视口内时不吸附 */
function stickyTarget(state: RailState): { turn: Turn; line: string } | undefined {
	const view = measure(state);
	const transcript = state.transcript;
	if (view === undefined || transcript === undefined) {
		return undefined;
	}
	const scrollTop = transcript.scrollTop;
	const index = activeIndexOf(view.turns, scrollTop);
	const turn = view.turns[index];
	if (turn === undefined) {
		return undefined;
	}
	const first = messageFirstLine(view, index);
	// 首行本身还在视口里时不重复画一块吸附条
	if (first.row >= scrollTop) {
		return undefined;
	}
	return { turn, line: first.line };
}

/** 一条用户消息的第一条非空行，吸附条直接复用它的配色与提示符 */
function messageFirstLine(view: RailView, index: number): { row: number; line: string } {
	const start = view.turns[index]?.top ?? 0;
	const end = view.turns[index + 1]?.top ?? view.lines.length;
	for (let row = start; row < end; row++) {
		const line = view.lines[row];
		if (line !== undefined && stripTerminalSequences(line).trim() !== "") {
			return { row, line };
		}
	}
	return { row: start, line: view.lines[start] ?? "" };
}

/**
 * 吸附条：把用户消息的首行按当前宽度重新铺成灰底。
 * 这一行原本按 transcript 的宽度画好，带着自己的背景与行尾复位；
 * 先剥掉这些，再用当前宽度重新铺满。
 */
function createSticky(state: RailState): Component {
	return {
		invalidate(): void {},

		render(width: number): string[] {
			const target = stickyTarget(state);
			if (target === undefined) {
				state.stickyTop = undefined;
				return [];
			}
			const line = target.line.split("\x1b[49m").join("");
			const text = truncateToWidth(line, width, "…").replace(/ +$/, "");
			state.stickyTop = target.turn.top;
			return [paintBlock(currentTheme(), text, width)];
		},

		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			const top = state.stickyTop;
			if (top === undefined || event.button !== "left" || event.type !== "click") {
				return undefined;
			}
			state.transcript?.scrollTo(top);
			state.tui?.requestRender();
			return { handled: true, render: true };
		},
	};
}

/** 把 transcript 与刻度条并排成一个 HStack */
function createTranscriptStack(state: RailState, transcript: ScrollViewLike, rail: Component): StackLike {
	const stack = new HStack([
		{ component: transcript as unknown as Component, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{
			component: rail,
			basis: RAIL_WIDTH,
			grow: 0,
			shrink: 0,
			minSize: 0,
			visible: (viewport) => {
				const view = measure(state);
				return view !== undefined && railEligible(state, view, viewport.width);
			},
		},
	]);
	Object.defineProperty(stack, STACK_MARK, { value: true });
	return stack as unknown as StackLike;
}

/** 已经装好的包装结构：外层 VStack 或早期版本留下的 HStack */
type WrappedTranscript = {
	hstack: StackLike;
	transcript: Component & ScrollViewLike;
	outer: boolean;
};

/** 从一项组件里认出包装结构 */
function findWrap(component: Component): WrappedTranscript | undefined {
	const marked = component as Component & { [STICKY_MARK]?: boolean; [STACK_MARK]?: boolean };
	if (marked[STICKY_MARK] === true) {
		const inner = (component as unknown as StackLike).entries.find(
			(entry) => (entry.component as Component & { [STACK_MARK]?: boolean })[STACK_MARK] === true,
		);
		const wrapped = inner === undefined ? undefined : findWrap(inner.component);
		return wrapped === undefined ? undefined : { ...wrapped, outer: true };
	}
	if (marked[STACK_MARK] === true) {
		const stack = component as unknown as StackLike;
		const transcript = stack.entries[0]?.component;
		if (transcript === undefined || !isTranscript(transcript)) {
			return undefined;
		}
		return { hstack: stack, transcript, outer: false };
	}
	return undefined;
}

/** 在布局根里找已经包装过的那一项 */
function findWrapped(root: StackLike): WrappedTranscript | undefined {
	for (const entry of root.entries) {
		const wrapped = findWrap(entry.component);
		if (wrapped !== undefined) {
			return wrapped;
		}
	}
	return undefined;
}

/** 复制条目原有的尺寸约束，重新排列时保持各行的伸缩行为 */
function entryOptions(entry: StackEntryLike): Omit<StackEntryLike, "component"> {
	return {
		basis: entry.basis,
		grow: entry.grow,
		shrink: entry.shrink,
		minSize: entry.minSize,
		maxSize: entry.maxSize,
		visible: entry.visible,
	};
}

function failStructure(state: RailState): void {
	state.broken = true;
	state.notify?.("布局根的结构与预期不同，用户消息刻度条与吸附条未生效", "error");
}

/**
 * 把布局根里 transcript 那一项换成 VStack(吸附条, HStack(transcript, 刻度条))。
 *
 * 布局根除 transcript 之外的条目（输入区与页脚的容器）原样搬回来。包装完成后 Pi 按新的布局
 * 帧排版，正文少两列，滚动、选择与滚轮都不受影响。已经装过 HStack 的旧结构只补上外层 VStack。
 */
function install(state: RailState, tui: RailHost, root: StackLike): void {
	const entries = [...root.entries];
	const index = entries.findIndex((entry) => isTranscript(entry.component) || findWrap(entry.component) !== undefined);
	if (index < 0) {
		failStructure(state);
		return;
	}
	const current = entries[index]!;
	const existing = findWrap(current.component);
	const transcript = existing?.transcript ?? (current.component as Component & ScrollViewLike);
	const rail = state.rail ?? createRail(state);
	state.rail = rail;
	const sticky = state.sticky ?? createSticky(state);
	state.sticky = sticky;

	if (existing?.outer === true) {
		state.transcript = transcript;
		return;
	}

	const hstack = existing?.hstack ?? createTranscriptStack(state, transcript, rail);
	const outer = new VStack([
		{
			component: sticky,
			basis: "auto",
			grow: 0,
			shrink: 0,
			minSize: 0,
			visible: () => stickyTarget(state) !== undefined,
		},
		{ component: hstack as unknown as Component, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
	Object.defineProperty(outer, STICKY_MARK, { value: true });

	root.clear();
	entries.forEach((entry, position) => {
		if (position === index) {
			root.addChild(outer, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
			return;
		}
		root.addChild(entry.component, entryOptions(entry));
	});

	state.transcript = transcript;
	state.cache = undefined;
	// 强制重绘会清掉当前排版帧，刻度条会因此闪一帧空列
	tui.requestRender();
}

/** 每帧检查布局根是否已经包装好；模式切换会换 TUI，布局根与刻度条还是同一个 */
function ensureInstalled(state: RailState, tui: TUI): void {
	if (state.broken || !isViewportTUI(tui)) {
		return;
	}
	const host = tui as RailHost;
	const root = host.layoutRoot;
	if (root === undefined || !Array.isArray(root.entries)) {
		return;
	}
	state.tui = host;
	const wrapped = findWrapped(root);
	if (wrapped !== undefined) {
		state.transcript = wrapped.transcript;
		// 旧版本只装了 HStack，补上吸附条
		if (!wrapped.outer) {
			install(state, host, root);
		}
		return;
	}
	install(state, host, root);
}

function toggleRail(state: RailState, ctx: ExtensionContext): void {
	state.enabled = !state.enabled;
	state.geometry = undefined;
	state.tui?.requestRender();
	ctx.ui.notify(state.enabled ? "User message rail: on" : "User message rail: off");
}

export default function (pi: ExtensionAPI) {
	const state = railState();

	pi.registerCommand("user-rail", {
		description: "显示或隐藏右侧的用户消息刻度条",
		handler: async (_args, ctx) => {
			toggleRail(state, ctx);
		},
	});

	pi.registerShortcut(Key.ctrlShift("r"), {
		description: "显示或隐藏右侧的用户消息刻度条",
		handler: (ctx) => {
			toggleRail(state, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const bundle = await loadBundle();
		const userClass = bundle.UserMessageComponent as UserMessageClass | undefined;
		if (userClass === undefined) {
			throw new Error("打包入口里缺少 UserMessageComponent");
		}
		patchUserMessage(userClass);
		state.cache = undefined;
		state.view = undefined;
		state.geometry = undefined;
		state.stickyTop = undefined;
		state.notify = (message, type) => ctx.ui.notify(message, type);

		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui) => ({
				invalidate(): void {},
				render(): string[] {
					// 每帧都会走到这里，正好用来在布局根建立之后装刻度条
					ensureInstalled(state, tui);
					return [];
				},
			}),
			{ placement: "aboveEditor" },
		);
	});
}
