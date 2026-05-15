/**
 * 使用思源前端提供的 window.Lute 渲染 Markdown，外层由调用方包裹 `b3-typography`（勿使用 `protyle-wysiwyg`）。
 *
 * 说明：内核导出预览使用 `ProtylePreview(tree, …)`，但在浏览器 GopherJS 中若将 `Md2BlockDOMTree`
 * 返回的 AST 再传入 `ProtylePreview`，会在 `$externalize` 时因语法树图结构导致栈溢出。
 * 因此此处采用与思源多处一致的纯字符串链路：`Md2BlockDOM` → `BlockDOM2HTML`，语义上接近
 * 块 DOM 经 Markdown 再输出为 HTML 的预览效果，且不经过 `protyle-wysiwyg` DOM。
 *
 * 流式优化：当文档根下已出现至少 2 个第一层块时，说明第一个块已完整，将其 Markdown 封存并
 * 只对新尾部反复解析，避免已稳定块重复走 Lute。
 */
import {getAllEditor} from "siyuan";
import type {ChatMessage} from "./types";

interface LuteGlobalNs {
    New(options?: unknown): LuteEngine;
}

/** 与思源 app/src/types/protyle.d.ts 中 Lute 实例对齐的最小运行时形状 */
interface LuteEngine {
    Md2BlockDOM(markdown: string, reserveEmptyParagraph?: boolean): string;
    BlockDOM2HTML?(blockDOM: string): string;
    MarkdownStr?(name: string, markdown: string): string;
    SetSpin?(v: boolean): void;
    SetProtyleWYSIWYG?(v: boolean): void;
    SetProtyleMarkNetImg?(v: boolean): void;
    SetHeadingID?(v: boolean): void;
    SetYamlFrontMatter?(v: boolean): void;
    SetFootnotes?(v: boolean): void;
    SetToC?(v: boolean): void;
    SetIndentCodeBlock?(v: boolean): void;
    SetParagraphBeginningSpace?(v: boolean): void;
    SetSetext?(v: boolean): void;
    SetLinkRef?(v: boolean): void;
    SetSanitize?(v: boolean): void;
    SetKramdownIAL?(v: boolean): void;
    SetTag?(v: boolean): void;
    SetSuperBlock?(v: boolean): void;
    SetImgPathAllowSpace?(v: boolean): void;
    SetBlockRef?(v: boolean): void;
    SetFileAnnotationRef?(v: boolean): void;
    SetMark?(v: boolean): void;
    SetSup?(v: boolean): void;
    SetSub?(v: boolean): void;
    SetInlineMathAllowDigitAfterOpenMarker?(v: boolean): void;
    SetHTMLTag2TextMark?(v: boolean): void;
    SetTextMark?(v: boolean): void;
    SetUnorderedListMarker?(m: string): void;
    SetDataTask?(v: boolean): void;
    SetExportNormalizeTaskListMarker?(v: boolean): void;
    SetArbitraryTaskListItemMarker?(v: boolean): void;
    SetCallout?(v: boolean): void;
    SetSpellcheck?(v: boolean): void;
    SetInlineAsterisk?(v: boolean): void;
    SetInlineUnderscore?(v: boolean): void;
    SetInlineMath?(v: boolean): void;
    SetGFMStrikethrough1?(v: boolean): void;
    SetGFMStrikethrough?(v: boolean): void;
}

export interface StreamMdCache {
    /** 已封存的前缀字符长度，与 fullMd.slice(0, sealedLen) 对应 */
    sealedLen: number;
    /** 与每一封存块顺序对应的预览 HTML 片段 */
    sealedHtmlParts: string[];
}

const streamCacheContent = new WeakMap<ChatMessage, StreamMdCache>();
const streamCacheReasoning = new WeakMap<ChatMessage, StreamMdCache>();

function getCacheMap(kind: "content" | "reasoning"): WeakMap<ChatMessage, StreamMdCache> {
    return kind === "reasoning" ? streamCacheReasoning : streamCacheContent;
}

/** 通过 Md2BlockDOM 顶层块数量判断「第一层块」个数（含列表等容器块为一项） */
function countTopLevelBlockDivs(lute: LuteEngine, md: string): number {
    if (!md.trim()) {
        return 0;
    }
    const h = lute.Md2BlockDOM(md, false);
    const tpl = document.createElement("template");
    tpl.innerHTML = h.trim();
    return tpl.content.children.length;
}

/**
 * 在 fullMd 已存在至少 2 个第一层块时，返回最大的前缀长度 L，使得 slice(0,L) 仅含 1 个第一层块；
 * 从而 slice(0,L) 为已完整的第一块，slice(L) 为剩余（含未完成的第二块及之后）。
 */
function maxPrefixSingleTopBlockLen(lute: LuteEngine, md: string): number {
    const total = countTopLevelBlockDivs(lute, md);
    if (total <= 1) {
        return md.length;
    }
    let lo = 0;
    let hi = md.length;
    let best = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const c = countTopLevelBlockDivs(lute, md.slice(0, mid));
        if (c <= 1) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

function configureFallbackLute(engine: LuteEngine): void {
    // 与思源 setLute 对齐的主要开关，保证解析路径与编辑器一致（渲染走 ProtylePreview 而非 wysiwyg DOM）
    engine.SetSpin?.(true);
    engine.SetProtyleWYSIWYG?.(true);
    engine.SetFileAnnotationRef?.(true);
    engine.SetHTMLTag2TextMark?.(true);
    engine.SetTextMark?.(true);
    engine.SetHeadingID?.(false);
    engine.SetYamlFrontMatter?.(false);
    engine.SetInlineMathAllowDigitAfterOpenMarker?.(true);
    engine.SetToC?.(false);
    engine.SetIndentCodeBlock?.(false);
    engine.SetParagraphBeginningSpace?.(true);
    engine.SetSetext?.(false);
    engine.SetFootnotes?.(false);
    engine.SetLinkRef?.(false);
    engine.SetSanitize?.(true);
    engine.SetKramdownIAL?.(true);
    engine.SetTag?.(true);
    engine.SetSuperBlock?.(true);
    engine.SetCallout?.(true);
    engine.SetBlockRef?.(true);
    engine.SetImgPathAllowSpace?.(true);
    engine.SetUnorderedListMarker?.("-");
    engine.SetDataTask?.(true);
    engine.SetExportNormalizeTaskListMarker?.(true);
    engine.SetArbitraryTaskListItemMarker?.(true);
    const cfg = (window as unknown as {siyuan?: {config?: {editor?: {
        spellcheck?: boolean;
        displayNetImgMark?: boolean;
        markdown?: Record<string, boolean>;
    }}}}).siyuan?.config?.editor;
    if (cfg) {
        engine.SetSpellcheck?.(Boolean(cfg.spellcheck));
        engine.SetProtyleMarkNetImg?.(Boolean(cfg.displayNetImgMark));
        const md = cfg.markdown ?? {};
        engine.SetInlineAsterisk?.(Boolean(md.inlineAsterisk));
        engine.SetInlineUnderscore?.(Boolean(md.inlineUnderscore));
        engine.SetSup?.(Boolean(md.inlineSup));
        engine.SetSub?.(Boolean(md.inlineSub));
        engine.SetTag?.(Boolean(md.inlineTag));
        engine.SetInlineMath?.(Boolean(md.inlineMath));
        engine.SetGFMStrikethrough1?.(false);
        engine.SetGFMStrikethrough?.(Boolean(md.inlineStrikethrough));
        engine.SetMark?.(Boolean(md.inlineMark));
    }
}

function getLuteEngine(): LuteEngine | null {
    const eds = getAllEditor();
    const fromEditor = eds[0]?.protyle?.lute as LuteEngine | undefined;
    if (fromEditor) {
        return fromEditor;
    }
    const LuteNs = (window as unknown as {Lute?: LuteGlobalNs}).Lute;
    if (!LuteNs?.New) {
        return null;
    }
    const engine = LuteNs.New(undefined) as LuteEngine;
    configureFallbackLute(engine);
    return engine;
}

/**
 * Markdown → 可在 `b3-typography` 中使用的 HTML 片段（innerHTML，勿包 `protyle-wysiwyg`）。
 */
export function markdownToProtylePreviewHtml(lute: LuteEngine, md: string): string {
    if (!md) {
        return "";
    }
    const markCfg = (window as unknown as {siyuan?: {config?: {editor?: {displayNetImgMark?: boolean}}}})
        .siyuan?.config?.editor?.displayNetImgMark;
    const prevMarkNetImg = markCfg !== undefined ? Boolean(markCfg) : true;
    lute.SetProtyleMarkNetImg?.(false);

    let html: string;
    if (typeof lute.BlockDOM2HTML === "function") {
        const blockDom = lute.Md2BlockDOM(md, false);
        html = lute.BlockDOM2HTML(blockDom);
    } else if (typeof lute.MarkdownStr === "function") {
        html = lute.MarkdownStr("", md);
    } else {
        html = "";
    }

    lute.SetProtyleMarkNetImg?.(prevMarkNetImg);
    return html;
}

function resetCache(c: StreamMdCache): void {
    c.sealedLen = 0;
    c.sealedHtmlParts.length = 0;
}

/**
 * 将助手消息的一段 Markdown 流式渲染为预览 HTML；在 `msg` 上维护封存块缓存。
 */
export function renderStreamingAssistantMd(
    msg: ChatMessage,
    fullMd: string,
    lute: LuteEngine,
    kind: "content" | "reasoning" = "content",
): string {
    const map = getCacheMap(kind);
    let c = map.get(msg);
    if (!c) {
        c = {sealedLen: 0, sealedHtmlParts: []};
        map.set(msg, c);
    }

    const prevPrefix = c.sealedLen > 0 ? fullMd.slice(0, c.sealedLen) : "";
    if (fullMd.length < c.sealedLen || (c.sealedLen > 0 && !fullMd.startsWith(prevPrefix))) {
        resetCache(c);
    }

    let tail = fullMd.slice(c.sealedLen);
    while (countTopLevelBlockDivs(lute, tail) >= 2) {
        const L = maxPrefixSingleTopBlockLen(lute, tail);
        if (L <= 0) {
            break;
        }
        const sealedMd = tail.slice(0, L);
        c.sealedHtmlParts.push(markdownToProtylePreviewHtml(lute, sealedMd));
        c.sealedLen += L;
        tail = fullMd.slice(c.sealedLen);
    }

    const tailHtml = markdownToProtylePreviewHtml(lute, tail);
    return c.sealedHtmlParts.join("") + tailHtml;
}

export function forgetStreamMdCache(msg: ChatMessage): void {
    streamCacheContent.delete(msg);
    streamCacheReasoning.delete(msg);
}

export function getLuteOrNull(): LuteEngine | null {
    return getLuteEngine();
}
