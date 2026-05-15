/**
 * 将 `MarkdownStr` / `BlockDOM2HTML`（`Md2HTML`）产生的 HTML 调整为更接近思源 `ProtylePreview` + 导出预览的 DOM，
 * 以便 `agentProcessRender` / `ProtyleMethod.highlightRender` 能正确识别（与 Lute `languagesNoHighlight` 对齐）。
 */

/** 与 `lute/render/renderer.go` 中 `languagesNoHighlight` 一致，并含数学块 `math`（`HtmlRenderer` 为 `div.language-math`） */
const LANGUAGES_NO_HIGHLIGHT = new Set([
    "math",
    "mermaid",
    "echarts",
    "abc",
    "graphviz",
    "mindmap",
    "flowchart",
    "plantuml",
    "infographic",
]);

function getLuteEscape(): ((s: string) => string) | null {
    const Lute = (window as unknown as {Lute?: {EscapeHTMLStr?: (s: string) => string}}).Lute;
    return typeof Lute?.EscapeHTMLStr === "function" ? Lute.EscapeHTMLStr.bind(Lute) : null;
}

function escapeAttrFallback(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function formatSiyuanUpdated(): string {
    const d = new Date();
    const z = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

function newNodeId(): string {
    const Lute = (window as unknown as {Lute?: {NewNodeID?: () => string}}).Lute;
    return typeof Lute?.NewNodeID === "function" ? Lute.NewNodeID() : `agent-${Date.now()}`;
}

function parseFenceLanguage(codeEl: HTMLElement): string {
    const classes = codeEl.className.trim().split(/\s+/).filter(Boolean);
    for (const c of classes) {
        if (c.startsWith("language-")) {
            const rest = c.slice("language-".length);
            return rest || "plaintext";
        }
    }
    return "plaintext";
}

/**
 * `HtmlRenderer` 下行级公式为 `<span class="language-math">…</span>`；`mathRender` 只匹配 `data-subtype="math"`，
 * 与 `ProtylePreviewRenderer` 的 `data-type="inline-math"` 对齐。
 */
export function upgradeInlineMathSpans(root: ParentNode): void {
    const esc = getLuteEscape() ?? escapeAttrFallback;
    root.querySelectorAll("span.language-math").forEach((el) => {
        if (!(el instanceof HTMLSpanElement)) {
            return;
        }
        const raw = el.textContent ?? "";
        el.removeAttribute("class");
        el.setAttribute("data-type", "inline-math");
        el.setAttribute("data-subtype", "math");
        el.setAttribute("data-content", esc(raw));
        el.replaceChildren();
    });
}

/**
 * HtmlRenderer 对 mermaid 等输出为 `<div class="language-mermaid">源码</div>`；
 * 思源 `mermaidRender` 依赖 `data-subtype` + `data-content` + 内层 `<div spin="1">`（与 `ProtylePreviewRenderer` 一致）。
 * 数学块 `div.language-math` 与块级公式一致，供 `mathRender` 使用。
 */
export function upgradeChartLanguageDivs(root: ParentNode): void {
    const esc = getLuteEscape() ?? escapeAttrFallback;
    root.querySelectorAll("div[class]").forEach((el) => {
        if (!(el instanceof HTMLDivElement)) {
            return;
        }
        const m = el.className.trim().match(/\blanguage-([a-z0-9]+)\b/i);
        if (!m) {
            return;
        }
        const lang = m[1].toLowerCase();
        if (!LANGUAGES_NO_HIGHLIGHT.has(lang)) {
            return;
        }
        const raw = el.textContent ?? "";
        el.removeAttribute("class");
        el.setAttribute("data-subtype", lang);
        el.setAttribute("data-content", esc(raw));
        el.replaceChildren();
        const spin = document.createElement("div");
        spin.setAttribute("spin", "1");
        el.appendChild(spin);
    });
}

/**
 * 将根节点内尚未符合预览约定的代码块 `<pre>` 改为 `pre.code-block` + `data-language` 等属性。
 */
export function upgradePlainCodeBlocksToPreview(root: ParentNode): void {
    root.querySelectorAll("pre:not(.code-block)").forEach((node) => {
        const pre = node;
        if (!(pre instanceof HTMLPreElement)) {
            return;
        }
        const code = pre.querySelector(":scope > code");
        if (!code || pre.childElementCount !== 1) {
            return;
        }
        const lang = parseFenceLanguage(code);
        pre.classList.add("code-block");
        pre.setAttribute("data-language", lang);

        const lineWrap = (window as unknown as {siyuan?: {config?: {editor?: {codeLineWrap?: boolean}}}})
            .siyuan?.config?.editor?.codeLineWrap;
        pre.setAttribute("linewrap", lineWrap ? "true" : "false");
        pre.setAttribute("ligatures", "false");

        const LuteNs = (window as unknown as {Lute?: {NewNodeID?: () => string}}).Lute;
        if (!pre.id && typeof LuteNs?.NewNodeID === "function") {
            pre.id = LuteNs.NewNodeID();
        }
        if (!pre.getAttribute("updated")) {
            pre.setAttribute("updated", formatSiyuanUpdated());
        }

        code.className = "hljs";
        code.removeAttribute("data-render");
    });
}

/**
 * HtmlRenderer 默认 `GFMTaskListItemClass` 为 `vditor-task`；导出预览为 `protyle-task`，且常见 `input` 后包 `<p>`。
 */
export function upgradeVditorTaskListItems(root: ParentNode): void {
    root.querySelectorAll("li[class*='vditor-task']").forEach((el) => {
        const li = el;
        if (!(li instanceof HTMLLIElement)) {
            return;
        }
        li.className = li.className
            .replace(/\bvditor-task--done\b/g, "protyle-task--done")
            .replace(/\bvditor-task\b/g, "protyle-task");

        const input = li.querySelector(":scope > input[type='checkbox']");
        if (!input) {
            return;
        }
        let n = input.nextSibling;
        if (!n) {
            return;
        }
        if (
            n.nodeType === Node.ELEMENT_NODE &&
            (n as Element).tagName === "P" &&
            !n.nextSibling
        ) {
            return;
        }
        const p = document.createElement("p");
        p.id = newNodeId();
        p.setAttribute("updated", formatSiyuanUpdated());
        while (n) {
            const next = n.nextSibling;
            p.appendChild(n);
            n = next;
        }
        li.appendChild(p);
    });
}
