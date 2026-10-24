/**
 * 收紧工具调用行之间的间距。
 *
 * Pi 的 ToolExecutionComponent 在 renderShell 为 self 时会在正文前固定插入一行空行，
 * 工具连续执行时每行都要多占一行。这里替换运行中那个类的 render，把这一行去掉。
 *
 * 命令行实际渲染用的是 dist/bundle 里的打包产物，扩展导入的包入口是另一份代码，
 * 两份代码里各有一个同名类。只有从命令行入口出发找到同一份打包产物，才改得到正在使用的类。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 打补丁的标记，避免重复包装同一个 render */
const PATCH_FLAG = Symbol.for("pi.tool-row-spacing");

/** 命令行入口位于 node_modules/.bin，同级的 @earendil-works 目录下是打包产物 */
function bundleEntry(): string {
	const cliEntry = process.argv[1];
	if (!cliEntry) {
		throw new Error("无法确定 Pi 的命令行入口，工具行间距保持默认");
	}
	const entry = join(
		dirname(cliEntry),
		"..",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"bundle",
		"index.js",
	);
	if (!existsSync(entry)) {
		throw new Error(`找不到 Pi 的打包入口 ${entry}，工具行间距保持默认`);
	}
	return entry;
}

/** 只用到 ToolExecutionComponent 的 render 与 getRenderShell */
type ToolRowClass = {
	prototype: {
		render: (this: { getRenderShell: () => string }, width: number) => string[];
		getRenderShell: () => string;
	};
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		const bundle = (await import(pathToFileURL(bundleEntry()).href)) as { ToolExecutionComponent?: ToolRowClass };
		const component = bundle.ToolExecutionComponent;
		if (!component) {
			throw new Error("打包入口里没有 ToolExecutionComponent，工具行间距保持默认");
		}
		const originalRender = component.prototype.render;
		if (PATCH_FLAG in originalRender) {
			return;
		}
		const patched = function (this: { getRenderShell: () => string }, width: number): string[] {
			const lines = originalRender.call(this, width);
			// self 外壳的行首空行固定由 ToolExecutionComponent 插入，正文本身不带
			if (lines.length > 1 && lines[0] === "" && this.getRenderShell() === "self") {
				return lines.slice(1);
			}
			return lines;
		};
		Object.defineProperty(patched, PATCH_FLAG, { value: true });
		component.prototype.render = patched;
	});
}
