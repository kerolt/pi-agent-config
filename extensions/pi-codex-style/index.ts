import { flushDegraded } from "./lib/degrade.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import inputEditor from "./editor/input.ts";
import minimalFooter from "./footer/minimal.ts";
import transcriptMarkdown from "./transcript/markdown.ts";
import toolOutputLimit from "./transcript/tool-output.ts";
import turnStats from "./transcript/turn-stats.ts";

export default function (pi: ExtensionAPI) {
	inputEditor(pi);
	minimalFooter(pi);

	transcriptMarkdown(pi);
	toolOutputLimit(pi);
	turnStats(pi);

	pi.on("session_start", (_event, ctx) => {
		flushDegraded(ctx);
	});
}
