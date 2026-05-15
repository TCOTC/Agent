/**
 * 对已插入 DOM 的 Markdown 片段调用 `agentProcessRender` 与 `ProtyleMethod.highlightRender`，
 * 与 `app/src/protyle/preview/index.ts` 顺序一致（上游 HTML 来自 `/api/lute/md2html` + `protyle-preview`）。
 * 注意：`highlightRender` 只认传入根节点自身的 `b3-typography`（不认祖先），预览代码块需对该根调用。
 */

import {agentProcessRender} from "./agentProcessRender";
import {ProtyleMethod} from "siyuan";

const PROTYLE_CDN = "/stage/protyle";

/** 仅语法高亮；与 `agentProcessRender` 解耦，由 `postRenderAgentMarkdownFragment` 统一顺序调用。 */
function highlightAgentMarkdownFragment(root: Element): void {
    if (typeof ProtyleMethod.highlightRender === "function") {
        ProtyleMethod.highlightRender(root, PROTYLE_CDN, 1);
    }
}

/**
 * 对已插入 DOM 的 Markdown 片段做与思源导出预览相近的后处理。
 */
export function postRenderAgentMarkdownFragment(root: Element): void {
    agentProcessRender(root);
    highlightAgentMarkdownFragment(root);
}

/**
 * 对若干已挂载的顶层节点做块级渲染，并对 `typographyHost` 做一次高亮（预览代码块依赖其上的 `b3-typography`）。
 */
export function postRenderMarkdownRootsInTypographyHost(
    roots: Iterable<Element>,
    typographyHost: Element,
): void {
    for (const el of roots) {
        agentProcessRender(el);
    }
    highlightAgentMarkdownFragment(typographyHost);
}
