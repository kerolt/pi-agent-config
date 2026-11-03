/**
 * 按回合隐藏工具执行与模型思考。
 *
 * 一轮对话进行中，工具行与思考块照常显示，能看到执行情况；这一轮结束（agent_end）后，
 * 只把本轮加入的工具行与思考块收起来，历史回合保持各自的状态，最终回复的正文留在
 * transcript 里。重新载入会话时 replay 出来的内容都属于已结束的回合，一并收起。
 *
 * 工具行靠 ToolExecutionComponent.render 返回空数组隐藏；思考块靠 AssistantMessageComponent
 * 的隐藏开关加空标签隐藏，并在 updateContent 上补一层，Pi 自己切换思考可见性时也不会把它翻回来。
 *
 * /tool-activity 命令与 ctrl+shift+o 快捷键把当前 transcript 里的工具行与思考整体翻一次，
 * 只影响已经登记过的组件，不改变后续回合的自动隐藏。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { loadBundle } from "../lib/pi-bundle.ts";

/** 打补丁的标记，避免重复包装同一批方法 */
const TOOL_PATCH_FLAG = Symbol.for("pi.ompi.turn-visibility.tool");
const ASSISTANT_PATCH_FLAG = Symbol.for("pi.ompi.turn-visibility.assistant");
const CONTAINER_PATCH_FLAG = Symbol.for("pi.ompi.turn-visibility.container");

/** 跨扩展重新加载共享的状态：原型上的补丁还在，记录不能留在旧模块里 */
const STATE_KEY = Symbol.for("pi.ompi.turn-visibility");

type ToolRow = { render: (width: number) => string[] };

type ToolRowClass = {
	new (...args: unknown[]): ToolRow;
	prototype: ToolRow & { [TOOL_PATCH_FLAG]?: boolean };
};

type AssistantRow = {
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	setHideThinkingBlock: (hide: boolean) => void;
	updateContent: (message: unknown, isStreaming?: boolean) => void;
};

type AssistantClass = {
	new (...args: unknown[]): AssistantRow;
	prototype: AssistantRow & { [ASSISTANT_PATCH_FLAG]?: boolean };
};

type ContainerClass = {
	prototype: {
		addChild: (this: { children: unknown[] }, child: unknown) => void;
		[CONTAINER_PATCH_FLAG]?: boolean;
	};
};

type HideState = {
	toolClass: ToolRowClass | undefined;
	assistantClass: AssistantClass | undefined;
	/** 当前是否处在一轮对话中 */
	turnActive: boolean;
	/** 本轮加入的组件，回合结束时统一收起 */
	currentTurn: Set<object>;
	/** transcript 里登记过的组件，手动切换时整体重设 */
	tracked: Set<object>;
	/** 已经收起的工具行 */
	hiddenTools: WeakSet<object>;
	/** 已经收起思考的助手消息 */
	hiddenThinking: WeakSet<object>;
};

function hideState(): HideState {
	const existing = (globalThis as Record<symbol, HideState | undefined>)[STATE_KEY];
	if (existing !== undefined) {
		return existing;
	}
	const created: HideState = {
		toolClass: undefined,
		assistantClass: undefined,
		turnActive: false,
		currentTurn: new Set(),
		tracked: new Set(),
		hiddenTools: new WeakSet(),
		hiddenThinking: new WeakSet(),
	};
	(globalThis as Record<symbol, HideState | undefined>)[STATE_KEY] = created;
	return created;
}

/** 收起一个工具行 */
function hideTool(tool: object): void {
	hideState().hiddenTools.add(tool);
}

/** 收起一条助手消息里的思考块，空标签让折叠后的思考连占位都不留 */
function hideThinking(message: AssistantRow): void {
	hideState().hiddenThinking.add(message);
	message.setHideThinkingBlock(true);
}

function isHidden(component: object): boolean {
	const state = hideState();
	return state.hiddenTools.has(component) || state.hiddenThinking.has(component);
}

function hideComponent(component: object): void {
	const state = hideState();
	if (state.toolClass !== undefined && component instanceof state.toolClass) {
		hideTool(component);
		return;
	}
	if (state.assistantClass !== undefined && component instanceof state.assistantClass) {
		hideThinking(component);
	}
}

/** 收起 transcript 里已经登记过的全部组件 */
function hideTracked(): void {
	for (const component of hideState().tracked) {
		hideComponent(component);
	}
}

/** 重新显示全部组件，思考块交回 Pi 自己的可见性设置 */
function showTracked(): void {
	const state = hideState();
	state.hiddenTools = new WeakSet();
	state.hiddenThinking = new WeakSet();
	for (const component of state.tracked) {
		if (state.assistantClass !== undefined && component instanceof state.assistantClass) {
			component.setHideThinkingBlock(false);
		}
	}
}

/** 登记新加入的组件：回合进行中先留着，回合结束后才收起 */
function record(component: unknown): void {
	const state = hideState();
	if (state.toolClass === undefined || state.assistantClass === undefined) {
		return;
	}
	if (!(component instanceof state.toolClass) && !(component instanceof state.assistantClass)) {
		return;
	}
	const tracked = component as object;
	state.tracked.add(tracked);
	if (state.turnActive) {
		state.currentTurn.add(tracked);
		return;
	}
	hideComponent(tracked);
}

function patchToolRender(component: ToolRowClass): void {
	const prototype = component.prototype;
	if (prototype[TOOL_PATCH_FLAG]) {
		return;
	}
	const originalRender = prototype.render;

	const patchedRender = function (this: ToolRow, width: number): string[] {
		return hideState().hiddenTools.has(this) ? [] : originalRender.call(this, width);
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
		if (hideState().hiddenThinking.has(this)) {
			this.hideThinkingBlock = true;
			this.hiddenThinkingLabel = "";
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

	const patchedAddChild = function (this: { children: unknown[] }, child: unknown): void {
		originalAddChild.call(this, child);
		record(child);
	};

	Object.defineProperty(patchedAddChild, CONTAINER_PATCH_FLAG, { value: true });
	prototype.addChild = patchedAddChild;
}

function toggleToolActivity(ctx: ExtensionContext): void {
	const state = hideState();
	const anythingVisible = [...state.tracked].some((component) => !isHidden(component));
	if (anythingVisible) {
		hideTracked();
	} else {
		showTracked();
	}
	ctx.ui.notify(`Tool activity: ${anythingVisible ? "hidden" : "visible"}`);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tool-activity", {
		description: "收起或显示工具执行与思考",
		handler: async (_args, ctx) => {
			toggleToolActivity(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlShift("o"), {
		description: "收起或显示工具执行与思考",
		handler: (ctx) => {
			toggleToolActivity(ctx);
		},
	});

	// 一轮开始时放开，结束后只收起这一轮加入的组件。子代理的会话也走这套事件，
	// 只有交互会话才动这个状态，否则子代理收尾会把主会话的内容提前收起来。
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}
		const state = hideState();
		state.turnActive = true;
		state.currentTurn.clear();
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}
		const state = hideState();
		state.turnActive = false;
		for (const component of state.currentTurn) {
			hideComponent(component);
		}
		state.currentTurn.clear();
	});

	pi.on("session_start", async (event) => {
		const state = hideState();
		state.turnActive = false;
		state.currentTurn.clear();
		// reload 不重建 transcript，登记过的组件原样保留；其余情况全是新组件
		if (event.reason !== "reload") {
			state.tracked.clear();
		}

		const bundle = await loadBundle();
		const toolClass = bundle.ToolExecutionComponent as ToolRowClass | undefined;
		const assistantClass = bundle.AssistantMessageComponent as AssistantClass | undefined;
		if (!toolClass || !assistantClass) {
			throw new Error("打包入口里没有 ToolExecutionComponent 或 AssistantMessageComponent，无法收起工具执行与思考");
		}
		state.toolClass = toolClass;
		state.assistantClass = assistantClass;
		patchToolRender(toolClass);
		patchAssistantRender(assistantClass);
		patchAddChild(containerClassOf(toolClass));
	});
}
