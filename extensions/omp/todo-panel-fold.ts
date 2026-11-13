/**
 * 给 rpiv-todo 的事项面板加上鼠标单击折叠。
 *
 * 折叠时面板只留标题行与末尾的空白分隔行，展开时完全保持原样：面板的渲染内容、状态机、
 * ctrl+shift+t 快捷键都不受影响。单击面板切换折叠，按住拖动仍然走 Pi 自己的文本选择，
 * 所以面板里的文本照旧可以选中与复制。做法是找到 rpiv-todo 注册到 aboveEditor widget 容器里的
 * 那个组件实例，改写它的 render 与 handleMouse。宿主没有提供包装 widget 的入口，只能改写
 * 实例方法，因此这里依赖两件内部事实：
 *
 * - widget 容器可以从 TUI 往下找到，容器里的子组件是各个扩展注册的组件实例；
 * - 组件是普通对象，render 与 handleMouse 都是可以替换的实例属性。
 *
 * 面板不能按位置认：aboveEditor 容器里第一个不是本扩展的组件也不一定是它，本扩展自己的
 * 用户消息吸附条以及别的扩展都会往同一个容器里注册 widget，谁先注册谁在前面。
 * 这里改为按内容认：rpiv-todo 的面板首行是「●/○ 标题 (已完成/总数)」，这个形状与语言无关。
 * 认不出来时立即报错，不静默失效。
 */

import { Container, Spacer, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** 本扩展注册的空 widget 的 key，用来取得 TUI 引用并标记面板所在的容器 */
const OWNER_WIDGET_KEY = "todo-panel-fold";

/** 递归查找 widget 容器时的深度上限 */
const MAX_CONTAINER_DEPTH = 8;

/** 探页面板时用的渲染宽度：够宽才不会把标题里的计数截掉 */
const PROBE_WIDTH = 160;

/** rpiv-todo 面板首行的形状：圆点 + 标题 + (已完成/总数)，标题本身随语言变化 */
const TODO_HEADING = /^[●○]\s\S.*\(\d+\s*\/\s*\d+\)$/;

/** 去掉 SGR 颜色序列，只留可见文本 */
const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

interface PanelComponent extends Component {
	handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
}

export default function (pi: ExtensionAPI) {
	/** 面板组件是 rpiv-todo 每次注册时新建的，所以新的组件由 patch() 逐个包装 */
	const wrapped = new WeakSet<Component>();
	let tui: TUI | undefined;
	let owner: Component | undefined;
	/** 上一轮看到的候选组件，容器内容没变化就不重复探页 */
	let candidates: Component[] = [];
	let collapsed = false;
	let notified = false;

	/** 折叠时只保留标题行，并补上末尾的空白分隔行 */
	const fold = (lines: string[]): string[] => (collapsed && lines.length > 0 ? [lines[0], ""] : lines);

	/** 从 TUI 往下找到含本扩展空 widget 的容器 */
	const findContainer = (): Container | undefined => {
		if (!tui || !owner) return undefined;
		const marker = owner;
		const visit = (component: Component, depth: number): Container | undefined => {
			if (!Array.isArray((component as Container).children)) return undefined;
			const container = component as Container;
			if (container.children.includes(marker)) return container;
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

	/** 探页首行，判断这个 widget 是不是 rpiv-todo 的面板 */
	const isTodoPanel = (component: Component): boolean => {
		if (component === owner || component instanceof Spacer) return false;
		if (typeof component.render !== "function") return false;
		let lines: string[];
		try {
			lines = component.render(PROBE_WIDTH);
		} catch {
			return false;
		}
		return TODO_HEADING.test(stripAnsi(lines[0] ?? "").trim());
	};

	/** 只在完整的单击上切换折叠，按压与拖动都放行给 Pi 的文本选择 */
	const onPanelMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
		if (event.button !== "left" || event.type !== "click") return undefined;
		collapsed = !collapsed;
		// 行数变化需要整屏重绘
		tui?.requestRender(true);
		return { handled: true, render: true };
	};

	/**
	 * 接管面板的渲染与单击，按压不接管：按下时没有组件接手的场合，Pi 会开始文本选择，
	 * 并在松开后没有拖动的情况下合成一个 click 事件再派发给布局。放行按压因此可以同时
	 * 保住面板上的拖选与复制。
	 */
	const wrap = (panel: PanelComponent): void => {
		const render = panel.render.bind(panel);
		panel.render = (width: number) => fold(render(width));
		panel.handleMouse = onPanelMouse;
		wrapped.add(panel);
	};

	const patch = (): void => {
		const container = findContainer();
		if (!container) return;
		const next = container.children.filter((item) => item !== owner && !(item instanceof Spacer));
		const unchanged = next.length === candidates.length && next.every((item, index) => item === candidates[index]);
		// 认到面板之后就不再探页，除非容器的组件集合变了（有 widget 注册或注销）
		if (unchanged && candidates.some((item) => wrapped.has(item))) return;
		candidates = next;
		let patched = false;
		for (const item of next) {
			if (wrapped.has(item) || !isTodoPanel(item)) continue;
			wrap(item as PanelComponent);
			patched = true;
		}
		if (patched) tui?.requestRender(true);
	};

	const hasPanel = (): boolean => candidates.some((item) => wrapped.has(item));

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		collapsed = false;
		notified = false;
		candidates = [];
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
		if (hasPanel() || notified) return;
		notified = true;
		ctx.ui.notify("没有找到 rpiv-todo 的面板，鼠标点击折叠未生效（面板结构可能已经变化）", "error");
	});

	pi.on("session_shutdown", () => {
		tui = undefined;
		owner = undefined;
		candidates = [];
	});
}
