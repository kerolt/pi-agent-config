/**
 * 记录 transcript 容器里子组件的挂载关系。
 *
 * 工具行间距与工具分组都要知道某个组件挂在哪个容器、前后各是谁，而 Pi 的 Container
 * 只保留 children 数组，没有指回父容器的字段。这里在 Container 原型上包一层
 * addChild / removeChild / clear：记录挂载关系，并在子组件加入或移除时通知使用方。
 *
 * 状态放在 globalThis 上：Pi 重新加载扩展时模块会被重新求值，原型上的补丁却还在，
 * 挂载记录与回调必须跟着补丁走，不能留在旧模块里。
 */

/** 带 children 的容器，Pi 的 Container 与工具分组卡都满足 */
export type ChatContainer = { children: unknown[] };

export type ChildHook = (parent: ChatContainer, child: unknown) => void;

type ContainerPrototype = {
	addChild: (this: ChatContainer, child: unknown) => void;
	removeChild: (this: ChatContainer, child: unknown) => void;
	clear: (this: ChatContainer) => void;
};

type Registry = {
	/** 每个子组件挂在哪个容器 */
	parents: WeakMap<object, ChatContainer>;
	addHooks: ChildHook[];
	removeHooks: ChildHook[];
	/** 各模块跨重新加载共享的对象，例如工具分组的类 */
	shared: Map<string, unknown>;
};

const PATCH_FLAG = Symbol.for("pi.ompi.chat-tree");
const REGISTRY_KEY = Symbol.for("pi.ompi.chat-tree.registry");

function registry(): Registry {
	const existing = (globalThis as Record<symbol, Registry | undefined>)[REGISTRY_KEY];
	if (existing !== undefined) {
		return existing;
	}
	const created: Registry = { parents: new WeakMap(), addHooks: [], removeHooks: [], shared: new Map() };
	(globalThis as Record<symbol, Registry | undefined>)[REGISTRY_KEY] = created;
	return created;
}

/** 跨模块重新加载共享一个对象，同名只创建一次 */
export function sharedObject<T>(name: string, create: () => T): T {
	const shared = registry().shared;
	if (!shared.has(name)) {
		shared.set(name, create());
	}
	return shared.get(name) as T;
}

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
		for (const hook of registry().addHooks) {
			hook(this, child);
		}
	};

	prototype.removeChild = function (this: ChatContainer, child: unknown): void {
		originalRemoveChild.call(this, child);
		detach(child);
		for (const hook of registry().removeHooks) {
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
		registry().parents.set(child, parent);
	}
}

/** 忘掉挂载关系 */
export function detach(child: unknown): void {
	if (child !== null && typeof child === "object") {
		registry().parents.delete(child);
	}
}

export function parentOf(child: object): ChatContainer | undefined {
	return registry().parents.get(child);
}

/** 同一容器里的前一个同级组件，按当前 children 顺序实时计算 */
export function previousSiblingOf(child: object): unknown {
	const parent = parentOf(child);
	if (parent === undefined) {
		return undefined;
	}
	const index = parent.children.indexOf(child);
	if (index <= 0) {
		return undefined;
	}
	return parent.children[index - 1];
}

/** 设置子组件加入时的回调，重新加载扩展时替换掉上一份 */
export function setChildAddedHook(hook: ChildHook): void {
	const hooks = registry().addHooks;
	hooks.length = 0;
	hooks.push(hook);
}

/** 设置子组件移除时的回调，重新加载扩展时替换掉上一份 */
export function setChildRemovedHook(hook: ChildHook): void {
	const hooks = registry().removeHooks;
	hooks.length = 0;
	hooks.push(hook);
}
