/**
 * 给 rpiv-todo 的事项面板加上鼠标单击折叠。
 *
 * 折叠时面板只留标题行与末尾的空白分隔行，展开时完全保持原样：面板的渲染内容、状态机、
 * ctrl+shift+t 快捷键都不受影响。做法是找到 rpiv-todo 注册到 aboveEditor widget 容器里的
 * 那个组件实例，改写它的 render 与 handleMouse。宿主没有提供包装 widget 的入口，只能改写
 * 实例方法，因此这里依赖两件内部事实：
 *
 * - widget 容器可以从 TUI 往下找到，容器里的子组件顺序与注册顺序一致；
 * - 组件是普通对象，render 与 handleMouse 都是可以替换的实例属性。
 *
 * 同一个容器里除本扩展的空 widget 之外，只会给 rpiv-todo 的面板加上这些行为。找不到面板
 * 时立即报错，不静默失效。
 */

import { Container, Spacer, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** 本扩展注册的空 widget 的 key，用来取得 TUI 引用并标记面板所在的容器 */
const OWNER_WIDGET_KEY = "todo-panel-fold";

/** 递归查找 widget 容器时的深度上限 */
const MAX_CONTAINER_DEPTH = 8;

interface PanelComponent extends Component {
	handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
}

export default function (pi: ExtensionAPI) {
	/** 面板组件是 rpiv-todo 每次注册时新建的，所以新的组件由 patch() 逐个包装 */
	const wrapped = new WeakSet<Component>();
	let tui: TUI | undefined;
	let owner: Component | undefined;
	let collapsed = false;
	let reported = false;

	/** 折叠时只保留标题行，并补上末尾的空白分隔行 */
	const fold = (lines: string[]): string[] => (collapsed && lines.length > 0 ? [lines[0], ""] : lines);

	/** 从 TUI 往下找到含本扩展空 widget 的容器 */
	const findContainer = (): Container | undefined => {
		if (!tui || !owner) return undefined;
		const visit = (component: Component, depth: number): Container | undefined => {
			if (!Array.isArray((component as Container).children)) return undefined;
			const container = component as Container;
			if (container.children.includes(owner)) return container;
			if (depth >= MAX_CONTAINER_DEPTH) return undefined;
			for (const child of container.children) {
				const found = visit(child, depth + 1);
				if (found) return found;
			}
			return undefined;
		};
		for (const child of tui.children) {
			const found = visit(child, 0);
			if (found) return found;
		}
		return undefined;
	};

	/** 容器里除本扩展空 widget 与分隔符之外的那个组件，就是 rpiv-todo 的面板 */
	const findPanel = (): PanelComponent | undefined => {
		const container = findContainer();
		if (!container) return undefined;
		return container.children.find((item) => item !== owner && !(item instanceof Spacer)) as PanelComponent | undefined;
	};

	/** 接管面板上的鼠标按压与单击 */
	const wrap = (panel: PanelComponent): void => {
		const render = panel.render.bind(panel);
		panel.render = (width: number) => fold(render(width));
		panel.handleMouse = (event) => {
			if (event.button !== "left") return undefined;
			// 先接住按压：Pi 才会把松开时的 click 派发到这里，同时不会在面板上开始文本选择
			if (event.type === "press") return { handled: true, render: false };
			if (event.type !== "click") return undefined;
			collapsed = !collapsed;
			// 行数变化需要整屏重绘
			tui?.requestRender(true);
			return { handled: true, render: true };
		};
		wrapped.add(panel);
	};

	const patch = (): void => {
		const panel = findPanel();
		if (!panel || wrapped.has(panel)) return;
		wrap(panel);
		tui?.requestRender(true);
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		collapsed = false;
		reported = false;
		tui = undefined;
		owner = undefined;

		const ui: ExtensionUIContext = ctx.ui;
		ui.setWidget(
			OWNER_WIDGET_KEY,
			(injectedTui) => {
				tui = injectedTui;
				const component: Component = {
					// 每帧都会走到这里，正好用来包装 rpiv-todo 重新注册后产生的新组件
					render: () => {
						patch();
						return [];
					},
					invalidate: () => {},
				};
				owner = component;
				return component;
			},
			{ placement: "aboveEditor" },
		);
	});

	// 面板此时应该已经注册，检查一次包装入口是否仍然有效
	pi.on("message_end", (event, ctx) => {
		const message = event.message as {
			role?: string;
			toolName?: string;
			details?: { tasks?: Array<{ status?: string }> };
		};
		if (message.role !== "toolResult" || message.toolName !== "todo") return;
		const tasks = message.details?.tasks;
		if (!tasks?.some((task) => task.status !== "deleted")) return;
		patch();
		if (reported || findPanel()) return;
		reported = true;
		ctx.ui.notify("没有找到 rpiv-todo 的面板，鼠标点击折叠未生效（面板结构可能已经变化）", "error");
	});

	pi.on("session_shutdown", () => {
		tui = undefined;
		owner = undefined;
	});
}
