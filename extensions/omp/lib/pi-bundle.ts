/**
 * 定位命令行正在使用的那份 Pi 打包产物。
 *
 * 扩展导入的包入口可能是未打包的另一份代码，两份里各有一套同名类，改不到正在运行的那套。
 * 不同安装方式的入口位置不同，只有存在并导出消息组件的候选才可以使用。
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { markDegraded } from "./degrade.ts";

export type BundleProbe =
	| { ok: true; bundle: Record<string, unknown>; entry: string }
	| { ok: false; reason: string };

const PROBE_KEY = Symbol.for("pi.ompi.bundle.probe");
type BundleState = { probe?: Promise<BundleProbe> };
const shared = globalThis as Record<symbol, BundleState | undefined>;
if (shared[PROBE_KEY] === undefined) {
	// reload 会重新载入扩展模块，探测结果需要与运行中的 Pi 保持相同生命周期。
	Object.defineProperty(shared, PROBE_KEY, { value: {} });
}
const state = shared[PROBE_KEY]!;

async function probeEntry(entry: string): Promise<BundleProbe> {
	if (!existsSync(entry)) {
		return { ok: false, reason: `打包产物不存在：${entry}` };
	}

	try {
		const bundle = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
		if (typeof bundle.UserMessageComponent !== "function") {
			return { ok: false, reason: `打包产物缺少 UserMessageComponent：${entry}` };
		}

		return { ok: true, bundle, entry };
	}
	catch (error) {
		return { ok: false, reason: `无法载入打包产物 ${entry}：${String(error)}` };
	}
}

async function probeBundle(): Promise<BundleProbe> {
	const cliEntry = process.argv[1];
	if (cliEntry) {
		const candidates = [
			join(dirname(cliEntry), "..", "@earendil-works", "pi-coding-agent", "dist", "bundle", "index.js"),
			join(dirname(cliEntry), "index.js"),
		];
		for (const entry of candidates) {
			const result = await probeEntry(entry);
			if (result.ok) {
				return result;
			}
		}
	}

	try {
		const entry = createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent");
		return await probeEntry(join(dirname(entry), "bundle", "index.js"));
	}
	catch (error) {
		return { ok: false, reason: `无法解析 Pi 包入口：${String(error)}` };
	}
}

/** 失败也缓存，避免热路径和 reload 反复导入或报告同一个原因。 */
export async function loadBundle(): Promise<Record<string, unknown> | undefined> {
	state.probe ??= probeBundle().then((result) => {
		if (!result.ok) {
			markDegraded("找不到运行中的 Pi 打包产物");
		}
		return result;
	});
	const result = await state.probe;
	return result.ok ? result.bundle : undefined;
}
