/**
 * Markdown → HTML 走内核 `/api/lute/md2html`（`render: protyle-preview`）；插入 DOM 后由
 * `typographyPostRender` 与导出预览管线对齐。
 *
 * 流式封存边界：先要求 `Md2BlockDOM` 顶层块数 ≥ 2，再用「整段 tail 与前缀 tail 的第一块
 * `innerHTML` 一致」对齐切点（忽略块根 `id` 等属性差异），避免仅在反引号等处块数跳变导致的误切分。
 * 搜索顺序：优先在「相对上一帧 tail 长度的新增区间」内从 `hi` 向下扫描，未命中再扫其余区间。
 * 详见 `docs/流式-Markdown-封存策略讨论.md`。
 *
 * 思源客户端内 Lute 总可用（优先编辑器 Protyle，否则 `window.Lute.New`）。
 *
 * 流式优化：当可对齐封存第一层块时，将其 Markdown 封存并只对新尾部反复请求 md2html。
 * 思考结束后一旦正文开始输出，可对推理文本调用 `finalizeStreamingMdRemainder`，把仍留在尾部的
 * Markdown 一次性封存，避免推理区 tail 随正文 RAF 反复渲染。
 */
import {fetchSyncPost, getAllEditor} from "siyuan";
import type {ChatMessage} from "./types";

interface LuteGlobalNs {
    New(options?: unknown): LuteEngine;
}

/** 仅用于 `Md2BlockDOM` 流式封存边界；HTML 已全部走 `markdownToProtylePreviewHtml`（内核 md2html）。 */
export interface LuteEngine {
    Md2BlockDOM(markdown: string, reserveEmptyParagraph?: boolean): string;
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
    /**
     * 上一帧结束时未封存 tail 的字节长度，用于封存切点搜索的窄区间（本轮新增 ≈ tail.length - 该值）。
     * 同一次 `getStreamingAssistantMdParts` 内第二次及以后的封存轮次传 0，退化为全区间扫描。
     */
    lastTailLen: number;
}

/** 供 DOM 增量挂载：已封存的顶层块 HTML 与未完成的尾部 HTML */
export interface StreamingMdDomParts {
    sealedHtmlParts: string[];
    tailHtml: string;
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

/** 取 `Md2BlockDOM` 顶层第一个块的内容 HTML（不含块根属性，等价于首块 `innerHTML`）。 */
function getFirstBlockInnerFromMd2BlockDomHtml(html: string): string | null {
    const trimmed = html.trim();
    if (!trimmed) {
        return null;
    }
    const tpl = document.createElement("template");
    tpl.innerHTML = trimmed;
    const first = tpl.content.firstElementChild;
    if (!first) {
        return null;
    }
    return first.innerHTML;
}

function getFirstBlockInnerFromMd(lute: LuteEngine, md: string): string | null {
    if (!md.trim()) {
        return null;
    }
    return getFirstBlockInnerFromMd2BlockDomHtml(lute.Md2BlockDOM(md, false));
}

/**
 * 在 `tail` 已含至少 2 个顶层块时，求首块 Markdown 的封存长度 `L`：
 * `tail.slice(0,L)` 须为恰好 1 个顶层块，且其首块 `innerHTML` 与整段 `tail` 的首块一致。
 * `prevTailLenForNarrow` 为上一帧 tail 长度；传 0 表示不缩窄、从 `hi` 一直扫到 1。
 */
function findSealLenFirstBlockAligned(
    lute: LuteEngine,
    tail: string,
    prevTailLenForNarrow: number,
): number {
    if (countTopLevelBlockDivs(lute, tail) < 2) {
        return 0;
    }
    const refInner = getFirstBlockInnerFromMd(lute, tail);
    if (refInner == null) {
        return 0;
    }
    const hi = maxPrefixSingleTopBlockLen(lute, tail);
    if (hi <= 0) {
        return 0;
    }
    const delta = Math.max(1, tail.length - Math.max(0, prevTailLenForNarrow));
    const lo = Math.max(1, hi - delta);

    const prefixOk = (L: number): boolean => {
        const pref = tail.slice(0, L);
        if (countTopLevelBlockDivs(lute, pref) !== 1) {
            return false;
        }
        return getFirstBlockInnerFromMd(lute, pref) === refInner;
    };

    for (let L = hi; L >= lo; L--) {
        if (prefixOk(L)) {
            return L;
        }
    }
    for (let L = lo - 1; L >= 1; L--) {
        if (prefixOk(L)) {
            return L;
        }
    }
    return 0;
}

function configureFallbackLute(engine: LuteEngine): void {
    // 与思源 setLute 对齐的主要开关，使 `window.Lute.New` 实例的 `Md2BlockDOM` 与编辑器块边界一致（此处不做任何 HTML 渲染）
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
    } else {
        engine.SetInlineMath?.(true);
    }
}

function getLuteEngine(): LuteEngine {
    const eds = getAllEditor();
    const fromEditor = eds[0]?.protyle?.lute as LuteEngine | undefined;
    if (fromEditor) {
        return fromEditor;
    }
    const LuteNs = (window as unknown as {Lute?: LuteGlobalNs}).Lute;
    if (!LuteNs?.New) {
        throw new Error("[Agent] Lute 不可用：请在思源笔记客户端中使用本插件。");
    }
    const engine = LuteNs.New(undefined) as LuteEngine;
    configureFallbackLute(engine);
    return engine;
}

/**
 * Markdown → 可在 `b3-typography` 中使用的 HTML 片段（innerHTML，勿包 `protyle-wysiwyg`）。
 * 由内核 `/api/lute/md2html` + `render: protyle-preview` 生成。
 */
export async function markdownToProtylePreviewHtml(md: string): Promise<string> {
    if (!md.trim()) {
        return "";
    }
    const res = await fetchSyncPost("/api/lute/md2html", {markdown: md, render: "protyle-preview"});
    if (res.code !== 0 || res.data == null) {
        console.warn("[Agent] /api/lute/md2html failed:", res.msg);
        return "";
    }
    const html = (res.data as {html?: unknown}).html;
    return typeof html === "string" ? html : "";
}

function resetCache(c: StreamMdCache): void {
    c.sealedLen = 0;
    c.sealedHtmlParts.length = 0;
    c.lastTailLen = 0;
}

/**
 * 将当前尚未封存的尾部 Markdown 一次性并入封存区（`sealedLen` 直至 `fullMd.length`）。
 * 在「思考已结束、正文开始输出」时用于推理通道，避免推理区 tail 在后续帧随正文同步反复渲染。
 */
export async function finalizeStreamingMdRemainder(
    msg: ChatMessage,
    fullMd: string,
    lute: LuteEngine,
    kind: "content" | "reasoning" = "content",
): Promise<void> {
    const map = getCacheMap(kind);
    let c = map.get(msg);
    if (!c) {
        c = {sealedLen: 0, sealedHtmlParts: [], lastTailLen: 0};
        map.set(msg, c);
    }

    const prevPrefix = c.sealedLen > 0 ? fullMd.slice(0, c.sealedLen) : "";
    if (fullMd.length < c.sealedLen || (c.sealedLen > 0 && !fullMd.startsWith(prevPrefix))) {
        resetCache(c);
    }

    const tailMd = fullMd.slice(c.sealedLen);
    if (!tailMd) {
        c.lastTailLen = 0;
        return;
    }
    c.sealedHtmlParts.push(await markdownToProtylePreviewHtml(tailMd));
    c.sealedLen = fullMd.length;
    c.lastTailLen = 0;
}

/**
 * 更新流式 Markdown 缓存并返回「封存块 + 尾部」HTML，供 DOM 按块增量挂载。
 */
export async function getStreamingAssistantMdParts(
    msg: ChatMessage,
    fullMd: string,
    lute: LuteEngine,
    kind: "content" | "reasoning" = "content",
): Promise<StreamingMdDomParts> {
    const map = getCacheMap(kind);
    let c = map.get(msg);
    if (!c) {
        c = {sealedLen: 0, sealedHtmlParts: [], lastTailLen: 0};
        map.set(msg, c);
    }

    const prevPrefix = c.sealedLen > 0 ? fullMd.slice(0, c.sealedLen) : "";
    if (fullMd.length < c.sealedLen || (c.sealedLen > 0 && !fullMd.startsWith(prevPrefix))) {
        resetCache(c);
    }

    let tail = fullMd.slice(c.sealedLen);
    let sealPass = 0;
    while (countTopLevelBlockDivs(lute, tail) >= 2) {
        const narrowBase = sealPass === 0 ? c.lastTailLen : 0;
        const L = findSealLenFirstBlockAligned(lute, tail, narrowBase);
        sealPass++;
        if (L <= 0) {
            break;
        }
        const sealedMd = tail.slice(0, L);
        c.sealedHtmlParts.push(await markdownToProtylePreviewHtml(sealedMd));
        c.sealedLen += L;
        tail = fullMd.slice(c.sealedLen);
    }

    c.lastTailLen = tail.length;

    const tailHtml = await markdownToProtylePreviewHtml(tail);
    return {
        sealedHtmlParts: c.sealedHtmlParts.slice(),
        tailHtml,
    };
}

/**
 * 将助手消息的一段 Markdown 流式渲染为预览 HTML（单字符串，会拼接全部块）；在 `msg` 上维护封存块缓存。
 */
export async function renderStreamingAssistantMd(
    msg: ChatMessage,
    fullMd: string,
    lute: LuteEngine,
    kind: "content" | "reasoning" = "content",
): Promise<string> {
    const p = await getStreamingAssistantMdParts(msg, fullMd, lute, kind);
    return p.sealedHtmlParts.join("") + p.tailHtml;
}

export function forgetStreamMdCache(msg: ChatMessage): void {
    streamCacheContent.delete(msg);
    streamCacheReasoning.delete(msg);
}

/** 供流式 `Md2BlockDOM` 封存用；与 `markdownToProtylePreviewHtml` 无耦合。 */
export function getMd2BlockDomLute(): LuteEngine {
    return getLuteEngine();
}
