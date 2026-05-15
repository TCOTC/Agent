/**
 * 将 Lute `BlockDOM2HTML` 等路径产生的 HTML 经 `markdownDomUpgrade` 调整为更接近导出预览的 DOM，
 * 再调用 `agentProcessRender` 与 `ProtyleMethod.highlightRender`，与 `app/src/protyle/preview/index.ts` 顺序一致。
 */

import {agentProcessRender} from "./agentProcessRender";
import {
    upgradeChartLanguageDivs,
    upgradeInlineMathSpans,
    upgradePlainCodeBlocksToPreview,
    upgradeVditorTaskListItems,
} from "./markdownDomUpgrade";
import {ProtyleMethod} from "siyuan";

const PROTYLE_CDN = "/stage/protyle";

/**
 * 对已插入 DOM 的 Markdown 片段做与思源导出预览相近的后处理。
 */
export function postRenderAgentMarkdownFragment(root: Element): void {
    upgradeChartLanguageDivs(root);
    upgradeInlineMathSpans(root);
    upgradePlainCodeBlocksToPreview(root);
    upgradeVditorTaskListItems(root);
    agentProcessRender(root);
    if (typeof ProtyleMethod.highlightRender === "function") {
        ProtyleMethod.highlightRender(root, PROTYLE_CDN, 1);
    }
}
