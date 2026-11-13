/**
 * 定位命令行正在使用的那份 Pi 打包产物。
 *
 * 命令行入口位于 node_modules/.bin，同级 @earendil-works 目录下是 dist/bundle。
 * 扩展导入的包入口是未打包的另一份代码，两份里各有一套同名类，改不到正在运行的那套。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** 打包产物里的模块地址 */
export function bundleEntry(): string {
	const cliEntry = process.argv[1];
	if (!cliEntry) {
		throw new Error("无法确定 Pi 的命令行入口");
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
		throw new Error(`找不到 Pi 的打包入口 ${entry}`);
	}

	return entry;
}

/** 载入正在运行的那份打包产物 */
export async function loadBundle(): Promise<Record<string, unknown>> {
	return (await import(pathToFileURL(bundleEntry()).href)) as Record<string, unknown>;
}
