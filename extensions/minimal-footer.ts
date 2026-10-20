/**
 * 简洁版页脚。
 *
 * 左侧：模型名、思考程度、工作区路径。
 * 右侧：本轮或上一轮回答耗时、本次会话累计回答耗时、输入输出 token 量、缓存命中率、上下文窗口用量。
 * 回答耗时从用户发送消息开始计时，回答结束后保留最后一次的数值。
 * 其他扩展通过 ctx.ui.setStatus 设置的状态仍然显示在下面几行，不会丢。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** 本轮回答的开始时间、上一轮的耗时与本次会话累计的回答耗时 */
let turnStartedAt: number | undefined;
let lastTurnElapsedMs: number | undefined;
let totalTurnElapsedMs = 0;
let ticker: ReturnType<typeof setInterval> | undefined;
let requestRender: (() => void) | undefined;

/** 耗时前面的图标；用几何符号保证宽度固定为 1 列 */
const ELAPSED_ICON = "◷";

/** 把毫秒格式化成 12s / 1m05s / 1h02m05s */
function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return `${hours}h${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
	}
	if (minutes > 0) {
		return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	}
	return `${seconds}s`;
}

/** 当前要展示的耗时：执行中是开始至今，结束后是最后一次的数值 */
function currentElapsed(turnActive: boolean): string | undefined {
	if (turnActive && turnStartedAt !== undefined) {
		return formatElapsed(Date.now() - turnStartedAt);
	}
	return turnActive || lastTurnElapsedMs === undefined ? undefined : formatElapsed(lastTurnElapsedMs);
}

/** 累计耗时包含正在执行的这一轮 */
function currentTotal(turnActive: boolean): string | undefined {
	if (turnStartedAt !== undefined) {
		return formatElapsed(totalTurnElapsedMs + (Date.now() - turnStartedAt));
	}
	return turnActive || lastTurnElapsedMs === undefined ? undefined : formatElapsed(totalTurnElapsedMs);
}

function stopTicker(): void {
	if (ticker !== undefined) {
		clearInterval(ticker);
		ticker = undefined;
	}
}

/** 计时期间每秒让页脚重绘一次 */
function startTicker(): void {
	if (ticker !== undefined) {
		return;
	}
	ticker = setInterval(() => requestRender?.(), 1000);
}

/** token 数量的紧凑写法 */
function formatTokens(count: number): string {
	if (count < 1000) {
		return String(count);
	}
	if (count < 10000) {
		return `${(count / 1000).toFixed(1)}k`;
	}
	if (count < 1000000) {
		return `${Math.round(count / 1000)}k`;
	}
	if (count < 10000000) {
		return `${(count / 1000000).toFixed(1)}M`;
	}
	return `${Math.round(count / 1000000)}M`;
}

/** 工作目录里的家目录前缀替换成 ~ */
function shortenHome(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) {
		return cwd;
	}
	const trimmed = home.replace(/[/\\]+$/, "");
	if (cwd === trimmed) {
		return "~";
	}
	// 必须是家目录下的路径，同级的相似前缀不替换
	if (!cwd.startsWith(`${trimmed}/`) && !cwd.startsWith(`${trimmed}\\`)) {
		return cwd;
	}
	return `~${cwd.slice(trimmed.length)}`;
}

function singleLine(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// 新会话从零开始，不沿用上一次会话的耗时
		stopTicker();
		turnStartedAt = undefined;
		lastTurnElapsedMs = undefined;
		totalTurnElapsedMs = 0;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const empty: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			let cachedKey = "";
			let totals = empty;
			let cacheHitRate: number | undefined;

			/** 统计整个会话的用量，用会话 id 与条目数量做缓存，避免每帧重算 */
			const collect = (): { totals: UsageTotals; cacheHitRate: number | undefined } => {
				const sessionManager = ctx.sessionManager;
				const key = `${sessionManager.getSessionId()}:${sessionManager.getEntryCount()}:${sessionManager.getLeafId()}`;
				if (key === cachedKey) {
					return { totals, cacheHitRate };
				}
				const next: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				let hit: number | undefined;
				for (const entry of sessionManager.getEntries()) {
					const record = entry as {
						type: string;
						usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
						message?: {
							role?: string;
							usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
						};
					};
					const usage = record.usage ?? record.message?.usage;
					if (!usage) {
						continue;
					}
					next.input += usage.input ?? 0;
					next.output += usage.output ?? 0;
					next.cacheRead += usage.cacheRead ?? 0;
					next.cacheWrite += usage.cacheWrite ?? 0;
					// 缓存命中率看最后一次模型回复：命中量占整个提示词的比例
					if (record.type === "message" && record.message?.role === "assistant") {
						const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
						hit = prompt > 0 ? ((usage.cacheRead ?? 0) / prompt) * 100 : undefined;
					}
				}
				cachedKey = key;
				totals = next;
				cacheHitRate = hit;
				return { totals, cacheHitRate };
			};

			return {
				invalidate() {},

				render(width: number): string[] {
					const { totals: usage, cacheHitRate: hitRate } = collect();
					const context = ctx.getContextUsage();
					const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percent = context?.percent;
					const elapsedText = currentElapsed(turnStartedAt !== undefined);
					const totalText = currentTotal(turnStartedAt !== undefined);

					const model = ctx.model?.id ?? "no-model";
					const thinking = pi.getThinkingLevel();
					const thinkingLabel = thinking === "off" ? "thinking off" : thinking;
					const path = shortenHome(ctx.sessionManager.getCwd());
					const left =
						theme.fg("text", model) +
						theme.fg("muted", ` • ${thinkingLabel}`) +
						"  " +
						theme.fg("dim", path);

					const percentText =
						percent === null || percent === undefined
							? `ctx ?/${formatTokens(contextWindow)}`
							: `ctx ${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
					const percentColor = percent !== null && percent !== undefined && percent > 90
						? "error"
						: percent !== null && percent !== undefined && percent > 70
							? "warning"
							: "dim";
					const right = [
						elapsedText === undefined ? undefined : theme.fg("dim", `${ELAPSED_ICON} ${elapsedText}`),
						totalText !== undefined && totalText !== elapsedText ? theme.fg("dim", `total ${totalText}`) : undefined,
						theme.fg("dim", `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`),
						theme.fg("dim", `CH ${hitRate === undefined ? "-" : `${hitRate.toFixed(1)}%`}`),
						theme.fg(percentColor, percentText),
					]
						.filter((item): item is string => item !== undefined)
						.join("  ");

					const gap = 2;
					// 左侧剩下少于这么多列时就整块让给右侧数据
					const minLeftColumns = 12;
					const rightWidth = visibleWidth(right);
					const lines: string[] = [];
					if (width - rightWidth - gap < minLeftColumns) {
						const rightOnly = truncateToWidth(right, width, "...");
						lines.push(" ".repeat(Math.max(0, width - visibleWidth(rightOnly))) + rightOnly);
					}
					else {
						const leftText = truncateToWidth(left, width - rightWidth - gap, "...");
						const padding = " ".repeat(Math.max(gap, width - visibleWidth(leftText) - rightWidth));
						lines.push(leftText + padding + right);
					}

					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const text = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, value]) => singleLine(value))
							.join(" ");
						lines.push(truncateToWidth(text, width, "..."));
					}
					return lines;
				},
			};
		});
	});

	// 从用户发送消息开始计时，agent 完全结束（含重试与自动压缩）时定格
	pi.on("before_agent_start", () => {
		turnStartedAt = Date.now();
		startTicker();
	});
	pi.on("agent_settled", () => {
		if (turnStartedAt === undefined) {
			return;
		}
		lastTurnElapsedMs = Date.now() - turnStartedAt;
		totalTurnElapsedMs += lastTurnElapsedMs;
		turnStartedAt = undefined;
		stopTicker();
		requestRender?.();
	});
	pi.on("session_shutdown", () => {
		stopTicker();
		turnStartedAt = undefined;
	});
}
