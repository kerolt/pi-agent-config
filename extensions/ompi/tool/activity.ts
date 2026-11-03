/**
 * 隐藏 / 显示工具执行。
 *
 * Pi 没有 omp 的 display.hideToolActivity 设置，这里在 ToolExecutionComponent 上包一层
 * render：隐藏时直接返回空数组，整行工具调用与结果（含结果里的图片）从 transcript 里消失，
 * 助手正文与思考块不受影响。
 *
 * 开关由 /tool-activity 命令与 ctrl+shift+o 快捷键切换，状态只在当前进程内有效。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { loadBundle } from "../lib/pi-bundle.ts";

/** 打补丁的标记，避免重复包装同一批方法 */
const PATCH_FLAG = Symbol.for("pi.ompi.tool-activity.patch");

/** 跨扩展重新加载共享的状态：原型上的补丁还在，开关不能留在旧模块里 */
const STATE_KEY = Symbol.for("pi.ompi.tool-activity");

type ActivityState = { hidden: boolean };

type ToolRowInstance = { render: (width: number) => string[] };

type ToolRowClass = {
	prototype: ToolRowInstance & {
		render: (this: ToolRowInstance, width: number) => string[];
		[PATCH_FLAG]?: boolean;
	};
};

function activityState(): ActivityState {
	const existing = (globalThis as Record<symbol, ActivityState | undefined>)[STATE_KEY];
	if (existing !== undefined) {
		return existing;
	}
	const created: ActivityState = { hidden: false };
	(globalThis as Record<symbol, ActivityState | undefined>)[STATE_KEY] = created;
	return created;
}

/** 隐藏时让工具行渲染出空数组，与 Pi 自己跳过不可见组件的方式一致 */
function patchRender(component: ToolRowClass): void {
	const prototype = component.prototype;
	if (prototype[PATCH_FLAG]) {
		return;
	}
	const originalRender = prototype.render;

	const patchedRender = function (this: ToolRowInstance, width: number): string[] {
		return activityState().hidden ? [] : originalRender.call(this, width);
	};

	Object.defineProperty(patchedRender, PATCH_FLAG, { value: true });
	prototype.render = patchedRender;
}

function toggleToolActivity(ctx: ExtensionContext): void {
	const state = activityState();
	state.hidden = !state.hidden;
	ctx.ui.notify(`Tool activity: ${state.hidden ? "hidden" : "visible"}`);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tool-activity", {
		description: "隐藏或显示工具执行",
		handler: async (_args, ctx) => {
			toggleToolActivity(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlShift("o"), {
		description: "隐藏或显示工具执行",
		handler: (ctx) => {
			toggleToolActivity(ctx);
		},
	});

	pi.on("session_start", async () => {
		const bundle = await loadBundle();
		const component = bundle.ToolExecutionComponent as ToolRowClass | undefined;
		if (!component) {
			throw new Error("打包入口里没有 ToolExecutionComponent，工具执行无法隐藏");
		}
		patchRender(component);
	});
}
