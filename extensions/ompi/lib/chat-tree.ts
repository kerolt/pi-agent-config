/**
 * 记录 transcript 容器里子组件的挂载关系。
 *
 * 工具行间距与工具分组都要知道某个组件挂在哪个容器、前后各是谁，而 Pi 的 Container
 * 只保留 children 数组，没有指回父容器的字段。这里在 Container 原型上包一层
 * addChild / removeChild / clear：记录挂载关系，并在子组件加入或移除时通知使用方。
 */

/** 带 children 的容器，Pi 的 Container 与工具分组卡都满足 */
export type ChatContainer = { children: unknown[] };

export type ChildHook = (parent: ChatContainer, child: unknown) => void;

type ContainerPrototype = {
	addChild: (this: ChatContainer, child: unknown) => void;
	removeChild: (this: ChatContainer, child: unknown) => void;
	clear: (this: ChatContainer) => void;
};

const PATCH_FLAG = Symbol.for("pi.ompi.chat-tree");

/** 每个子组件挂在哪个容器 */
const parents = new WeakMap<object, ChatContainer>();
const addHooks: ChildHook[] = [];
const removeHooks: ChildHook[] = [];

/** 找到 Container 原型：addChild 的归属者，所有容器都从它继承 */
export function containerPrototypeOf(component: { prototype: object }): ContainerPrototype {
	let prototype = Object.getPrototypeOf(component.prototype) as (ContainerPrototype & { [PATCH_FLAG]?: boolean }) | null;
	while (prototype !== null && !Object.prototype.hasOwnProperty.call(prototype, "addChild")) {
		prototype = Object.getPrototypeOf(prototype) as (ContainerPrototype & { [PATCH_FLAG]?: boolean }) | null;
	}
	if (prototype === null) {
		throw new Error("组件继承链里没有 addChild，找不到 Container 原型");
	}
	return prototype;
}

/** 给 Container 装上挂载记录，重复调用只装一次 */
export function patchChatTree(component: { prototype: object }): void {
	const prototype = containerPrototypeOf(component) as ContainerPrototype & { [PATCH_FLAG]?: boolean };
	if (prototype[PATCH_FLAG]) {
		return;
	}
	const originalAddChild = prototype.addChild;
	const originalRemoveChild = prototype.removeChild;
	const originalClear = prototype.clear;

	prototype.addChild = function (this: ChatContainer, child: unknown): void {
		originalAddChild.call(this, child);
		attach(this, child);
		for (const hook of addHooks) {
			hook(this, child);
		}
	};

	prototype.removeChild = function (this: ChatContainer, child: unknown): void {
		originalRemoveChild.call(this, child);
		detach(child);
		for (const hook of removeHooks) {
			hook(this, child);
		}
	};

	prototype.clear = function (this: ChatContainer): void {
		for (const child of this.children) {
			detach(child);
		}
		originalClear.call(this);
	};

	Object.defineProperty(prototype, PATCH_FLAG, { value: true });
}

/** 记下子组件挂在哪个容器，直接改 children 数组的地方要自己调用 */
export function attach(parent: ChatContainer, child: unknown): void {
	if (child !== null && typeof child === "object") {
		parents.set(child, parent);
	}
}

/** 忘掉挂载关系 */
export function detach(child: unknown): void {
	if (child !== null && typeof child === "object") {
		parents.delete(child);
	}
}

export function parentOf(child: object): ChatContainer | undefined {
	return parents.get(child);
}

/** 同一容器里的前一个同级组件，按当前 children 顺序实时计算 */
export function previousSiblingOf(child: object): unknown {
	const parent = parents.get(child);
	if (parent === undefined) {
		return undefined;
	}
	const index = parent.children.indexOf(child);
	if (index <= 0) {
		return undefined;
	}
	return parent.children[index - 1];
}

export function onChildAdded(hook: ChildHook): void {
	addHooks.push(hook);
}

export function onChildRemoved(hook: ChildHook): void {
	removeHooks.push(hook);
}
