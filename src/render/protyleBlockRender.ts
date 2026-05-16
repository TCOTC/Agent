/**
 * 与 `app/src/protyle/util/processCode.ts` 中 `processRender` 等价：对容器内 mermaid / 图表 / math / HTML 块等做块级渲染；
 * 若当前遍历到的块根自身带 `code-block` 类（与 Lute 预览 `<pre class="code-block">` 一致），再在 `blocksRoot`（带 `b3-typography` 的根容器）上调用一次 `highlightRender`。
 * 实现放在插件内，不修改思源主工程。
 */
import {ProtyleMethod} from "siyuan";

const RENDER_MAP: Record<string, (root: Element) => void> = {
    abc: ProtyleMethod.abcRender,
    plantuml: ProtyleMethod.plantumlRender,
    mermaid: ProtyleMethod.mermaidRender,
    flowchart: ProtyleMethod.flowchartRender,
    echarts: ProtyleMethod.chartRender,
    mindmap: ProtyleMethod.mindmapRender,
    graphviz: ProtyleMethod.graphvizRender,
    math: ProtyleMethod.mathRender,
};

/**
 * 对若干已挂载的预览块根节点依次做 Protyle 块级渲染；若任一块根 `classList` 含 `code-block`，
 * 再对 `blocksRoot` 调用一次 `ProtyleMethod.highlightRender`（须为带 `b3-typography` 的容器，与思源预览一致）。
 * 单块可传 `[el]`。同一次遍历完成块级渲染与代码块检测，避免为 `some` 再扫一遍。
 */
export function renderProtyleBlock(blocks: Iterable<Element>, blocksRoot: Element): void {
    let hasCodeBlockPreview = false;
    for (const block of blocks) {
        const language = block.getAttribute("data-subtype");
        if (language && RENDER_MAP[language]) {
            RENDER_MAP[language](block);
        } else if (block.getAttribute("data-type") === "NodeHTMLBlock") {
            ProtyleMethod.htmlRender(block);
        } else {
            for (const render of Object.values(RENDER_MAP)) {
                render(block);
            }
            ProtyleMethod.htmlRender(block);
        }
        if (!hasCodeBlockPreview && block.classList.contains("code-block")) {
            hasCodeBlockPreview = true;
        }
    }
    if (hasCodeBlockPreview) {
        ProtyleMethod.highlightRender(blocksRoot);
    }
}
