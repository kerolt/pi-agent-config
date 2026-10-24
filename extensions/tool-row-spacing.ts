/**
 * 收紧工具调用行之间的间距。
 *
 * Pi 的 ToolExecutionComponent 在 renderShell 为 self 时会在正文前固定插入一行空行，
 * 工具连续执行时每行都要多占一行；鼠标命中又是按这一行偏移计算的。这里替换运行中
 * 那个类的 render 和 handleMouse：渲染不再插入空行，命中判定跟着按新的行位置计算。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { loadBundle } from "./lib/pi-bundle.ts";

/** 打补丁的标记，避免重复包装同一批方法 */
const PATCH_FLAG = Symbol.for("pi.tool-row-spacing");

/** 只用到 ToolExecutionComponent 里与 self 外壳有关的部分 */
type ToolRowInstance = {
	getRenderShell: () => string;
	hasRendererDefinition: () => boolean;
	render: (width: number) => string[];
	handleMouse: (event: TuiMouseEvent) => unknown;
	selfRenderHeight: number;
	selfRenderContainer: { handleMouse: (event: TuiMouseEvent) => unknown };
};

type ToolRowClass = {
	prototype: ToolRowInstance & {
		render: (this: ToolRowInstance, width: number) => string[];
		handleMouse: (this: ToolRowInstance, event: TuiMouseEvent) => unknown;
	};
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		const bundle = await loadBundle();
		const component = bundle.ToolExecutionComponent as ToolRowClass | undefined;
		if (!component) {
			throw new Error("打包入口里没有 ToolExecutionComponent，工具行间距保持默认");
		}
		if ((component.prototype.render as { [PATCH_FLAG]?: boolean })[PATCH_FLAG]) {
			return;
		}

		const originalRender = component.prototype.render;
		const originalHandleMouse = component.prototype.handleMouse;

		const patchedRender = function (this: ToolRowInstance, width: number): string[] {
			const lines = originalRender.call(this, width);
			// self 外壳的行首空行固定由 ToolExecutionComponent 插入，正文本身不带
			if (lines.length > 1 && lines[0] === "" && this.getRenderShell() === "self") {
				return lines.slice(1);
			}
			return lines;
		};

		const patchedHandleMouse = function (this: ToolRowInstance, event: TuiMouseEvent): unknown {
			if (!this.hasRendererDefinition() || this.getRenderShell() !== "self") {
				return originalHandleMouse.call(this, event);
			}
			// 正文从组件的第一行开始，不再像原来那样整体下移一行
			if (event.y < 0 || event.y >= this.selfRenderHeight) {
				return undefined;
			}
			return this.selfRenderContainer.handleMouse({ ...event, height: this.selfRenderHeight });
		};

		Object.defineProperty(patchedRender, PATCH_FLAG, { value: true });
		component.prototype.render = patchedRender;
		component.prototype.handleMouse = patchedHandleMouse;
	});
}
