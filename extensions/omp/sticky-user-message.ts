/**
 * 整屏模式下把当前用户消息固定在 transcript 顶部。
 *
 * 当前用户消息的首行滚出视口顶部后，它的首行以同样的灰底固定在 transcript 顶部；首行还在视口里时
 * 让出这一行，避免与正文重复。点击吸附条回到这条消息的起始行。
 *
 * 吸附条靠改写布局根装上：把布局根里 transcript 那一项换成 VStack(吸附条, transcript)，
 * 吸附条只在需要时占一行。旧版本装过右侧刻度条的结构会被换成这个更简单的外层。
 *
 * 每条消息的起始行直接从布局帧里读：帧里带着滚动盒子这一帧渲染出的正文行，用户消息的首行由 Pi
 * 自己打了 OSC 133 提示符标记，本扩展把这个标记再加一个。行内叠了两份以上标记的就是用户消息，
 * 标记前面可能带着背景色序列，所以不能只看行首。依赖的内部事实有四件：
 *
 * - 布局根是 Stack，entries 与 children 同步，可以用 clear 与 addChild 重新排列；
 * - 布局节点用 Symbol.for 作键，本扩展导入的 pi-tui 建出来的 VStack 能被 Pi 自己的排版识别；
 * - TuiAltScreen.currentLayout 是最近一帧的排版结果，帧里的 scrollContentLines 就是那一帧的正文；
 * - 渲染时带头的 OSC 133 序列在写到屏幕上之前会被剥掉，重复一份不影响显示与排版宽度。
 *
 * 普通模式（transcript 在终端回滚区里）没有布局根，吸附条不出现。
 */

import {
	VStack,
	isViewportTUI,
	stripTerminalSequences,
	truncateToWidth,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentTheme, paintBlock } from "./lib/codex-style.ts";
import { loadBundle } from "./lib/pi-bundle.ts";

/** Pi 在用户消息与助手消息的首行都加这个标记，这里再给用户消息加一份用作区分 */
const OSC133_ZONE_START = "\x1b]133;A\x07";

/** 跨扩展重新加载共享的状态：包装好的布局根与吸附条组件都留在旧模块里 */
const STATE_KEY = Symbol.for("pi.ompi.user-rail");

/** 标记外层的 VStack，沿用旧版本刻度条外层用的键，重新加载时能认出旧结构 */
const WRAPPER_MARK = Symbol.for("pi.ompi.user-rail.sticky");

/** 旧版本装过的 HStack，重新加载时从这里取出 transcript */
const LEGACY_STACK_MARK = Symbol.for("pi.ompi.user-rail.stack");

/** 标记已经给用户消息补过首行标记的原型方法 */
const TURN_MARK_FLAG = Symbol.for("pi.ompi.user-rail.turn-mark");

/** 拿 TUI 引用用的空 widget，沿用旧键，重新加载时替换掉旧 widget */
const WIDGET_KEY = "ompi-user-rail";

type Rect = { x: number; y: number; width: number; height: number };

/** 布局帧里的一个盒子，只用到位置、子节点与这一帧的正文 */
type LayoutBox = {
	rect: Rect;
	children: LayoutBox[];
	scrollView?: unknown;
	scrollContentLines?: readonly string[];
};

type LayoutFrame = { root: LayoutBox };

/** 全屏 TUI 上与吸附条相关的部分 */
type StickyHost = TUI & {
	readonly currentLayout?: LayoutFrame;
	readonly layoutRoot?: StackLike;
};

/** 滚动视口，transcript 就是其中一个 */
type ScrollViewLike = {
	readonly scrollTop: number;
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
type StickyView = {
	frame: LayoutFrame;
	turns: Turn[];
	/** 这一帧的正文行，吸附条从这里取消息的首行 */
	lines: readonly string[];
};

/** 测量结果按帧缓存，同一帧里可见性判断与渲染共用一次遍历 */
type StickyCache = {
	frame: LayoutFrame;
	tui: StickyHost;
	transcript: ScrollViewLike;
	view: StickyView;
};

type StickyState = {
	tui: StickyHost | undefined;
	transcript: ScrollViewLike | undefined;
	/** 吸附条组件本身，扩展重新加载后继续复用 */
	sticky: Component | undefined;
	/** 吸附条当前指向的消息起始行，点击时用它跳转 */
	stickyTop: number | undefined;
	/** 最近一帧的测量结果 */
	view: StickyView | undefined;
	cache: StickyCache | undefined;
	/** 布局根的结构与预期不同，吸附条装不进去 */
	broken: boolean;
	notify: ((message: string, type?: "info" | "warning" | "error") => void) | undefined;
};

function stickyState(): StickyState {
	const existing = (globalThis as Record<symbol, StickyState | undefined>)[STATE_KEY];
	if (existing !== undefined) {
		return existing;
	}
	const created: StickyState = {
		tui: undefined,
		transcript: undefined,
		sticky: undefined,
		stickyTop: undefined,
		view: undefined,
		cache: undefined,
		broken: false,
		notify: undefined,
	};
	(globalThis as Record<symbol, StickyState | undefined>)[STATE_KEY] = created;
	return created;
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

/** 行内叠了两份以上 OSC 133 提示符标记的就是用户消息 */
function isUserTurn(line: string): boolean {
	return line.split(OSC133_ZONE_START).length > 2;
}

/** 在一帧的正文里按标记数量找用户消息 */
function collectTurns(lines: readonly string[]): Turn[] {
	const turns: Turn[] = [];
	for (let row = 0; row < lines.length; row++) {
		if (lines[row] !== undefined && isUserTurn(lines[row]!)) {
			turns.push({ top: row });
		}
	}
	return turns;
}

/** 视口顶行落在哪一条消息上；起始行在视口上方时由第一条顶上 */
function activeIndexOf(turns: Turn[], scrollTop: number): number {
	let active = 0;
	for (let index = 0; index < turns.length; index++) {
		if (turns[index]!.top <= scrollTop) {
			active = index;
		}
	}
	return active;
}

/** 测量当前帧：正文行与每条用户消息的起始行 */
function measure(state: StickyState): StickyView | undefined {
	const tui = state.tui;
	const transcript = state.transcript;
	if (tui === undefined || transcript === undefined) {
		return undefined;
	}
	const cache = state.cache;
	const reusable = cache !== undefined && cache.tui === tui && cache.transcript === transcript;
	const frame = tui.currentLayout;
	if (frame === undefined) {
		// Pi 强制重绘时会先把上一帧的排版结果清掉，这一帧沿用上一帧的测量
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
	const view: StickyView = {
		frame,
		turns: collectTurns(lines),
		lines,
	};
	state.cache = { frame, tui, transcript, view };
	return view;
}

/** 当前该吸附在顶部的用户消息；消息首行还在视口内时不吸附 */
function stickyTarget(state: StickyState): { turn: Turn; line: string } | undefined {
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
function messageFirstLine(view: StickyView, index: number): { row: number; line: string } {
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
 * 先把背景序列剥掉，再用当前宽度重新铺满。
 */
function createSticky(state: StickyState): Component {
	return {
		invalidate(): void {},

		render(width: number): string[] {
			const target = stickyTarget(state);
			if (target === undefined) {
				state.stickyTop = undefined;
				return [];
			}
			const line = target.line.replace(/\x1b\[48;[0-9;]*m/g, "").split("\x1b[49m").join("");
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

/** 递归取出一项组件里的 transcript；旧结构是 VStack(HStack(transcript, 刻度条)) */
function transcriptInside(component: Component): (Component & ScrollViewLike) | undefined {
	if (isTranscript(component)) {
		return component;
	}
	const marked = component as Component & {
		[WRAPPER_MARK]?: boolean;
		[LEGACY_STACK_MARK]?: boolean;
	};
	if (marked[WRAPPER_MARK] === true || marked[LEGACY_STACK_MARK] === true) {
		for (const entry of (component as unknown as StackLike).entries) {
			const transcript = transcriptInside(entry.component);
			if (transcript !== undefined) {
				return transcript;
			}
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

function failStructure(state: StickyState): void {
	state.broken = true;
	state.notify?.("布局根的结构与预期不同，用户消息吸附条未生效", "error");
}

/**
 * 把布局根里 transcript 那一项换成 VStack(吸附条, transcript)。
 *
 * 布局根除 transcript 之外的条目（输入区与页脚的容器）原样搬回来。旧版本装过的
 * VStack(HStack(transcript, 刻度条)) 会在这一步被换成新的结构，右侧刻度条随之去掉。
 */
function install(state: StickyState, tui: StickyHost, root: StackLike): void {
	const entries = [...root.entries];
	const index = entries.findIndex((entry) => transcriptInside(entry.component) !== undefined);
	if (index < 0) {
		failStructure(state);
		return;
	}
	const transcript = transcriptInside(entries[index]!.component)!;
	const sticky = state.sticky ?? createSticky(state);
	state.sticky = sticky;

	const outer = new VStack([
		{
			component: sticky,
			basis: "auto",
			grow: 0,
			shrink: 0,
			minSize: 0,
			visible: () => stickyTarget(state) !== undefined,
		},
		{ component: transcript as unknown as Component, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
	Object.defineProperty(outer, WRAPPER_MARK, { value: true });

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
	// 强制重绘会清掉当前排版帧，吸附条会因此闪一帧空白
	tui.requestRender();
}

/** 布局根里已经是当前结构时直接取回 transcript，避免每帧重建 */
function currentTranscript(root: StackLike, sticky: Component | undefined): (Component & ScrollViewLike) | undefined {
	if (sticky === undefined) {
		return undefined;
	}
	for (const entry of root.entries) {
		const marked = entry.component as Component & { [WRAPPER_MARK]?: boolean };
		if (marked[WRAPPER_MARK] !== true) {
			continue;
		}
		const wrapper = entry.component as unknown as StackLike;
		const [first, second] = wrapper.entries;
		if (wrapper.entries.length !== 2 || first?.component !== sticky) {
			continue;
		}
		if (second !== undefined && isTranscript(second.component)) {
			return second.component;
		}
	}
	return undefined;
}

/** 每帧检查布局根是否已经包装好；模式切换会换 TUI，布局根与吸附条还是同一个 */
function ensureInstalled(state: StickyState, tui: TUI): void {
	if (state.broken || !isViewportTUI(tui)) {
		return;
	}
	const host = tui as StickyHost;
	const root = host.layoutRoot;
	if (root === undefined || !Array.isArray(root.entries)) {
		return;
	}
	state.tui = host;
	const transcript = currentTranscript(root, state.sticky);
	if (transcript !== undefined) {
		state.transcript = transcript;
		return;
	}
	install(state, host, root);
}

export default function (pi: ExtensionAPI) {
	const state = stickyState();

	pi.on("session_start", async (_event, ctx) => {
		const bundle = await loadBundle();
		const userClass = bundle.UserMessageComponent as UserMessageClass | undefined;
		if (userClass === undefined) {
			throw new Error("打包入口里缺少 UserMessageComponent");
		}
		patchUserMessage(userClass);
		state.cache = undefined;
		state.view = undefined;
		state.stickyTop = undefined;
		// 重新创建吸附条，扩展重新加载后能用上新的配色
		state.sticky = undefined;
		state.broken = false;
		state.notify = (message, type) => ctx.ui.notify(message, type);

		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui) => ({
				invalidate(): void {},
				render(): string[] {
					// 每帧都会走到这里，正好用来在布局根建立之后装吸附条
					ensureInstalled(state, tui);
					return [];
				},
			}),
			{ placement: "aboveEditor" },
		);
	});
}
