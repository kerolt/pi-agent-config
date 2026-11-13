/**
 * 自己改造 Pi 界面与行为的扩展集中入口。
 *
 * Pi 对每个子目录只取 index.ts 作为扩展入口，所以这里把各模块的工厂依次调用一遍，
 * 让它们共用同一个 ExtensionAPI 实例。新增模块时在这里补一行。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import inputEditor from "./input-editor.ts";
import minimalFooter from "./minimal-footer.ts";
import todoPanelFold from "./todo-panel-fold.ts";
import toolActivity from "./tool/activity.ts";
import toolOutputLimit from "./tool/output-limit.ts";
import userMessageRail from "./user-message-rail.ts";

export default function (pi: ExtensionAPI) {
  inputEditor(pi);
  minimalFooter(pi);
  toolOutputLimit(pi);
  toolActivity(pi);
  todoPanelFold(pi);
  userMessageRail(pi);
}
