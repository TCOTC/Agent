import {
    ArrowUp,
    Bot,
    Download,
    History,
    PanelRight,
    Pin,
    Plus,
    RefreshCw,
    Settings,
    Square,
    X,
} from "lucide";

/** Lucide IconNode：`[tag, attrs][]` */
type IconNode = ReadonlyArray<readonly [string, Readonly<Record<string, string | number>>]>;

export const AGENT_ICON_IDS = {
    agent: "iconAgent",
    plus: "iconAgentPlus",
    history: "iconAgentHistory",
    refresh: "iconAgentRefresh",
    download: "iconAgentDownload",
    pin: "iconAgentPin",
    settings: "iconAgentSettings",
    panelRight: "iconAgentPanelRight",
    x: "iconAgentX",
    arrowUp: "iconAgentArrowUp",
    square: "iconAgentSquare",
} as const;

export type AgentIconId = typeof AGENT_ICON_IDS[keyof typeof AGENT_ICON_IDS];

const lucideSymbolAttrs = (strokeWidth: number) =>
    `fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"`;

const AGENT_LUCIDE_ICONS: ReadonlyArray<{ id: AgentIconId; node: IconNode; strokeWidth?: number }> = [
    {id: AGENT_ICON_IDS.agent, node: Bot},
    {id: AGENT_ICON_IDS.plus, node: Plus},
    {id: AGENT_ICON_IDS.history, node: History},
    {id: AGENT_ICON_IDS.refresh, node: RefreshCw},
    {id: AGENT_ICON_IDS.download, node: Download},
    {id: AGENT_ICON_IDS.pin, node: Pin},
    {id: AGENT_ICON_IDS.settings, node: Settings},
    {id: AGENT_ICON_IDS.panelRight, node: PanelRight},
    {id: AGENT_ICON_IDS.x, node: X},
    {id: AGENT_ICON_IDS.arrowUp, node: ArrowUp, strokeWidth: 2.5},
    {id: AGENT_ICON_IDS.square, node: Square},
];

function escapeAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function iconNodeToInnerHtml(nodes: IconNode): string {
    return nodes.map(([tag, attrs]) => {
        const attrStr = Object.entries(attrs)
            .filter(([, value]) => value !== undefined)
            .map(([name, value]) => `${name}="${escapeAttr(String(value))}"`)
            .join(" ");
        return `<${tag}${attrStr ? ` ${attrStr}` : ""}></${tag}>`;
    }).join("");
}

function lucideToSymbol(id: AgentIconId, nodes: IconNode, strokeWidth = 2): string {
    return `<symbol id="${id}" viewBox="0 0 24 24" ${lucideSymbolAttrs(strokeWidth)}>${iconNodeToInnerHtml(nodes)}</symbol>`;
}

/** 生成思源 `addIcons` 所需的 `<symbol>` 片段 */
export function buildAgentIconSymbols(): string {
    return AGENT_LUCIDE_ICONS.map(({id, node, strokeWidth}) => lucideToSymbol(id, node, strokeWidth)).join("");
}

export interface AgentIconOptions {
    className?: string;
    size?: number;
    attrs?: Record<string, string>;
}

/** 返回 `<svg><use xlink:href="#…"></use></svg>` 字符串，供模板内联 */
export function agentIconHtml(id: AgentIconId, opts: AgentIconOptions = {}): string {
    const size = opts.size ?? 16;
    const className = opts.className ? ` class="${escapeAttr(opts.className)}"` : "";
    const extraAttrs = opts.attrs
        ? Object.entries(opts.attrs).map(([name, value]) =>
            value === "" ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`
        ).join("")
        : "";
    return `<svg${className} width="${size}" height="${size}" aria-hidden="true"${extraAttrs}><use xlink:href="#${id}"></use></svg>`;
}

/** 创建 `<svg><use>` DOM 节点 */
export function createAgentIcon(id: AgentIconId, opts: AgentIconOptions = {}): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    if (opts.className) {
        svg.setAttribute("class", opts.className);
    }
    const size = opts.size ?? 16;
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("aria-hidden", "true");
    if (opts.attrs) {
        for (const [name, value] of Object.entries(opts.attrs)) {
            svg.setAttribute(name, value);
        }
    }
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", `#${id}`);
    svg.appendChild(use);
    return svg;
}
