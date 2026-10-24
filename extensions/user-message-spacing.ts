/**
 * 去掉用户消息块自带的上下内边距。
 *
 * Pi 的 UserMessageComponent 用 Markdown(text, outputPad, 1, ...) 渲染消息正文，
 * 那 1 行垂直内边距让每条用户消息上下各多占一行。这里在消息重建之后把正文的内边距
 * 改成 0，消息块只占文字本身的行数，左右仍然保留 outputPad 的缩进。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadBundle } from "./lib/pi-bundle.ts";

/** 打补丁的标记，避免重复包装 rebuild */
const PATCH_FLAG = Symbol.for("pi.user-message-spacing");

/** 只用到 UserMessageComponent 重建时挂上去的子组件 */
type MarkdownChild = {
	paddingY?: number;
	invalidate?: () => void;
};

type UserMessageInstance = {
	children: MarkdownChild[];
	rebuild: () => void;
};

type UserMessageClass = {
	prototype: UserMessageInstance & { rebuild: (this: UserMessageInstance) => void };
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		const bundle = await loadBundle();
		const component = bundle.UserMessageComponent as UserMessageClass | undefined;
		if (!component) {
			throw new Error("打包入口里没有 UserMessageComponent，用户消息间距保持默认");
		}
		if ((component.prototype.rebuild as { [PATCH_FLAG]?: boolean })[PATCH_FLAG]) {
			return;
		}

		const originalRebuild = component.prototype.rebuild;

		const patchedRebuild = function (this: UserMessageInstance): void {
			originalRebuild.call(this);
			// 正文是 Markdown 组件，垂直内边距是它的字段
			for (const child of this.children) {
				if (child && typeof child === "object" && typeof child.paddingY === "number") {
					child.paddingY = 0;
					child.invalidate?.();
				}
			}
		};

		Object.defineProperty(patchedRebuild, PATCH_FLAG, { value: true });
		component.prototype.rebuild = patchedRebuild;
	});
}
