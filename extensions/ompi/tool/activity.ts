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

/** 跨扩展重新加载共享的状态：原型上的补丁还在，记录不能留在旧模块里 */
const STATE_KEY = Symbol.for("pi.ompi.turn-summary");

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

type ContainerLike = { children: unknown[] };

type ContainerClass = {
	prototype: ContainerLike & {
		addChild: (this: ContainerLike, child: unknown) => void;
		[CONTAINER_PATCH_FLAG]?: boolean;
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
			setTurnExpanded(turn, !turn.expanded);
			return { handled: true };
		},
	};
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

	// 汇总行放在第一个工具行原来的位置；没有工具行时放在最后一条助手消息前面
	const anchor = tools[0] ?? assistants[assistants.length - 1];
	const index = anchor === undefined ? -1 : container.children.indexOf(anchor);
	if (index < 0) {
		return;
	}

	const turn: Turn = {
		container,
		summary: undefined as unknown as SummaryComponent,
		components,
		toolCount: tools.length,
		thinkingCount,
		expanded: false,
	};
	turn.summary = createSummary(turn);
	container.children.splice(index, 0, turn.summary);
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

/** 把所有汇总行整体展开或收起 */
function toggleAllTurns(ctx: ExtensionContext): void {
	const state = turnState();
	const anyCollapsed = [...state.turns].some((turn) => !turn.expanded);
	for (const turn of state.turns) {
		setTurnExpanded(turn, anyCollapsed);
	}
	ctx.ui.notify(`Tool activity: ${anyCollapsed ? "visible" : "hidden"}`);
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
	});

	pi.on("session_start", async (event) => {
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
		patchAddChild(containerClassOf(toolClass));

		// 回放是同步的，等它跑完再把最后一轮也收起来
		if (replay) {
			setTimeout(() => {
				finalizeTurn();
			}, 0);
		}
	});
}
