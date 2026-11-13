import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import inputEditor from "./editor/input.ts";
import minimalFooter from "./footer/minimal.ts";
import transcriptMarks from "./transcript/marks.ts";
import stickyUserMessage from "./transcript/sticky.ts";
import toolOutputLimit from "./transcript/tool-output.ts";

export default function (pi: ExtensionAPI) {
  inputEditor(pi);
  minimalFooter(pi);

  transcriptMarks(pi);
  toolOutputLimit(pi);
  stickyUserMessage(pi);
}
