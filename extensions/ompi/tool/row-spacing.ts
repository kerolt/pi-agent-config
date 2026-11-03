/**
 * 收紧工具调用行之间的间距。
 *
 * Pi 的 ToolExecutionComponent 在 renderShell 为 self 时会在正文前固定插入一行空行，
 * 工具连续执行时每行都要多占一行；鼠标命中又是按这一行偏移计算的。这里让一组连续
 * 工具行只有第一行保留空行，后面的行去掉。
 *
 * 判断依据是工具行前面最近的一段可见内容：渲染不出任何行的助手消息（这一轮没有正文、
 * 思考块又被折叠起来）不算内容，继续往前找；找到工具行就去掉空行，找到别的内容就保留。
 * 命中判定跟着按实际行位置计算。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { patchChatTree, previousSiblingOf } from "./chat-tree.ts";
import { loadBundle } from "../lib/pi-bundle.ts";

/** 打补丁的标记，避免重复包装同一批方法 */
const TOOL_ROW_FLAG = Symbol.for("pi.tool-row-spacing");

/** 只用到 ToolExecutionComponent 里与 self 外壳有关的部分 */
type ToolRowInstance = {
	getRenderShell: () => string;
	hasRendererDefinition: () => boolean;
	render: (width: number) => string[];
	handleMouse: (event: TuiMouseEvent) => unknown;
	selfRenderHeight: number;
	selfRenderContainer: { handleMouse: (event: TuiMouseEvent) => unknown };
	/** 本次渲染是否保留了行首空行，鼠标命中按它决定偏移 */
	leadingBlank: boolean;
};

type ToolRowClass = {
	new (...args: unknown[]): ToolRowInstance;
	prototype: ToolRowInstance & {
		render: (this: ToolRowInstance, width: number) => string[];
		handleMouse: (this: ToolRowInstance, event: TuiMouseEvent) => unknown;
	};
};

/** 只用到 AssistantMessageComponent 里判断有没有可见内容的部分 */
type AssistantRowClass = {
	new (...args: unknown[]): { contentContainer?: { children?: unknown[] } };
};

/** 助手消息没有可见内容：正文为空，思考块又被折叠起来 */
function rendersNothing(value: InstanceType<AssistantRowClass>): boolean {
	const children = value.contentContainer?.children;
	return Array.isArray(children) && children.length === 0;
}

/**
 * 往前找到第一段能看见的内容。渲染不出任何行的助手消息跳过，
 * 它们夹在工具行之间时不该把工具行分成两组。
 */
function previousVisibleNode(node: object, assistant: AssistantRowClass): unknown {
	let previous = previousSiblingOf(node);
	while (previous instanceof assistant && rendersNothing(previous)) {
		previous = previousSiblingOf(previous as object);
	}
	return previous;
}

/** 一组连续工具行里只有第一行保留行首空行，鼠标命中从正文第一行开始算 */
function patchToolRows(component: ToolRowClass, assistant: AssistantRowClass): void {
	if ((component.prototype.render as { [TOOL_ROW_FLAG]?: boolean })[TOOL_ROW_FLAG]) {
		return;
	}

	const originalRender = component.prototype.render;
	const originalHandleMouse = component.prototype.handleMouse;

	const patchedRender = function (this: ToolRowInstance, width: number): string[] {
		const lines = originalRender.call(this, width);
		this.leadingBlank = false;
		// self 外壳的行首空行固定由 ToolExecutionComponent 插入，正文本身不带
		if (lines.length <= 1 || lines[0] !== "" || this.getRenderShell() !== "self") {
			return lines;
		}
		if (previousVisibleNode(this, assistant) instanceof component) {
			return lines.slice(1);
		}
		this.leadingBlank = true;
		return lines;
	};

	const patchedHandleMouse = function (this: ToolRowInstance, event: TuiMouseEvent): unknown {
		if (!this.hasRendererDefinition() || this.getRenderShell() !== "self") {
			return originalHandleMouse.call(this, event);
		}
		const offset = this.leadingBlank ? 1 : 0;
		if (event.y < offset || event.y >= offset + this.selfRenderHeight) {
			return undefined;
		}
		return this.selfRenderContainer.handleMouse({ ...event, y: event.y - offset, height: this.selfRenderHeight });
	};

	Object.defineProperty(patchedRender, TOOL_ROW_FLAG, { value: true });
	component.prototype.render = patchedRender;
	component.prototype.handleMouse = patchedHandleMouse;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		const bundle = await loadBundle();
		const component = bundle.ToolExecutionComponent as ToolRowClass | undefined;
		const assistant = bundle.AssistantMessageComponent as AssistantRowClass | undefined;
		if (!component || !assistant) {
			throw new Error("打包入口里没有 ToolExecutionComponent 或 AssistantMessageComponent，工具行间距保持默认");
		}
		patchChatTree(component);
		patchToolRows(component, assistant);
	});
}
