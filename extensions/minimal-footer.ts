/**
 * 简洁版页脚。
 *
 * 左侧：模型名、思考程度、工作区路径。
 * 右侧：输入输出 token 量、缓存命中率、上下文窗口用量。
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
		ctx.ui.setFooter((_tui, theme, footerData) => {
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
						theme.fg("dim", `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`),
						theme.fg("dim", `CH ${hitRate === undefined ? "-" : `${hitRate.toFixed(1)}%`}`),
						theme.fg(percentColor, percentText),
					].join("  ");

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
}
