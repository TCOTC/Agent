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
}

/** 流式 Markdown 预览 DOM 增量同步 */
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
    const {sealedHtmlParts, tailHtml} = await getStreamingAssistantMdParts(m, fullMd, lute, kind);
    if (destroyed()) {
        return;
    }
    const n = sealedHtmlParts.length;
    const dom = getStreamingMdDomForRoot(blocksRoot);

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
        if (contentRaw.length > 0) {
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
