import type {ChatMessage} from "../agent/types";
import {
    finalizeStreamingMdRemainder,
    getStreamingAssistantMdParts,
} from "./streamMdRender";
import type {LuteEngine} from "./lute";
import {renderProtyleBlock, renderProtyleBlockPending} from "./protyleBlockRender";

export type StreamingMdDom = {
    sealedBlocks: Map<number, Element[]>;
    tailBlocks: Element[];
};

const streamingMdDomByBlocksRoot = new WeakMap<HTMLElement, StreamingMdDom>();
const tailSyncStateByBlocksRoot = new WeakMap<HTMLElement, {tailHtml: string; sealedN: number}>();
const lastHostSyncByBlocksRoot = new WeakMap<HTMLElement, {fullMd: string; streamOpen: boolean}>();
/** 异步 md2html 世代号，丢弃过期的 DOM 写入 */
const hostGenerationByBlocksRoot = new WeakMap<HTMLElement, number>();
const hostSyncChainByBlocksRoot = new WeakMap<HTMLElement, Promise<void>>();

type HostSyncJob = {
    m: ChatMessage;
    fullMd: string;
    lute: LuteEngine;
    kind: "content" | "reasoning";
    streamOpen: boolean;
    destroyed: () => boolean;
};
const hostSyncPendingByBlocksRoot = new WeakMap<HTMLElement, HostSyncJob>();

function getStreamingMdDomForRoot(blocksRoot: HTMLElement): StreamingMdDom {
    let d = streamingMdDomByBlocksRoot.get(blocksRoot);
    if (!d) {
        d = {sealedBlocks: new Map(), tailBlocks: []};
        streamingMdDomByBlocksRoot.set(blocksRoot, d);
    }
    return d;
}

function htmlToTopLevelElements(html: string): {fragment: DocumentFragment; blocks: Element[]} {
    const tpl = document.createElement("template");
    const trimmed = html.trim();
    if (!trimmed) {
        return {fragment: tpl.content, blocks: []};
    }
    tpl.innerHTML = trimmed;
    const blocks: Element[] = [];
    for (const node of Array.from(tpl.content.childNodes)) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            blocks.push(node as Element);
        }
    }
    return {fragment: tpl.content, blocks};
}

function firstBoundaryAtOrAfterSealed(dom: StreamingMdDom, sealedIndex: number): Element | null {
    for (let j = sealedIndex; j < 4096; j++) {
        const blocks = dom.sealedBlocks.get(j);
        if (blocks?.length) {
            return blocks[0]!;
        }
    }
    return dom.tailBlocks[0] ?? null;
}

function insertSealedHtmlAsDirectChildren(
    blocksRoot: HTMLElement,
    dom: StreamingMdDom,
    sealedIndex: number,
    html: string,
): Element[] {
    const {fragment, blocks} = htmlToTopLevelElements(html);
    if (blocks.length === 0) {
        dom.sealedBlocks.set(sealedIndex, []);
        return [];
    }
    const ref = firstBoundaryAtOrAfterSealed(dom, sealedIndex);
    if (ref) {
        blocksRoot.insertBefore(fragment, ref);
    } else {
        blocksRoot.append(fragment);
    }
    dom.sealedBlocks.set(sealedIndex, blocks);
    return blocks;
}

function syncTailDirectChildren(
    blocksRoot: HTMLElement,
    dom: StreamingMdDom,
    tailHtml: string,
    sealedN: number,
    kind: "content" | "reasoning",
): void {
    const prev = tailSyncStateByBlocksRoot.get(blocksRoot);
    if (prev && prev.tailHtml === tailHtml && prev.sealedN === sealedN) {
        return;
    }
    const {fragment, blocks} = htmlToTopLevelElements(tailHtml);

    if (dom.tailBlocks.length > 0 && blocks.length > 0) {
        let prefixMatch = 0;
        const limit = Math.min(dom.tailBlocks.length, blocks.length);
        for (let i = 0; i < limit; i++) {
            if (dom.tailBlocks[i]!.outerHTML === blocks[i]!.outerHTML) {
                prefixMatch = i + 1;
            } else {
                break;
            }
        }
        const changeFrom =
            prefixMatch >= dom.tailBlocks.length ? dom.tailBlocks.length : prefixMatch;
        for (let i = dom.tailBlocks.length - 1; i >= changeFrom; i--) {
            dom.tailBlocks[i]!.remove();
            dom.tailBlocks.pop();
        }
        for (let i = changeFrom; i < blocks.length; i++) {
            blocksRoot.append(blocks[i]!);
            dom.tailBlocks.push(blocks[i]!);
        }
        tailSyncStateByBlocksRoot.set(blocksRoot, {tailHtml, sealedN});
        return;
    }

    for (const el of dom.tailBlocks) {
        el.remove();
    }
    dom.tailBlocks = blocks;
    if (blocks.length > 0) {
        blocksRoot.append(fragment);
    }
    tailSyncStateByBlocksRoot.set(blocksRoot, {tailHtml, sealedN});
}

export function clearStreamingDomHost(blocksRoot: HTMLElement): void {
    streamingMdDomByBlocksRoot.delete(blocksRoot);
    tailSyncStateByBlocksRoot.delete(blocksRoot);
    lastHostSyncByBlocksRoot.delete(blocksRoot);
    hostGenerationByBlocksRoot.delete(blocksRoot);
    hostSyncPendingByBlocksRoot.delete(blocksRoot);
    hostSyncChainByBlocksRoot.delete(blocksRoot);
}

function rebuildStreamingDomHost(
    blocksRoot: HTMLElement,
    kind: "content" | "reasoning",
): StreamingMdDom {
    clearStreamingDomHost(blocksRoot);
    blocksRoot.replaceChildren();
    const dom: StreamingMdDom = {sealedBlocks: new Map(), tailBlocks: []};
    streamingMdDomByBlocksRoot.set(blocksRoot, dom);
    return dom;
}

/** 流式 Markdown 预览 DOM 增量同步 */
async function performSyncStreamingMdHost(blocksRoot: HTMLElement, job: HostSyncJob): Promise<void> {
    const {m, fullMd, lute, kind, streamOpen, destroyed} = job;
    if (destroyed()) {
        return;
    }

    const gen = (hostGenerationByBlocksRoot.get(blocksRoot) ?? 0) + 1;
    hostGenerationByBlocksRoot.set(blocksRoot, gen);

    const {sealedHtmlParts, tailHtml, cacheReset, tailThrottled} = await getStreamingAssistantMdParts(
        m,
        fullMd,
        lute,
        kind,
        streamOpen,
    );
    if (destroyed() || hostGenerationByBlocksRoot.get(blocksRoot) !== gen) {
        return;
    }

    let dom = getStreamingMdDomForRoot(blocksRoot);
    const n = sealedHtmlParts.length;
    const prevTail = tailSyncStateByBlocksRoot.get(blocksRoot);

    if (
        cacheReset ||
        (prevTail != null && n < prevTail.sealedN) ||
        (n === 0 && !fullMd.trim() && blocksRoot.childElementCount > 0)
    ) {
        dom = rebuildStreamingDomHost(blocksRoot, kind);
    }

    let sealedRemoved = false;
    for (const idx of [...dom.sealedBlocks.keys()]) {
        if (idx >= n) {
            for (const el of dom.sealedBlocks.get(idx)!) {
                el.remove();
            }
            dom.sealedBlocks.delete(idx);
            sealedRemoved = true;
        }
    }
    if (sealedRemoved) {
        tailSyncStateByBlocksRoot.delete(blocksRoot);
    }

    for (let i = 0; i < n; i++) {
        if (dom.sealedBlocks.has(i)) {
            continue;
        }
        const blocks = insertSealedHtmlAsDirectChildren(blocksRoot, dom, i, sealedHtmlParts[i]);
        renderProtyleBlockPending(blocks, blocksRoot);
    }

    syncTailDirectChildren(blocksRoot, dom, tailHtml, n, kind);
    if (streamOpen) {
        renderProtyleBlockPending(dom.tailBlocks, blocksRoot);
    } else {
        renderProtyleBlock(dom.tailBlocks, blocksRoot);
    }
    lastHostSyncByBlocksRoot.set(blocksRoot, {fullMd, streamOpen});
}

export async function syncStreamingMdHost(
    blocksRoot: HTMLElement,
    m: ChatMessage,
    fullMd: string,
    lute: LuteEngine,
    kind: "content" | "reasoning",
    streamOpen: boolean,
    destroyed: () => boolean,
): Promise<void> {
    if (destroyed()) {
        return;
    }

    const prevHostSync = lastHostSyncByBlocksRoot.get(blocksRoot);
    if (prevHostSync?.fullMd === fullMd && prevHostSync.streamOpen === streamOpen) {
        return;
    }

    hostSyncPendingByBlocksRoot.set(blocksRoot, {m, fullMd, lute, kind, streamOpen, destroyed});

    let chain = hostSyncChainByBlocksRoot.get(blocksRoot);
    if (!chain) {
        chain = (async () => {
            for (;;) {
                const job = hostSyncPendingByBlocksRoot.get(blocksRoot);
                if (!job) {
                    break;
                }
                hostSyncPendingByBlocksRoot.delete(blocksRoot);
                await performSyncStreamingMdHost(blocksRoot, job);
                if (!hostSyncPendingByBlocksRoot.has(blocksRoot)) {
                    break;
                }
            }
        })().finally(() => {
            hostSyncChainByBlocksRoot.delete(blocksRoot);
        });
        hostSyncChainByBlocksRoot.set(blocksRoot, chain);
    }
    await chain;
}

function reasoningStreamOpen(m: ChatMessage, mdStreaming: boolean): boolean {
    return mdStreaming && m._thinkingMdOpen === true;
}

/** 仅同步推理区 Markdown（避免正文流式时连带重写 reasoning DOM） */
export async function syncAssistantReasoningDom(
    row: HTMLElement,
    m: ChatMessage,
    lute: LuteEngine,
    mdStreaming: boolean,
    destroyed: () => boolean,
): Promise<void> {
    const reasoningRaw =
        m.reasoning_content != null && m.reasoning_content !== "" ? String(m.reasoning_content) : "";
    const reasoningHost = row.querySelector(".agent-msg__reasoning") as HTMLElement | null;
    if (!reasoningHost) {
        return;
    }

    if (!reasoningRaw) {
        reasoningHost.replaceChildren();
        reasoningHost.hidden = true;
        clearStreamingDomHost(reasoningHost);
        return;
    }

    reasoningHost.hidden = false;
    const streamOpen = reasoningStreamOpen(m, mdStreaming);
    if (!streamOpen) {
        await finalizeStreamingMdRemainder(m, reasoningRaw, lute, "reasoning");
        if (destroyed()) {
            return;
        }
    }
    await syncStreamingMdHost(reasoningHost, m, reasoningRaw, lute, "reasoning", streamOpen, destroyed);
}

/** 仅同步正文 Markdown */
export async function syncAssistantContentDom(
    row: HTMLElement,
    m: ChatMessage,
    lute: LuteEngine,
    mdStreaming: boolean,
    destroyed: () => boolean,
): Promise<void> {
    const bodyEl = row.querySelector(".agent-msg__body") as HTMLElement | null;
    if (!bodyEl) {
        return;
    }
    await syncStreamingMdHost(bodyEl, m, m.content ?? "", lute, "content", mdStreaming, destroyed);
}

export async function syncAssistantMessageDom(
    row: HTMLElement,
    m: ChatMessage,
    lute: LuteEngine,
    streamOpen: boolean,
    destroyed: () => boolean,
): Promise<void> {
    await syncAssistantReasoningDom(row, m, lute, streamOpen, destroyed);
    if (destroyed()) {
        return;
    }
    await syncAssistantContentDom(row, m, lute, streamOpen, destroyed);
}
