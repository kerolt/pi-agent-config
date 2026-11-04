/**
 * 回合结束后把工具执行与思考收成一块汇总行。
 *
 * 一轮对话进行中，工具行与思考块照常显示；这一轮结束时把本轮的工具行与思考收起来，
 * 在原位插入一行汇总，例如 `▸ 3 次工具调用 · 2 段思考`。点击汇总行就地展开整轮内容，
 * 再点收起；展开后单条工具行仍然可以点击看自己的输出。
 *
 * 工具行靠 ToolExecutionComponent.render 返回空数组收起；思考块靠 AssistantMessageComponent
 * 的隐藏开关加空标签收起，并在 updateContent 上补一层，Pi 自己切换思考可见性时不会翻回来。
 *
 * 回合边界：`agent_end` 收尾当前回合；重新载入会话时 replay 没有事件，回放结束后补一次收尾，
 * 所以最近一轮也是折叠的，下一次交互前就位。
 *
 * /tool-activity 命令与 ctrl+shift+o 快捷键把所有汇总行整体展开或收起。
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import { loadBundle } from "../lib/pi-bundle.ts";

/** 打补丁的标记，避免重复包装同一批方法 */
const TOOL_PATCH_FLAG = Symbol.for("pi.ompi.turn-summary.tool");
const ASSISTANT_PATCH_FLAG = Symbol.for("pi.ompi.turn-summary.assistant");
const CONTAINER_PATCH_FLAG = Symbol.for("pi.ompi.turn-summary.container");
const RENDER_PATCH_FLAG = Symbol.for("pi.ompi.turn-summary.render");

/** 跨扩展重新加载共享的状态：原型上的补丁还在，记录不能留在旧模块里 */
const STATE_KEY = Symbol.for("pi.ompi.turn-summary");

/** 拿 TUI 引用用的空 widget */
const SCROLL_WIDGET_KEY = "ompi-turn-summary-scroll";

/** Pi 把当前主题放在这个全局符号下，汇总行不经过渲染器回调，只能从这里取色 */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

type ToolRow = { render: (width: number) => string[] };

type ToolRowClass = {
	new (...args: unknown[]): ToolRow;
	prototype: ToolRow & { [TOOL_PATCH_FLAG]?: boolean };
};

type MessagePart = { type: string; thinking?: string };

type AssistantRow = {
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	lastMessage?: { content?: MessagePart[] };
	/** 逐段思考的临时可见性，Pi 点击思考块时写入 */
	thinkingVisibilityOverrides?: Map<number, boolean>;
	setHideThinkingBlock: (hide: boolean) => void;
	setHiddenThinkingLabel: (label: string) => void;
	updateContent: (message: unknown, isStreaming?: boolean) => void;
};

type AssistantClass = {
	new (...args: unknown[]): AssistantRow;
	prototype: AssistantRow & { [ASSISTANT_PATCH_FLAG]?: boolean };
};

type UserRowClass = { new (...args: unknown[]): object };

type ContainerLike = { children: unknown[]; render: (width: number) => string[] };

type ContainerClass = {
	prototype: ContainerLike & {
		addChild: (this: ContainerLike, child: unknown) => void;
		render: (this: ContainerLike, width: number) => string[];
		[CONTAINER_PATCH_FLAG]?: boolean;
		[RENDER_PATCH_FLAG]?: boolean;
	};
};

/** 插进 transcript 的汇总行 */
type SummaryComponent = {
	render: (width: number) => string[];
	invalidate: () => void;
	handleMouse: (event: TuiMouseEvent) => unknown;
};

/** 一个已经收尾的回合 */
type Turn = {
	container: ContainerLike;
	summary: SummaryComponent;
	/** 展开时排在活动区末尾的折叠提示 */
	hint: SummaryComponent;
	components: object[];
	toolCount: number;
	thinkingCount: number;
	expanded: boolean;
};

type TurnState = {
	toolClass: ToolRowClass | undefined;
	assistantClass: AssistantClass | undefined;
	userClass: UserRowClass | undefined;
	/** 当前这一轮挂在哪个容器、加了哪些组件 */
	container: ContainerLike | undefined;
	components: object[];
	/** transcript 里所有已收尾的回合 */
	turns: Set<Turn>;
	/** 已经收起的工具行 */
	hiddenTools: WeakSet<object>;
	/** 已经收起思考的助手消息 */
	hiddenThinking: WeakSet<object>;
	/** 每条助手消息原来的思考标签，展开时还原 */
	labels: WeakMap<object, string>;
	/** 回放完的第一次渲染时要补一次收尾 */
	pendingFinalize: boolean;
	/** 最近一次渲染用的宽度，收起时用它算行数差 */
	lastWidth: number | undefined;
	/** 全屏下的滚动视口，用来在收起时补回滚动位置 */
	scrollHost: ScrollHost | undefined;
};

/** 全屏 TUI 的滚动接口，普通模式没有 */
type ScrollHost = {
	isFollowingOutput?: boolean;
	scrollBy?: (lines: number) => void;
};

function turnState(): TurnState {
	const existing = (globalThis as Record<symbol, TurnState | undefined>)[STATE_KEY];
	if (existing !== undefined) {
		return existing;
	}
	const created: TurnState = {
		toolClass: undefined,
		assistantClass: undefined,
		userClass: undefined,
		container: undefined,
		components: [],
		turns: new Set(),
		hiddenTools: new WeakSet(),
		hiddenThinking: new WeakSet(),
		labels: new WeakMap(),
		pendingFinalize: false,
		lastWidth: undefined,
		scrollHost: undefined,
	};
	(globalThis as Record<symbol, TurnState | undefined>)[STATE_KEY] = created;
	return created;
}

function currentTheme(): Theme {
	const theme = (globalThis as Record<symbol, Theme | undefined>)[THEME_KEY];
	if (theme === undefined) {
		throw new Error("主题尚未初始化，汇总行无法取色");
	}
	return theme;
}

function hideTool(tool: object): void {
	turnState().hiddenTools.add(tool);
}

function showTool(tool: object): void {
	turnState().hiddenTools.delete(tool);
}

/** 收起一条助手消息里的思考块：空标签让它连占位都不留 */
function hideThinking(message: AssistantRow): void {
	const state = turnState();
	state.hiddenThinking.add(message);
	// 记住 Pi 配的标签，展开时还原
	if (!state.labels.has(message)) {
		state.labels.set(message, message.hiddenThinkingLabel);
	}
	message.setHideThinkingBlock(true);
}

/** 展开思考：只露出 Pi 的标签，点标签才看具体内容 */
function showThinking(message: AssistantRow): void {
	const state = turnState();
	state.hiddenThinking.delete(message);
	const label = state.labels.get(message);
	if (label !== undefined) {
		message.setHiddenThinkingLabel(label);
	}
	message.setHideThinkingBlock(true);
}

/** 一条消息里连续的思考块算一段 */
function thinkingRunCount(message: AssistantRow): number {
	let count = 0;
	let inRun = false;
	for (const part of message.lastMessage?.content ?? []) {
		if (part.type === "thinking" && (part.thinking ?? "").trim() !== "") {
			if (!inRun) {
				count++;
				inRun = true;
			}
			continue;
		}
		inRun = false;
	}
	return count;
}

function setTurnExpanded(turn: Turn, expanded: boolean): void {
	if (turn.expanded === expanded) {
		return;
	}
	turn.expanded = expanded;
	const state = turnState();
	for (const component of turn.components) {
		if (state.toolClass !== undefined && component instanceof state.toolClass) {
			if (expanded) {
				showTool(component);
			} else {
				hideTool(component);
			}
			continue;
		}
		if (state.assistantClass !== undefined && component instanceof state.assistantClass) {
			if (expanded) {
				showThinking(component);
			} else {
				hideThinking(component);
			}
		}
	}
	turn.summary.invalidate();
	turn.hint.invalidate();
}

/** 把滚动位置往前补 removed 行，只在不跟随时才动 */
function compensateScroll(removed: number): void {
	const host = turnState().scrollHost;
	if (removed <= 0 || host === undefined || host.isFollowingOutput !== false) {
		return;
	}
	host.scrollBy?.(-removed);
}

/** 收起一轮：先量出会少多少行，收起后把滚动位置补回来，视口不会被夹到最底部 */
function collapseTurn(turn: Turn): void {
	const state = turnState();
	const width = state.lastWidth;
	if (!turn.expanded || width === undefined) {
		setTurnExpanded(turn, false);
		return;
	}
	const before = turn.container.render(width).length;
	setTurnExpanded(turn, false);
	compensateScroll(before - turn.container.render(width).length);
}

/** 点击汇总行与折叠提示都是同一个开关 */
function toggleTurn(turn: Turn): void {
	if (turn.expanded) {
		collapseTurn(turn);
		return;
	}
	setTurnExpanded(turn, true);
}

/** 汇总行：一行标记加计数，点击整轮展开或收起 */
function createSummary(turn: Turn): SummaryComponent {
	return {
		render(width: number): string[] {
			const theme = currentTheme();
			const parts: string[] = [];
			if (turn.toolCount > 0) {
				parts.push(`${turn.toolCount} 次工具调用`);
			}
			if (turn.thinkingCount > 0) {
				parts.push(`${turn.thinkingCount} 段思考`);
			}
			const marker = theme.fg("accent", turn.expanded ? "▾" : "▸");
			const text = theme.fg("muted", parts.join(theme.fg("dim", " · ")));
			return ["", truncateToWidth(` ${marker} ${text}`, width, "...")];
		},
		invalidate(): void {},
		handleMouse(event: TuiMouseEvent): unknown {
			if (event.type !== "click" || event.button !== "left") {
				return undefined;
			}
			toggleTurn(turn);
			return { handled: true };
		},
	};
}

/** 展开时露在活动区末尾的折叠提示，收起时不占行 */
function createCollapseHint(turn: Turn): SummaryComponent {
	return {
		render(width: number): string[] {
			if (!turn.expanded) {
				return [];
			}
			const theme = currentTheme();
			return ["", truncateToWidth(` ${theme.fg("dim", "--- 点击折叠 ---")}`, width, "...")];
		},
		invalidate(): void {},
		handleMouse(event: TuiMouseEvent): unknown {
			if (event.type !== "click" || event.button !== "left") {
				return undefined;
			}
			collapseTurn(turn);
			return { handled: true };
		},
	};
}

/** 折叠提示插在活动区末尾：最后一个是工具行就排在它后面，否则排在最后一条助手消息前面 */
function collapseHintIndex(turn: Turn): number {
	const state = turnState();
	const children = turn.container.children;
	const present = turn.components.filter((component) => children.indexOf(component) >= 0);
	const last = present[present.length - 1];
	if (last === undefined) {
		return -1;
	}
	if (state.toolClass !== undefined && last instanceof state.toolClass) {
		return children.indexOf(last) + 1;
	}
	// 只有一条助手消息的回合，标题行就在上面，不需要额外提示
	return present.length > 1 ? children.indexOf(last) : -1;
}

/** 收尾当前回合：插入汇总行，把本轮的组件收起来 */
function finalizeTurn(): void {
	const state = turnState();
	const components = state.components;
	const container = state.container;
	state.components = [];
	state.container = undefined;
	if (container === undefined || components.length === 0) {
		return;
	}

	const tools: ToolRow[] = [];
	const assistants: AssistantRow[] = [];
	for (const component of components) {
		if (state.toolClass !== undefined && component instanceof state.toolClass) {
			tools.push(component);
			continue;
		}
		if (state.assistantClass !== undefined && component instanceof state.assistantClass) {
			assistants.push(component);
		}
	}
	if (tools.length === 0 && assistants.length === 0) {
		return;
	}
	const thinkingCount = assistants.reduce((sum, assistant) => sum + thinkingRunCount(assistant), 0);
	// 既没工具调用也没思考的回合（例如直接报错）没有可收起的东西
	if (tools.length === 0 && thinkingCount === 0) {
		return;
	}

	// 汇总行放在本轮第一个组件原来的位置：展开后思考标签、正文、工具行都排在它下面，
	// 不会出现思考露在汇总行上方的情况
	const anchor = components.find((component) => container.children.indexOf(component) >= 0);
	const index = anchor === undefined ? -1 : container.children.indexOf(anchor);
	if (index < 0) {
		return;
	}

	const turn: Turn = {
		container,
		summary: undefined as unknown as SummaryComponent,
		hint: undefined as unknown as SummaryComponent,
		components,
		toolCount: tools.length,
		thinkingCount,
		expanded: false,
	};
	turn.summary = createSummary(turn);
	container.children.splice(index, 0, turn.summary);
	turn.hint = createCollapseHint(turn);
	const hintIndex = collapseHintIndex(turn);
	if (hintIndex >= 0) {
		container.children.splice(hintIndex, 0, turn.hint);
	}
	state.turns.add(turn);

	for (const component of components) {
		if (state.toolClass !== undefined && component instanceof state.toolClass) {
			hideTool(component);
			continue;
		}
		if (state.assistantClass !== undefined && component instanceof state.assistantClass) {
			hideThinking(component);
		}
	}
}

/** 登记新加入的组件；遇到用户消息说明上一轮结束了 */
function record(parent: ContainerLike, child: unknown): void {
	const state = turnState();
	if (state.toolClass === undefined || state.assistantClass === undefined) {
		return;
	}
	if (state.userClass !== undefined && child instanceof state.userClass) {
		finalizeTurn();
		return;
	}
	if (!(child instanceof state.toolClass) && !(child instanceof state.assistantClass)) {
		return;
	}
	state.container = parent;
	state.components.push(child as object);
}

function patchToolRender(component: ToolRowClass): void {
	const prototype = component.prototype;
	if (prototype[TOOL_PATCH_FLAG]) {
		return;
	}
	const originalRender = prototype.render;

	const patchedRender = function (this: ToolRow, width: number): string[] {
		return turnState().hiddenTools.has(this) ? [] : originalRender.call(this, width);
	};

	Object.defineProperty(patchedRender, TOOL_PATCH_FLAG, { value: true });
	prototype.render = patchedRender;
}

function patchAssistantRender(component: AssistantClass): void {
	const prototype = component.prototype;
	if (prototype[ASSISTANT_PATCH_FLAG]) {
		return;
	}
	const originalUpdateContent = prototype.updateContent;

	const patchedUpdateContent = function (this: AssistantRow, message: unknown, isStreaming?: boolean): void {
		if (turnState().hiddenThinking.has(this)) {
			this.hideThinkingBlock = true;
			this.hiddenThinkingLabel = "";
			// 清掉 Pi 记录的逐段可见性，否则之前点开过的那一段会漏出来
			this.thinkingVisibilityOverrides?.clear();
		}
		originalUpdateContent.call(this, message, isStreaming);
	};

	Object.defineProperty(patchedUpdateContent, ASSISTANT_PATCH_FLAG, { value: true });
	prototype.updateContent = patchedUpdateContent;
}

/** 容器原型从工具行类的继承链上取，所有容器都从它继承 */
function containerClassOf(toolClass: ToolRowClass): ContainerClass {
	let prototype = Object.getPrototypeOf(toolClass.prototype) as (ContainerClass["prototype"] & { addChild?: unknown }) | null;
	while (prototype !== null && !Object.prototype.hasOwnProperty.call(prototype, "addChild")) {
		prototype = Object.getPrototypeOf(prototype) as (ContainerClass["prototype"] & { addChild?: unknown }) | null;
	}
	if (prototype === null) {
		throw new Error("工具行类的继承链里没有 addChild，找不到 Container 原型");
	}
	return { prototype } as ContainerClass;
}

function patchAddChild(component: ContainerClass): void {
	const prototype = component.prototype;
	if (prototype[CONTAINER_PATCH_FLAG]) {
		return;
	}
	const originalAddChild = prototype.addChild;

	const patchedAddChild = function (this: ContainerLike, child: unknown): void {
		originalAddChild.call(this, child);
		record(this, child);
	};

	Object.defineProperty(patchedAddChild, CONTAINER_PATCH_FLAG, { value: true });
	prototype.addChild = patchedAddChild;
}

/**
 * 回放没有结束事件，靠 transcript 容器的第一次渲染收尾最后一轮：
 * 渲染时先把这一轮折叠好，再交回原实现。
 */
function patchRender(component: ContainerClass): void {
	const prototype = component.prototype;
	if (prototype[RENDER_PATCH_FLAG]) {
		return;
	}
	const originalRender = prototype.render;

	const patchedRender = function (this: ContainerLike, width: number): string[] {
		const state = turnState();
		state.lastWidth = width;
		if (state.pendingFinalize && this === state.container) {
			state.pendingFinalize = false;
			finalizeTurn();
		}
		return originalRender.call(this, width);
	};

	Object.defineProperty(patchedRender, RENDER_PATCH_FLAG, { value: true });
	prototype.render = patchedRender;
}

/** 把所有汇总行整体展开或收起 */
function toggleAllTurns(ctx: ExtensionContext): void {
	const state = turnState();
	const anyCollapsed = [...state.turns].some((turn) => !turn.expanded);
	if (anyCollapsed) {
		for (const turn of state.turns) {
			setTurnExpanded(turn, true);
		}
		ctx.ui.notify("Tool activity: visible");
		return;
	}
	const container = state.turns.values().next().value?.container;
	const width = state.lastWidth;
	const before = container === undefined || width === undefined ? undefined : container.render(width).length;
	for (const turn of state.turns) {
		setTurnExpanded(turn, false);
	}
	if (before !== undefined && container !== undefined && width !== undefined) {
		compensateScroll(before - container.render(width).length);
	}
	ctx.ui.notify("Tool activity: hidden");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tool-activity", {
		description: "展开或收起所有回合的工具执行与思考",
		handler: async (_args, ctx) => {
			toggleAllTurns(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlShift("o"), {
		description: "展开或收起所有回合的工具执行与思考",
		handler: (ctx) => {
			toggleAllTurns(ctx);
		},
	});

	// 子代理的会话也走这套事件，只有交互会话才动这个状态
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode === "tui") {
			turnState().pendingFinalize = false;
			finalizeTurn();
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode === "tui") {
			finalizeTurn();
		}
	});

	// 压缩会清空 transcript 并重新回放，旧回合的汇总行跟着一起没了
	pi.on("session_compact", () => {
		const state = turnState();
		state.turns.clear();
		state.components = [];
		state.container = undefined;
		state.pendingFinalize = true;
	});

	pi.on("session_start", async (event, ctx) => {
		const state = turnState();
		// reload 不重建 transcript，进行中的回合也不打断
		const replay = event.reason !== "reload";
		if (replay) {
			state.turns.clear();
			state.components = [];
			state.container = undefined;
		}

		const bundle = await loadBundle();
		const toolClass = bundle.ToolExecutionComponent as ToolRowClass | undefined;
		const assistantClass = bundle.AssistantMessageComponent as AssistantClass | undefined;
		const userClass = bundle.UserMessageComponent as UserRowClass | undefined;
		if (!toolClass || !assistantClass || !userClass) {
			throw new Error("打包入口里缺少 ToolExecutionComponent、AssistantMessageComponent 或 UserMessageComponent");
		}
		state.toolClass = toolClass;
		state.assistantClass = assistantClass;
		state.userClass = userClass;
		patchToolRender(toolClass);
		patchAssistantRender(assistantClass);
		const container = containerClassOf(toolClass);
		patchAddChild(container);
		patchRender(container);

		// 收起时要把滚动位置补回来，需要一个 TUI 引用；widget 工厂是唯一拿得到它的入口
		if (ctx.hasUI) {
			ctx.ui.setWidget(
				SCROLL_WIDGET_KEY,
				(tui) => {
					state.scrollHost = tui as ScrollHost;
					return { render: () => [], invalidate: () => {} };
				},
				{ placement: "aboveEditor" },
			);
		}

		// 回放跑完后的第一次渲染再把最后一轮也收起来
		if (replay) {
			state.pendingFinalize = true;
		}
	});
}
