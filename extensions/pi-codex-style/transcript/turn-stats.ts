/**
 * 每一轮回答结束后，在助手回复下面补一行耗时。
 *
 * 形如 `Worked for 4m 40s • 42.1 tps • 6:14 PM`。数据写成自定义条目存进会话，
 * 重新打开会话时按原样显示，不进入模型上下文。
 *
 * 耗时从用户发送消息开始，到 Pi 真正空闲为止；tps 只用模型生成时间计算，
 * 也就是各条回复的结束时刻减去该次请求的开始时刻，工具执行与排队不计入。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { markDegraded } from "../lib/degrade.ts";

/** 自定义条目类型名 */
const ENTRY_TYPE = "omp-turn-stats";

/** 内容左缩进，与正文的 outputPad 对齐 */
const CONTENT_PAD = 1;

interface TurnStats {
	/** 本轮从用户发送消息到空闲的总耗时 */
	elapsedMs: number;
	/** 本轮全部回复的输出 token 数 */
	outputTokens: number;
	/** 本轮全部回复的模型生成耗时 */
	generateMs: number;
	/** 空闲时刻 */
	completedAt: number;
}

let turnStartedAt: number | undefined;
let outputTokens = 0;
let generateMs = 0;

/** 12s / 4m 40s / 1h 02m 05s */
function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
	}
	if (minutes > 0) {
		return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	}

	return `${seconds}s`;
}

/** 6:14 PM */
function formatClock(time: number): string {
	const date = new Date(time);
	const hours = date.getHours();
	const display = hours % 12 === 0 ? 12 : hours % 12;
	const suffix = hours < 12 ? "AM" : "PM";

	return `${display}:${String(date.getMinutes()).padStart(2, "0")} ${suffix}`;
}

function lineText(stats: TurnStats): string {
	const parts = [`Worked for ${formatElapsed(stats.elapsedMs)}`];
	if (stats.outputTokens > 0 && stats.generateMs > 0) {
		parts.push(`${(stats.outputTokens / (stats.generateMs / 1000)).toFixed(1)} tps`);
	}
	parts.push(formatClock(stats.completedAt));

	return parts.join(" • ");
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<TurnStats>(ENTRY_TYPE, (entry, _options, theme) => {
		const stats = entry.data;
		if (stats === undefined) {
			markDegraded("耗时条目缺少数据");
			return undefined;
		}

		return new Text(theme.fg("dim", lineText(stats)), CONTENT_PAD, 0);
	});

	pi.on("before_agent_start", () => {
		turnStartedAt = Date.now();
		outputTokens = 0;
		generateMs = 0;
	});

	pi.on("message_end", ({ message }) => {
		if (message.role !== "assistant") {
			return;
		}

		outputTokens += message.usage.output;
		generateMs += Math.max(0, Date.now() - message.timestamp);
	});

	pi.on("agent_before_settle", (event) => {
		if (turnStartedAt === undefined) {
			return;
		}

		const stats: TurnStats = {
			elapsedMs: Date.now() - turnStartedAt,
			outputTokens,
			generateMs,
			completedAt: Date.now(),
		};
		turnStartedAt = undefined;

		return { entries: [...event.entries, { type: "custom", customType: ENTRY_TYPE, data: stats }] };
	});

	pi.on("session_shutdown", () => {
		turnStartedAt = undefined;
	});
}
