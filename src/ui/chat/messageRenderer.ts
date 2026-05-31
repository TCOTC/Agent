import type {ChatMessage} from "../../agent/types";
import {AGENT_ICON_IDS, agentIconHtml} from "../../icons/agentIcons";
import type {LuteEngine} from "../../render/lute";
import {forgetStreamMdCache, forgetStreamMdCacheByKind} from "../../render/streamMdRender";
import {
    clearStreamingDomHost,
    syncAssistantContentDom,
    syncAssistantReasoningDom,
} from "../../render/streamingDom";
import {readSessionIdFromMessagesEl} from "./inlineToolActions";
import {renderAssistantConfirmBanner} from "./toolConfirmBanner";
import {renderAssistantToolCalls} from "./toolCallUi";

const PATCH = "__agentPatch";

type Patch = {
    content: string;
    reasoning: string;
    toolsSig: string;
    statusSig: string;
    resultsSig: string;
    hintSig: string;
    confirmSig: string;
    diffSig: string;
    streamOpen: boolean;
    thinkingMdOpen: boolean;
};

export function buildUserMessageRow(): HTMLElement {
    const row = document.createElement("article");
    row.className = "agent-msg agent-msg--user";
    row.innerHTML = `<div class="agent-msg__editor" data-user-editor></div>
<div class="agent-msg__footer fn__flex">
  <button type="button" class="agent-msg__submit" data-user-resend title="发送" aria-label="发送">
    ${agentIconHtml(AGENT_ICON_IDS.arrowUp, { size: 8, className: "agent-msg__submit-icon" })}
  </button>
</div>`;
    return row;
}

export function buildToolResultRow(m: ChatMessage): HTMLElement {
    const row = document.createElement("article");
    row.className = "agent-msg agent-msg--tool";
    const preview = (m.content ?? "").slice(0, 3000);
    row.innerHTML = `<div class="agent-msg__head">工具结果</div>
<pre class="agent-msg__text"></pre>`;
    row.querySelector(".agent-msg__text")!.textContent = preview;
    return row;
}

export function buildAssistantRow(): HTMLElement {
    const row = document.createElement("article");
    row.className = "agent-msg agent-msg--assistant";
    row.innerHTML = `<details class="agent-msg__think" open>
  <summary>思考</summary>
  <div class="agent-msg__reasoning b3-typography b3-typography--default"></div>
</details>
<div class="agent-msg__body b3-typography b3-typography--default"></div>
<div class="agent-msg__tools"></div>
<div class="agent-msg__confirms" hidden aria-live="polite"></div>
<div class="agent-msg__actions">
  <button type="button" class="agent-msg__action" data-copy-md title="复制 Markdown">复制</button>
</div>`;
    return row;
}

function toolResultsSig(m: ChatMessage): string {
    return m._toolResults ? JSON.stringify(m._toolResults) : "";
}

function toolHintSig(m: ChatMessage): string {
    return m._toolHint ? JSON.stringify(m._toolHint) : "";
}

function toolConfirmSig(m: ChatMessage): string {
    return m._toolConfirm ? JSON.stringify(m._toolConfirm) : "";
}

function toolDiffSig(m: ChatMessage): string {
    return m._toolDiff ? JSON.stringify(m._toolDiff) : "";
}

function toolCallsSig(m: ChatMessage, llmStreaming: boolean): string {
    if (!m.tool_calls?.length) {
        return "";
    }
    if (llmStreaming) {
        return m.tool_calls
            .map((t) => `${t.id}:${t.function.name}:${t.function.arguments?.length ?? 0}`)
            .join("|");
    }
    return m.tool_calls.map((t) => `${t.id}:${t.function.name}`).join(",");
}

export function patchAssistantRowPlain(row: HTMLElement, m: ChatMessage): void {
    const think = row.querySelector(".agent-msg__think") as HTMLDetailsElement | null;
    const reasoningHost = row.querySelector(".agent-msg__reasoning") as HTMLElement | null;
    const bodyEl = row.querySelector(".agent-msg__body") as HTMLElement | null;
    const reasoningRaw = m.reasoning_content ? String(m.reasoning_content) : "";
    if (think) {
        think.hidden = !reasoningRaw;
    }
    if (reasoningHost) {
        reasoningHost.textContent = reasoningRaw;
    }
    if (bodyEl) {
        bodyEl.textContent = m.content ?? "";
    }
    patchAssistantTooling(row, m);
}

export interface PatchAssistantToolingOptions {
    sessionId?: string;
    onConfirmNotify?: (message: string, anchorEl: HTMLElement) => void;
}

let confirmNotifyHandler: PatchAssistantToolingOptions["onConfirmNotify"];

export function bindAssistantConfirmNotify(
    handler: PatchAssistantToolingOptions["onConfirmNotify"],
): void {
    confirmNotifyHandler = handler;
}

function ensureConfirmsAfterTools(row: HTMLElement): void {
    const tools = row.querySelector(".agent-msg__tools");
    const confirms = row.querySelector(".agent-msg__confirms");
    if (tools && confirms && confirms.previousElementSibling !== tools) {
        tools.after(confirms);
    }
}

/** 刷新消息级确认条与工具卡片 */
export function patchAssistantTooling(
    row: HTMLElement,
    m: ChatMessage,
    options: PatchAssistantToolingOptions = {},
): void {
    ensureConfirmsAfterTools(row);
    const sessionId = options.sessionId ?? readSessionIdFromMessagesEl(row);
    const onNotify = options.onConfirmNotify ?? confirmNotifyHandler;
    renderAssistantConfirmBanner(row, m, {sessionId, onNotify});
    renderAssistantToolCalls(row.querySelector(".agent-msg__tools") as HTMLElement, m, {
        sessionId,
        llmStreaming: m._streaming === true,
    });
}

/** 仅刷新工具卡片（tool call 流式参数阶段，跳过 Markdown 正文渲染） */
export function patchAssistantToolCallsOnly(row: HTMLElement, m: ChatMessage): void {
    const toolsSig = toolCallsSig(m, m._streaming === true);
    const statusSig = m._toolStatus ? JSON.stringify(m._toolStatus) : "";
    const resultsSig = toolResultsSig(m);
    const hintSig = toolHintSig(m);
    const confirmSig = toolConfirmSig(m);
    const diffSig = toolDiffSig(m);
    const prev = (row as unknown as Record<string, Patch | undefined>)[PATCH];
    if (
        prev &&
        prev.toolsSig === toolsSig &&
        prev.statusSig === statusSig &&
        prev.resultsSig === resultsSig &&
        prev.hintSig === hintSig &&
        prev.confirmSig === confirmSig &&
        prev.diffSig === diffSig
    ) {
        return;
    }
    if (prev) {
        prev.toolsSig = toolsSig;
        prev.statusSig = statusSig;
        prev.resultsSig = resultsSig;
        prev.hintSig = hintSig;
        prev.confirmSig = confirmSig;
        prev.diffSig = diffSig;
    } else {
        (row as unknown as Record<string, Patch>)[PATCH] = {
            content: m.content ?? "",
            reasoning: m.reasoning_content ? String(m.reasoning_content) : "",
            toolsSig,
            statusSig,
            resultsSig,
            hintSig,
            confirmSig,
            diffSig,
            streamOpen: m._mdStreaming === true,
            thinkingMdOpen: m._thinkingMdOpen === true,
        };
    }
    patchAssistantTooling(row, m);
}

export async function patchAssistantRow(
    row: HTMLElement,
    m: ChatMessage,
    lute: LuteEngine,
    destroyed: () => boolean,
): Promise<void> {
    const reasoningRaw = m.reasoning_content ? String(m.reasoning_content) : "";
    const contentRaw = m.content ?? "";
    const mdStreaming = m._mdStreaming === true;
    const thinkingMdOpen = m._thinkingMdOpen === true;
    const toolsSig = toolCallsSig(m, m._streaming === true);
    const statusSig = m._toolStatus ? JSON.stringify(m._toolStatus) : "";
    const resultsSig = toolResultsSig(m);
    const hintSig = toolHintSig(m);
    const confirmSig = toolConfirmSig(m);
    const diffSig = toolDiffSig(m);
    const prev = (row as unknown as Record<string, Patch | undefined>)[PATCH];
    const bodyUnchanged = prev != null && prev.content === contentRaw && prev.reasoning === reasoningRaw;
    if (
        prev &&
        prev.content === contentRaw &&
        prev.reasoning === reasoningRaw &&
        prev.toolsSig === toolsSig &&
        prev.statusSig === statusSig &&
        prev.resultsSig === resultsSig &&
        prev.hintSig === hintSig &&
        prev.confirmSig === confirmSig &&
        prev.diffSig === diffSig &&
        prev.streamOpen === mdStreaming
    ) {
        return;
    }
    (row as unknown as Record<string, Patch>)[PATCH] = {
        content: contentRaw,
        reasoning: reasoningRaw,
        toolsSig,
        statusSig,
        resultsSig,
        hintSig,
        confirmSig,
        diffSig,
        streamOpen: mdStreaming,
        thinkingMdOpen,
    };

    const think = row.querySelector(".agent-msg__think") as HTMLDetailsElement | null;
    if (think) {
        think.hidden = !reasoningRaw;
    }

    patchAssistantTooling(row, m);

    const copyBtn = row.querySelector("[data-copy-md]");
    if (copyBtn && !copyBtn.hasAttribute("data-bound")) {
        copyBtn.setAttribute("data-bound", "1");
        copyBtn.addEventListener("click", () => {
            void navigator.clipboard.writeText(m.content ?? "");
        });
    }

    const needStreamFinalize = prev != null && prev.streamOpen && !mdStreaming;
    const thinkingEnd = prev != null && prev.thinkingMdOpen && !thinkingMdOpen;
    const reasoningChanged = !prev || prev.reasoning !== reasoningRaw;
    const contentChanged = !prev || prev.content !== contentRaw;

    if (thinkingEnd && reasoningRaw) {
        forgetStreamMdCacheByKind(m, "reasoning");
        const reasoningHost = row.querySelector(".agent-msg__reasoning") as HTMLElement | null;
        if (reasoningHost) {
            clearStreamingDomHost(reasoningHost);
        }
    }
    if (needStreamFinalize) {
        forgetStreamMdCache(m);
        const reasoningHost = row.querySelector(".agent-msg__reasoning") as HTMLElement | null;
        if (reasoningHost && !thinkingEnd) {
            clearStreamingDomHost(reasoningHost);
        }
        const bodyEl = row.querySelector(".agent-msg__body") as HTMLElement | null;
        if (bodyEl) {
            clearStreamingDomHost(bodyEl);
        }
    }
    if (reasoningChanged || thinkingEnd || (needStreamFinalize && !!reasoningRaw)) {
        await syncAssistantReasoningDom(row, m, lute, mdStreaming, destroyed);
        if (destroyed()) {
            return;
        }
    }
    if (contentChanged || needStreamFinalize) {
        await syncAssistantContentDom(row, m, lute, mdStreaming, destroyed);
    }
}

/** 确保消息行已挂载到 DOM（在 async 渲染之前同步执行，避免竞态） */
export function ensureMessageRow(
    elMessages: HTMLElement,
    m: ChatMessage,
    rowByMessage: WeakMap<ChatMessage, HTMLElement>,
    slot: HTMLElement | undefined,
): HTMLElement {
    let row = rowByMessage.get(m);
    if (!row) {
        if (m.role === "assistant") {
            row = buildAssistantRow();
        } else if (m.role === "user") {
            row = buildUserMessageRow();
        } else if (m.role === "tool") {
            row = buildToolResultRow(m);
        } else {
            row = document.createElement("article");
            row.textContent = m.role;
        }
        rowByMessage.set(m, row);
    }
    if (slot !== row) {
        if (slot) {
            elMessages.replaceChild(row, slot);
        } else if (!row.isConnected) {
            elMessages.appendChild(row);
        }
    }
    return row;
}

export function clearAssistantCache(m: ChatMessage): void {
    if (m.role === "assistant") {
        forgetStreamMdCache(m);
    }
}
