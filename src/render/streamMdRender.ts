/**
 * Markdown → HTML 走内核 `/api/lute/md2html`（`mode: protyle-preview`）；插入 DOM 后由
 * `protyleBlockRender` 与导出预览管线对齐。
 *
 * 流式封存边界：先要求 `Md2BlockDOM` 顶层块数 ≥ 2，再用「整段 tail 与前缀 tail 的第一块
 * `innerHTML` 一致」对齐切点（忽略块根 `id` 等属性差异），避免仅在反引号等处块数跳变导致的误切分。
 * 搜索顺序：优先在「相对上一帧 tail 长度的新增区间」内从 `hi` 向下扫描，未命中再扫其余区间。
 * 详见 `docs/流式-Markdown-封存策略讨论.md`。
 *
 * 流式封存用的 Lute 单例见 `lute.ts` 的 `getLuteResult`。
 *
 * 流式优化：当可对齐封存第一层块时，将其 Markdown 封存并只对新尾部反复请求 md2html。
 * 思考结束后一旦正文开始输出，可对推理文本调用 `finalizeStreamingMdRemainder`，把仍留在尾部的
 * Markdown 一次性封存，避免推理区 tail 随正文 RAF 反复渲染。
 */
import {postKernelJson} from "../kernelPostJson";
import {logger} from "../util";
import type {ChatMessage} from "../agent/types";
import type {LuteEngine} from "./lute";

/** 流式 tail md2html 最小间隔（ms）；思考区与正文共用；封存循环保持开启以便逐块渲染特殊块 */
const STREAM_TAIL_THROTTLE_MS = 100;

export interface StreamMdComputeOptions {
    kind?: "content" | "reasoning";
    /** 流式思考阶段跳过 Md2BlockDOM 封存循环，thinking_end 时 finalize */
    skipSealLoop?: boolean;
    /** tail md2html 节流，间隔内复用上一帧 HTML */
    throttleTailMs?: number;
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
    /** 最近一次计算时的 fullMd（用于合并并发请求） */
    lastFullMd?: string;
    /** 最近一次返回结果 */
    lastParts?: StreamingMdDomParts & {cacheReset: boolean};
    /** 上一帧 tail Markdown / HTML，避免相同 tail 重复 md2html */
    lastTailMd?: string;
    lastTailHtml?: string;
    lastTailMd2htmlAt?: number;
    inflight?: Promise<void>;
    pendingFullMd?: string;
    pendingOpts?: StreamMdComputeOptions;
    /** 尾部 remainder 已一次性封存（推理区在 thinking 结束后不再走 tail 流式） */
    remainderFinalized?: boolean;
}

/** 供 DOM 增量挂载：已封存的顶层块 HTML 与未完成的尾部 HTML */
export interface StreamingMdDomParts {
    sealedHtmlParts: string[];
    tailHtml: string;
    /** 本帧是否因前缀失效而重置了封存缓存（须同步清空 DOM） */
    cacheReset: boolean;
    /** tail md2html 是否因节流复用了上一帧 HTML */
    tailThrottled?: boolean;
}

/** 按通道返回 compute 选项（流式时 tail md2html 节流，封存照常以便逐块特殊渲染） */
export function streamMdOptsForHost(
    kind: "content" | "reasoning",
    streamOpen: boolean,
): StreamMdComputeOptions {
    if (streamOpen) {
        return {kind, throttleTailMs: STREAM_TAIL_THROTTLE_MS};
    }
    return {kind};
}

const streamCacheContent = new WeakMap<ChatMessage, StreamMdCache>();
const streamCacheReasoning = new WeakMap<ChatMessage, StreamMdCache>();

/** 将 HTML 写入 `template.content`，供统计顶层子元素或读取首块共用 */
function fragmentFromTrimmedHtml(html: string): DocumentFragment {
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    return tpl.content;
}

function getCacheMap(kind: "content" | "reasoning"): WeakMap<ChatMessage, StreamMdCache> {
    return kind === "reasoning" ? streamCacheReasoning : streamCacheContent;
}

/** 通过 Md2BlockDOM 顶层块数量判断「第一层块」个数（含列表等容器块为一项） */
function countTopLevelBlockDivs(lute: LuteEngine, md: string): number {
    if (!md.trim()) {
        return 0;
    }
    const h = lute.Md2BlockDOM(md, false);
    return fragmentFromTrimmedHtml(h).children.length;
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
    if (!html.trim()) {
        return null;
    }
    const frag = fragmentFromTrimmedHtml(html);
    const first = frag.firstElementChild;
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

/**
 * Markdown → 可在 `b3-typography` 中使用的 HTML 片段（innerHTML，勿包 `protyle-wysiwyg`）。
 * 由内核 `/api/lute/md2html` + `mode: protyle-preview` 生成。
 */
export async function markdownToProtylePreviewHtml(md: string): Promise<string> {
    if (!md.trim()) {
        return "";
    }
    const res = await postKernelJson<{html?: unknown}>("/api/lute/md2html", {
        markdown: md,
        mode: "protyle-preview",
    });
    if (res.code !== 0 || res.data == null) {
        logger.warn("/api/lute/md2html failed:", res.msg);
        return "";
    }
    const html = (res.data as {html?: unknown}).html;
    return typeof html === "string" ? html : "";
}

function resetCache(c: StreamMdCache): void {
    c.sealedLen = 0;
    c.sealedHtmlParts.length = 0;
    c.lastTailLen = 0;
    c.remainderFinalized = false;
    delete c.lastTailMd;
    delete c.lastTailHtml;
    delete c.lastFullMd;
    delete c.lastParts;
}

function publishCacheSnapshot(c: StreamMdCache, fullMd: string): StreamingMdDomParts {
    const parts: StreamingMdDomParts = {
        sealedHtmlParts: c.sealedHtmlParts.slice(),
        tailHtml: "",
        cacheReset: false,
    };
    c.lastFullMd = fullMd;
    c.lastParts = parts;
    delete c.lastTailMd;
    delete c.lastTailHtml;
    return parts;
}

async function tailMarkdownToHtml(
    c: StreamMdCache,
    tail: string,
    throttleTailMs?: number,
): Promise<{html: string; throttled: boolean}> {
    if (!tail.trim()) {
        delete c.lastTailMd;
        delete c.lastTailHtml;
        delete c.lastTailMd2htmlAt;
        return {html: "", throttled: false};
    }
    if (tail === c.lastTailMd && c.lastTailHtml !== undefined) {
        return {html: c.lastTailHtml, throttled: false};
    }
    const now = performance.now();
    if (
        throttleTailMs &&
        throttleTailMs > 0 &&
        c.lastTailHtml !== undefined &&
        c.lastTailMd &&
        tail !== c.lastTailMd &&
        c.lastTailMd2htmlAt != null &&
        now - c.lastTailMd2htmlAt < throttleTailMs
    ) {
        return {html: c.lastTailHtml, throttled: true};
    }
    const html = await markdownToProtylePreviewHtml(tail);
    c.lastTailMd = tail;
    c.lastTailHtml = html;
    c.lastTailMd2htmlAt = now;
    return {html, throttled: false};
}

async function computeStreamingMdParts(
    fullMd: string,
    lute: LuteEngine,
    c: StreamMdCache,
    opts?: StreamMdComputeOptions,
): Promise<StreamingMdDomParts> {
    if (c.remainderFinalized && c.sealedLen === fullMd.length && c.lastParts) {
        return c.lastParts;
    }

    let cacheReset = false;
    const prevPrefix = c.sealedLen > 0 ? fullMd.slice(0, c.sealedLen) : "";
    if (fullMd.length < c.sealedLen || (c.sealedLen > 0 && !fullMd.startsWith(prevPrefix))) {
        resetCache(c);
        cacheReset = true;
    }

    let tail = fullMd.slice(c.sealedLen);
    if (!opts?.skipSealLoop) {
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
    }

    c.lastTailLen = tail.length;
    const {html: tailHtml, throttled} = await tailMarkdownToHtml(c, tail, opts?.throttleTailMs);
    return {
        sealedHtmlParts: c.sealedHtmlParts.slice(),
        tailHtml,
        cacheReset,
        tailThrottled: throttled,
    };
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
    return finalizeStreamingMdRemainderInner(msg, fullMd, lute, kind);
}

async function finalizeStreamingMdRemainderInner(
    msg: ChatMessage,
    fullMd: string,
    lute: LuteEngine,
    kind: "content" | "reasoning",
): Promise<void> {
    const map = getCacheMap(kind);
    let c = map.get(msg);
    if (!c) {
        c = {sealedLen: 0, sealedHtmlParts: [], lastTailLen: 0};
        map.set(msg, c);
    }

    if (c.remainderFinalized && c.sealedLen === fullMd.length) {
        return;
    }

    const prevPrefix = c.sealedLen > 0 ? fullMd.slice(0, c.sealedLen) : "";
    if (fullMd.length < c.sealedLen || (c.sealedLen > 0 && !fullMd.startsWith(prevPrefix))) {
        resetCache(c);
    }

    const tailMd = fullMd.slice(c.sealedLen);
    if (!tailMd) {
        c.lastTailLen = 0;
        c.remainderFinalized = true;
        publishCacheSnapshot(c, fullMd);
        return;
    }
    c.sealedHtmlParts.push(await markdownToProtylePreviewHtml(tailMd));
    c.sealedLen = fullMd.length;
    c.lastTailLen = 0;
    c.remainderFinalized = true;
    publishCacheSnapshot(c, fullMd);
}

export async function getStreamingAssistantMdParts(
    msg: ChatMessage,
    fullMd: string,
    lute: LuteEngine,
    kind: "content" | "reasoning" = "content",
    streamOpen = true,
): Promise<StreamingMdDomParts> {
    const mergedOpts = streamMdOptsForHost(kind, streamOpen);
    const map = getCacheMap(kind);
    let c = map.get(msg);
    if (!c) {
        c = {sealedLen: 0, sealedHtmlParts: [], lastTailLen: 0};
        map.set(msg, c);
    }

    if (!c.inflight && c.lastFullMd === fullMd && c.lastParts) {
        return c.lastParts;
    }

    c.pendingFullMd = fullMd;
    c.pendingOpts = mergedOpts;
    if (!c.inflight) {
        c.inflight = (async () => {
            for (;;) {
                const md = c!.pendingFullMd ?? "";
                const o = c!.pendingOpts ?? streamMdOptsForHost(kind, streamOpen);
                const parts = await computeStreamingMdParts(md, lute, c!, o);
                c!.lastFullMd = md;
                c!.lastParts = parts;
                if (c!.pendingFullMd === md) {
                    break;
                }
            }
        })().finally(() => {
            c!.inflight = undefined;
        });
    }
    await c.inflight;

    if (c.pendingFullMd !== fullMd) {
        return getStreamingAssistantMdParts(msg, fullMd, lute, kind, streamOpen);
    }

    return c.lastParts ?? {
        sealedHtmlParts: [],
        tailHtml: "",
        cacheReset: false,
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
    const p = await getStreamingAssistantMdParts(msg, fullMd, lute, kind, false);
    return p.sealedHtmlParts.join("") + p.tailHtml;
}

export function forgetStreamMdCache(msg: ChatMessage): void {
    streamCacheContent.delete(msg);
    streamCacheReasoning.delete(msg);
}
