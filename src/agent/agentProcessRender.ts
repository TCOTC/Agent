/**
 * 与 `app/src/protyle/util/processCode.ts` 中 `processRender` 等价：对容器内 mermaid / 图表 / math / HTML 块等做块级渲染。
 * 实现放在插件内，不修改思源主工程；具体渲染委托给 `siyuan` 模块暴露的 `ProtyleMethod` 静态方法。
 */
import {ProtyleMethod} from "siyuan";

const RENDER_MAP: Record<string, (previewPanel: Element) => void> = {
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
 * 与思源导出预览里对 `b3-typography` 根节点调用 `processRender` 的语义一致。
 */
export function agentProcessRender(previewPanel: Element): void {
    const language = previewPanel.getAttribute("data-subtype");
    if (language && RENDER_MAP[language]) {
        RENDER_MAP[language](previewPanel);
        return;
    }
    if (previewPanel.getAttribute("data-type") === "NodeHTMLBlock") {
        ProtyleMethod.htmlRender(previewPanel);
        return;
    }
    for (const render of Object.values(RENDER_MAP)) {
        render(previewPanel);
    }
    ProtyleMethod.htmlRender(previewPanel);
}
