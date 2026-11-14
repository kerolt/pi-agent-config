/** 根据 Pi 的原生容器和消息组件计算 transcript 中的用户消息范围。 */

import type { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { markDegraded } from "./degrade.ts";
import { loadBundle } from "./pi-bundle.ts";

export type TranscriptScrollView = Component & {
	readonly scrollTop: number;
	scrollTo(row: number): void;
};

type LayoutBox = {
	component: Component;
	rect: { width: number };
	children: LayoutBox[];
	scrollView?: unknown;
};

export type TranscriptLayoutFrame = { root: LayoutBox };

export type UserMessageRange = {
	component: Component;
	startRow: number;
	endRow: number;
	firstTextRow: number;
	preview: string;
	hasMore: boolean;
};

export type TranscriptLayoutReader = (
	frame: TranscriptLayoutFrame,
	transcript: TranscriptScrollView,
) => UserMessageRange[] | undefined;

type NativeContainer = Component & { children: Component[] };
type UserMessageClass = { new (...args: never[]): UserMessageComponent; prototype: UserMessageComponent };

function findScrollBox(box: LayoutBox, transcript: TranscriptScrollView): LayoutBox | undefined {
	if (box.scrollView === transcript) {
		return box;
	}

	for (const child of box.children) {
		const found = findScrollBox(child, transcript);
		if (found !== undefined) {
			return found;
		}
	}

	return undefined;
}

/** 组件必须来自运行中的 bundle，原生 Container 的 render 按 children 顺序连接展示行。 */
export async function loadTranscriptLayout(): Promise<TranscriptLayoutReader | undefined> {
	const bundle = await loadBundle();
	if (bundle === undefined) {
		markDegraded("找不到运行中的 Pi 打包产物");
		return undefined;
	}

	const userClass = bundle.UserMessageComponent as UserMessageClass | undefined;
	if (typeof userClass !== "function" || userClass.prototype === undefined) {
		markDegraded("打包产物缺少 UserMessageComponent");
		return undefined;
	}

	const containerPrototype = Object.getPrototypeOf(userClass.prototype) as NativeContainer | null;
	if (containerPrototype === null || !Object.hasOwn(containerPrototype, "addChild") ||
		!Object.hasOwn(containerPrototype, "render") || typeof containerPrototype.render !== "function" ||
		typeof (containerPrototype as NativeContainer & { addChild?: unknown }).addChild !== "function") {
		markDegraded("用户消息组件的父类缺少 addChild/render");
		return undefined;
	}
	const containerRender = containerPrototype.render;

	return (frame, transcript) => {
		const scrollBox = findScrollBox(frame.root, transcript);
		if (scrollBox === undefined) {
			return undefined;
		}

		const documentBox = scrollBox.children[0];
		if (documentBox === undefined) {
			markDegraded("transcript 布局中缺少内容组件");
			return undefined;
		}

		// 使用滚动视口分配的内容宽度，让消息换行与位置计算保持一致。
		const width = documentBox.rect.width;
		const ranges: UserMessageRange[] = [];
		let row = 0;

		const visit = (component: Component): void => {
			if (component instanceof userClass) {
				const lines = component.render(width);
				const startRow = row;
				row += lines.length;

				// 预览和后续内容判断都限定在当前用户消息的展示行内。
				const textLines = lines.map((line) => stripTerminalSequences(line).trimEnd());
				const first = textLines.findIndex((line) => line.trim() !== "");
				if (first >= 0) {
					ranges.push({
						component,
						startRow,
						endRow: row,
						firstTextRow: startRow + first,
						preview: textLines[first]!,
						hasMore: textLines.slice(first + 1).some((line) => line.trim() !== ""),
					});
				}

				return;
			}

			// 原生纵向 Container 按子项累计高度，其余组件使用自身的整体高度。
			if (Object.getPrototypeOf(component) === containerPrototype && component.render === containerRender) {
				for (const child of (component as NativeContainer).children) {
					visit(child);
				}

				return;
			}

			row += component.render(width).length;
		};

		visit(documentBox.component);
		return ranges;
	};
}
