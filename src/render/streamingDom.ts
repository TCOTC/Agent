import type {ChatMessage} from "../agent/types";
import {
    finalizeStreamingMdRemainder,
    getStreamingAssistantMdParts,
} from "./streamMdRender";
import type {LuteEngine} from "./lute";
import {renderProtyleBlock} from "./protyleBlockRender";

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
): void {
    const prev = tailSyncStateByBlocksRoot.get(blocksRoot);
    if (prev && prev.tailHtml === tailHtml && prev.sealedN === sealedN) {
        return;
    }
    for (const el of dom.tailBlocks) {
        el.remove();
    }
    const {fragment, blocks} = htmlToTopLevelElements(tailHtml);
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

function rebuildStreamingDomHost(blocksRoot: HTMLElement): StreamingMdDom {
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

    const {sealedHtmlParts, tailHtml, cacheReset} = await getStreamingAssistantMdParts(m, fullMd, lute, kind);
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
        dom = rebuildStreamingDomHost(blocksRoot);
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
        renderProtyleBlock(blocks, blocksRoot);
    }

    syncTailDirectChildren(blocksRoot, dom, tailHtml, n);
    if (!streamOpen) {
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

export async function syncAssistantMessageDom(
    row: HTMLElement,
    m: ChatMessage,
    lute: LuteEngine,
    streamOpen: boolean,
    destroyed: () => boolean,
): Promise<void> {
    const reasoningRaw =
        m.reasoning_content != null && m.reasoning_content !== "" ? String(m.reasoning_content) : "";
    const contentRaw = m.content ?? "";

    const reasoningHost = row.querySelector(".agent-msg__reasoning") as HTMLElement | null;
    const bodyEl = row.querySelector(".agent-msg__body") as HTMLElement | null;
    if (!reasoningHost || !bodyEl) {
        return;
    }

    if (!reasoningRaw) {
        reasoningHost.replaceChildren();
        reasoningHost.hidden = true;
        clearStreamingDomHost(reasoningHost);
    } else {
        reasoningHost.hidden = false;
        reasoningHost.className =
            "agent-msg__reasoning b3-typography b3-typography--default";
        // thinking 结束或正文已开始：一次性封存推理区，避免 tool call 阶段反复 md2html
        if (!streamOpen || contentRaw.length > 0) {
            await finalizeStreamingMdRemainder(m, reasoningRaw, lute, "reasoning");
            if (destroyed()) {
                return;
            }
        }
        await syncStreamingMdHost(reasoningHost, m, reasoningRaw, lute, "reasoning", streamOpen, destroyed);
    }

    bodyEl.className = "agent-msg__body b3-typography b3-typography--default";
    await syncStreamingMdHost(bodyEl, m, contentRaw, lute, "content", streamOpen, destroyed);
}
