/**
 * 收紧工具调用行之间的间距。
 *
 * Pi 的 ToolExecutionComponent 在 renderShell 为 self 时会在正文前固定插入一行空行，
 * 工具连续执行时每行都要多占一行；鼠标命中又是按这一行偏移计算的。这里让一组连续
 * 工具行只有第一行保留空行，后面的行去掉：渲染时看前一个同级组件是不是工具行，
 * 命中判定跟着按实际行位置计算。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { loadBundle } from "./lib/pi-bundle.ts";

/** 打补丁的标记，避免重复包装同一批方法 */
const TOOL_ROW_FLAG = Symbol.for("pi.tool-row-spacing");
const ADD_CHILD_FLAG = Symbol.for("pi.tool-row-spacing.add-child");

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

/** 容器里每个子组件加入时记下的前一个同级组件 */
const previousSiblings = new WeakMap<object, unknown>();

/** 找到 Container 原型：addChild 的归属者，所有容器都从它继承 */
function containerPrototypeOf(toolRow: ToolRowClass): { addChild: (child: unknown) => void } {
	let prototype = Object.getPrototypeOf(toolRow.prototype) as { addChild?: (child: unknown) => void } | null;
	while (prototype !== null && !Object.prototype.hasOwnProperty.call(prototype, "addChild")) {
		prototype = Object.getPrototypeOf(prototype) as { addChild?: (child: unknown) => void } | null;
	}
	if (prototype === null) {
		throw new Error("ToolExecutionComponent 的继承链里没有 addChild，无法判断工具行的先后");
	}
	return prototype as { addChild: (child: unknown) => void };
}

/** 工具行加入容器时记下前一个同级组件，渲染时用它判断空行是否保留 */
function patchAddChild(toolRow: ToolRowClass): void {
	const prototype = containerPrototypeOf(toolRow) as {
		addChild: (this: { children: unknown[] }, child: unknown) => void;
		[ADD_CHILD_FLAG]?: boolean;
	};
	if (prototype[ADD_CHILD_FLAG]) {
		return;
	}
	const originalAddChild = prototype.addChild;

	const patchedAddChild = function (this: { children: unknown[] }, child: unknown): void {
		originalAddChild.call(this, child);
		if (child instanceof toolRow) {
			previousSiblings.set(child as object, this.children[this.children.length - 2]);
		}
	};

	Object.defineProperty(patchedAddChild, ADD_CHILD_FLAG, { value: true });
	prototype.addChild = patchedAddChild;
}

/** 一组连续工具行里只有第一行保留行首空行，鼠标命中从正文第一行开始算 */
function patchToolRows(component: ToolRowClass): void {
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
		if (previousSiblings.get(this) instanceof component) {
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
		if (!component) {
			throw new Error("打包入口里没有 ToolExecutionComponent，工具行间距保持默认");
		}
		patchAddChild(component);
		patchToolRows(component);
	});
}
