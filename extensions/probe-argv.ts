import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		let resolved: unknown;
		let resolveError: unknown;
		try {
			resolved = typeof import.meta.resolve === "function" ? import.meta.resolve("@earendil-works/pi-coding-agent") : "no import.meta.resolve";
		} catch (error) {
			resolveError = String(error);
		}
		writeFileSync(
			"/tmp/pi-ext-probe.json",
			JSON.stringify(
				{
					argv: process.argv,
					importMetaUrl: import.meta.url,
					resolved,
					resolveError,
				},
				null,
				2,
			),
		);
	});
}
