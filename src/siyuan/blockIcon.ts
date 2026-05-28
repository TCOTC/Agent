/** 与思源 `app/src/editor/getIcon.ts` 对齐的块类型 → SVG symbol 名 */
export function getIconByType(type: string, sub?: string | null): string {
    let iconName = "";
    switch (type) {
        case "NodeDocument":
            iconName = "iconFile";
            break;
        case "NodeThematicBreak":
            iconName = "iconLine";
            break;
        case "NodeParagraph":
            iconName = "iconParagraph";
            break;
        case "NodeHeading":
            if (sub) {
                iconName = "icon" + sub.toUpperCase();
            } else {
                iconName = "iconHeadings";
            }
            break;
        case "NodeBlockquote":
            iconName = "iconQuote";
            break;
        case "NodeCallout":
            iconName = "iconCallout";
            break;
        case "NodeList":
            if (sub === "t") {
                iconName = "iconCheck";
            } else if (sub === "o") {
                iconName = "iconOrderedList";
            } else {
                iconName = "iconList";
            }
            break;
        case "NodeListItem":
            iconName = "iconListItem";
            break;
        case "NodeCodeBlock":
        case "NodeYamlFrontMatter":
            iconName = "iconCode";
            break;
        case "NodeTable":
            iconName = "iconTable";
            break;
        case "NodeBlockQueryEmbed":
            iconName = "iconSQL";
            break;
        case "NodeSuperBlock":
            iconName = "iconSuper";
            break;
        case "NodeMathBlock":
            iconName = "iconMath";
            break;
        case "NodeHTMLBlock":
            iconName = "iconHTML5";
            break;
        case "NodeWidget":
            iconName = "iconBoth";
            break;
        case "NodeIFrame":
            iconName = "iconGlobe";
            break;
        case "NodeVideo":
            iconName = "iconVideo";
            break;
        case "NodeAudio":
            iconName = "iconRecord";
            break;
        case "NodeAttributeView":
            iconName = "iconDatabase";
            break;
        default:
            iconName = "iconParagraph";
            break;
    }
    return iconName;
}

const ABBR_TO_NODE_TYPE: Record<string, string> = {
    d: "NodeDocument",
    h: "NodeHeading",
    l: "NodeList",
    i: "NodeListItem",
    c: "NodeCodeBlock",
    m: "NodeMathBlock",
    t: "NodeTable",
    b: "NodeBlockquote",
    s: "NodeSuperBlock",
    p: "NodeParagraph",
    html: "NodeHTMLBlock",
    query_embed: "NodeBlockQueryEmbed",
    av: "NodeAttributeView",
    iframe: "NodeIFrame",
    widget: "NodeWidget",
    tb: "NodeThematicBreak",
    video: "NodeVideo",
    audio: "NodeAudio",
    callout: "NodeCallout",
};

/** 将内核返回的 type（缩写或 Node* 全名）规范为 `getIconByType` 所需格式 */
export function normalizeNodeBlockType(
    rawType: unknown,
    rawSubtype?: unknown,
): {blockType: string; blockSubtype: string | null} {
    const t = String(rawType ?? "p").trim();
    const blockType = t.startsWith("Node") ? t : (ABBR_TO_NODE_TYPE[t] ?? "NodeParagraph");
    const sub = rawSubtype != null && String(rawSubtype).trim() !== ""
        ? String(rawSubtype).trim()
        : null;
    return {blockType, blockSubtype: sub};
}

export function createSiyuanSvgIcon(iconId: string, className?: string): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    if (className) {
        svg.setAttribute("class", className);
    }
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", `#${iconId}`);
    svg.appendChild(use);
    return svg;
}
