import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_KEY = Symbol.for("pi.ompi.degrade");

type DegradeState = {
	seen: Set<string>;
	pending: Set<string>;
};

const shared = globalThis as Record<symbol, DegradeState | undefined>;
if (shared[STATE_KEY] === undefined) {
	// 已报告的原因跨 reload 保留，避免每帧和每次重新加载重复提醒。
	Object.defineProperty(shared, STATE_KEY, { value: { seen: new Set<string>(), pending: new Set<string>() } });
}
const state = shared[STATE_KEY]!;

export function markDegraded(reason: string): void {
	if (state.seen.has(reason)) {
		return;
	}

	state.seen.add(reason);
	state.pending.add(reason);
}

export function flushDegraded(ctx: ExtensionContext): void {
	if (state.pending.size === 0) {
		return;
	}

	// RPC 也有 hasUI，终端外观的告警只需要出现在 TUI 中。
	if (ctx.hasUI && ctx.mode === "tui") {
		const reasons = [...state.pending];
		ctx.ui.notify(`codex 外观：${reasons.length} 项未生效（Pi 版本不兼容）— ${reasons.slice(0, 3).join("；")}`, "warning");
	}
	state.pending.clear();
}
