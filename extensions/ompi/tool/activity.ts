/**
 * 隐藏 / 显示工具执行。
 *
 * Pi 没有 omp 的 display.hideToolActivity 设置，这里在 ToolExecutionComponent 上包一层
 * render：隐藏时直接返回空数组，整行工具调用与结果（含结果里的图片）从 transcript 里消失，
 * 助手正文与思考块不受影响。
 *
 * 一轮开始时放开工具行，等正文输出完（agent_end）再收起，工作过程中依旧能看见执行情况。
 * /tool-activity 命令与 ctrl+shift+o 快捷键可以随时手动翻转，管到下一次生命周期事件为止。
 * 状态只在当前进程内有效。
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

function setHidden(hidden: boolean): void {
	activityState().hidden = hidden;
}

function toggleToolActivity(ctx: ExtensionContext): void {
	const hidden = !activityState().hidden;
	setHidden(hidden);
	ctx.ui.notify(`Tool activity: ${hidden ? "hidden" : "visible"}`);
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

	// 一轮开始时放开工具行，正文输出完再收起。子代理的会话也走这套事件，
	// 只有交互会话才动这个开关，否则子代理收尾会把主会话的工具行提前藏起来。
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode === "tui") {
			setHidden(false);
		}
	});
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode === "tui") {
			setHidden(true);
		}
	});

	pi.on("session_start", async () => {
		setHidden(false);
		const bundle = await loadBundle();
		const component = bundle.ToolExecutionComponent as ToolRowClass | undefined;
		if (!component) {
			throw new Error("打包入口里没有 ToolExecutionComponent，工具执行无法隐藏");
		}
		patchRender(component);
	});
}
