import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODE_STATUS = {
	ask: { label: "[Ask]", color: "muted" },
	plan: { label: "[Plan]", color: "accent" },
	auto: { label: "[Auto]", color: "warning" },
	bypass: { label: "[Bypass]", color: "error" },
} as const;

/** Bridges permission-modes state into Zentui's extension-status footer. */
export default function permissionModeZentui(pi: ExtensionAPI): void {
	let timer: NodeJS.Timeout | undefined;

	pi.on("session_start", (_event, ctx) => {
		let previousMode: string | undefined;

		const syncStatus = (): void => {
			const mode = process.env.PERMISSION_MODES_INHERITED_MODE;
			if (!mode || mode === previousMode) return;

			previousMode = mode;
			const status = MODE_STATUS[mode as keyof typeof MODE_STATUS];
			ctx.ui.setStatus(
				"permission-mode",
				status ? ctx.ui.theme.fg(status.color, status.label) : mode,
			);
		};

		syncStatus();
		timer = setInterval(syncStatus, 200);
		timer.unref();
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});
}
