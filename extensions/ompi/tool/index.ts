/**
 * 工具相关的界面改造集中入口。
 *
 * 工具行怎么画、行间留多少空行、连续调用怎么合并，三件事按下面的顺序安装：
 * 先注册渲染器，再调行间距，最后装分组。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import grouping from "./grouping.ts";
import outputLimit from "./output-limit.ts";
import rowSpacing from "./row-spacing.ts";

export default function (pi: ExtensionAPI) {
  outputLimit(pi);
  // rowSpacing(pi);
  grouping(pi);
}
