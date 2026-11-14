/**
 * 整屏模式下把当前用户消息固定在 transcript 顶部。
 * 消息位置由原生组件与排版行数计算，首条正文滚出视口后显示吸附条，点击返回消息起始行。
 * 布局根中的 transcript 由 VStack(吸附条, transcript) 承载。
 */

import {
	VStack,
	isViewportTUI,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { paintBlock, tryCurrentTheme } from "../lib/codex-style.ts";
import { markDegraded } from "../lib/degrade.ts";
import {
	loadTranscriptLayout,
	type TranscriptLayoutFrame,
	type TranscriptLayoutReader,
	type TranscriptScrollView,
	type UserMessageRange,
} from "../lib/transcript-layout.ts";

const STATE_KEY = Symbol.for("pi.ompi.user-rail");
const WRAPPER_MARK = Symbol.for("pi.ompi.user-rail.sticky");
const WIDGET_KEY = "ompi-user-rail";

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

type StickyHost = TUI & {
	readonly currentLayout?: TranscriptLayoutFrame;
	readonly layoutRoot?: StackLike;
};

type StickyCache = {
	frame: TranscriptLayoutFrame;
	tui: StickyHost;
	transcript: TranscriptScrollView;
	ranges: UserMessageRange[];
};

type StickyState = {
	tui: StickyHost | undefined;
	transcript: TranscriptScrollView | undefined;
	sticky: Component | undefined;
	stickyTop: number | undefined;
	readRanges: TranscriptLayoutReader | undefined;
	cache: StickyCache | undefined;
};

function stickyState(): StickyState {
	const shared = globalThis as Record<symbol, StickyState | undefined>;
	const existing = shared[STATE_KEY];
	if (existing !== undefined) {
		return existing;
	}

	const created: StickyState = {
		tui: undefined,
		transcript: undefined,
		sticky: undefined,
		stickyTop: undefined,
		readRanges: undefined,
		cache: undefined,
	};

	shared[STATE_KEY] = created;
	return created;
}

function isTranscript(component: Component): component is TranscriptScrollView {
	const candidate = component as Partial<TranscriptScrollView> & { primary?: boolean };
	return candidate.primary === true && typeof candidate.scrollTo === "function";
}

/** 同一布局帧中的可见性判断与吸附条渲染共用一份位置记录。 */
function measure(state: StickyState): UserMessageRange[] | undefined {
	const { tui, transcript, readRanges, cache } = state;
	if (tui === undefined || transcript === undefined || readRanges === undefined) {
		return undefined;
	}

	const reusable = cache !== undefined && cache.tui === tui && cache.transcript === transcript;
	const frame = tui.currentLayout;
	if (frame === undefined) {
		// 强制重绘会暂时清除布局帧，当前组件仍然使用上一帧的位置。
		return reusable ? cache.ranges : undefined;
	}
	if (reusable && cache.frame === frame) {
		return cache.ranges;
	}

	const ranges = readRanges(frame, transcript);
	if (ranges === undefined) {
		return undefined;
	}

	state.cache = { frame, tui, transcript, ranges };
	return ranges;
}

function stickyTarget(state: StickyState): UserMessageRange | undefined {
	const ranges = measure(state);
	const transcript = state.transcript;
	if (ranges === undefined || transcript === undefined) {
		return undefined;
	}

	// 定位起始行不大于 scrollTop 的最后一条用户消息。
	const scrollTop = transcript.scrollTop;
	let low = 0;
	let high = ranges.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (ranges[middle]!.startRow <= scrollTop) {
			low = middle + 1;
		}
		else {
			high = middle - 1;
		}
	}

	const target = ranges[high];
	return target !== undefined && target.firstTextRow < scrollTop ? target : undefined;
}

function createSticky(state: StickyState): Component {
	return {
		invalidate(): void {},

		render(width: number): string[] {
			const target = stickyTarget(state);
			if (target === undefined || width <= 0) {
				state.stickyTop = undefined;
				return [];
			}

			const theme = tryCurrentTheme();
			if (theme === undefined) {
				state.stickyTop = undefined;
				return [];
			}
			let text = theme.fg("userMessageText", target.preview);
			if (target.hasMore || visibleWidth(text) > width) {
				text = truncateToWidth(text, Math.max(0, width - 1), "") + theme.fg("userMessageText", "…");
			}

			// 点击返回消息块起始行，预览使用首条正文。
			state.stickyTop = target.startRow;
			return [paintBlock(theme, text, width)];
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

/** 从本扩展的外层容器中取回 transcript，重新加载后继续使用同一个滚动视口。 */
function transcriptInside(component: Component): TranscriptScrollView | undefined {
	if (isTranscript(component)) {
		return component;
	}

	const marked = component as Component & { [WRAPPER_MARK]?: boolean };
	if (marked[WRAPPER_MARK] === true) {
		for (const entry of (component as unknown as StackLike).entries) {
			const transcript = transcriptInside(entry.component);
			if (transcript !== undefined) {
				return transcript;
			}
		}
	}

	return undefined;
}

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

function install(state: StickyState, tui: StickyHost, root: StackLike): boolean {
	const entries = [...root.entries];
	const index = entries.findIndex((entry) => transcriptInside(entry.component) !== undefined);
	if (index < 0) {
		markDegraded("布局根中没有 primary transcript");
		return false;
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
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
	Object.defineProperty(outer, WRAPPER_MARK, { value: true });

	// 保留各条目的组件和尺寸约束，替换 transcript 外层的布局。
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

	tui.requestRender();
	return true;
}

function currentTranscript(root: StackLike, sticky: Component | undefined): TranscriptScrollView | undefined {
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
		if (wrapper.entries.length === 2 && first?.component === sticky && second !== undefined && isTranscript(second.component)) {
			return second.component;
		}
	}

	return undefined;
}

function ensureInstalled(state: StickyState, tui: TUI): void {
	if (!isViewportTUI(tui)) {
		return;
	}

	const host = tui as StickyHost;
	const root = host.layoutRoot;
	if (root === undefined) {
		return;
	}
	if (!Array.isArray(root.entries)) {
		markDegraded("布局根没有 Stack entries");
		return;
	}
	if (typeof root.clear !== "function" || typeof root.addChild !== "function") {
		markDegraded("布局根缺少 clear/addChild");
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
		// 共享状态跨重新加载保留，当前会话重新建立布局引用。
		state.tui = undefined;
		state.transcript = undefined;
		state.cache = undefined;
		state.stickyTop = undefined;
		state.sticky = undefined;
		state.readRanges = undefined;

		if (!ctx.hasUI) {
			return;
		}

		state.readRanges = await loadTranscriptLayout();
		if (state.readRanges === undefined) {
			return;
		}

		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui) => ({
				invalidate(): void {},
				render(): string[] {
					// 布局根在 UI 初始化后建立，widget 负责确认安装状态。
					ensureInstalled(state, tui);
					return [];
				},
			}),
			{ placement: "aboveEditor" },
		);
	});
}
