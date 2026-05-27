import type {ChatMessage} from "../../agent/types";
import type {LuteEngine} from "../../render/lute";
import {forgetStreamMdCache} from "../../render/streamMdRender";
import {syncAssistantMessageDom} from "../../render/streamingDom";

const PATCH = "__agentPatch";

type Patch = {content: string; reasoning: string; toolsSig: string; statusSig: string; streamOpen: boolean};

export function buildUserMessageRow(content: string): HTMLElement {
    const row = document.createElement("article");
    row.className = "agent-msg agent-msg--user";
    row.innerHTML = `<div class="agent-msg__avatar">你</div>
<div class="agent-msg__bubble">
  <div class="agent-msg__actions">
    <button type="button" class="agent-msg__action" data-copy title="复制">复制</button>
  </div>
  <pre class="agent-msg__text"></pre>
</div>`;
    row.querySelector(".agent-msg__text")!.textContent = content;
    row.querySelector("[data-copy]")?.addEventListener("click", () => {
        void navigator.clipboard.writeText(content);
    });
    return row;
}

export function buildToolResultRow(m: ChatMessage): HTMLElement {
    const row = document.createElement("article");
    row.className = "agent-msg agent-msg--tool";
    const preview = (m.content ?? "").slice(0, 3000);
    row.innerHTML = `<div class="agent-msg__avatar">⚙</div>
<div class="agent-msg__bubble agent-msg__bubble--tool">
  <div class="agent-msg__head">工具结果</div>
  <pre class="agent-msg__text"></pre>
</div>`;
    row.querySelector(".agent-msg__text")!.textContent = preview;
    return row;
}

export function buildAssistantRow(): HTMLElement {
    const row = document.createElement("article");
    row.className = "agent-msg agent-msg--assistant";
    row.innerHTML = `<div class="agent-msg__avatar">AI</div>
<div class="agent-msg__bubble">
  <details class="agent-msg__think" open>
    <summary>思考</summary>
    <div class="agent-msg__reasoning b3-typography b3-typography--default"></div>
  </details>
  <div class="agent-msg__body b3-typography b3-typography--default"></div>
  <div class="agent-msg__tools-live"></div>
  <div class="agent-msg__tools-done"></div>
  <div class="agent-msg__actions">
    <button type="button" class="agent-msg__action" data-copy-md title="复制 Markdown">复制</button>
  </div>
</div>`;
    return row;
}

function toolStatusSig(m: ChatMessage): string {
    if (!m._toolStatus) {
        return "";
    }
    return JSON.stringify(m._toolStatus);
}

function renderLiveTools(host: HTMLElement, m: ChatMessage): void {
    host.replaceChildren();
    if (!m.tool_calls?.length) {
        return;
    }
    for (const tc of m.tool_calls) {
        const st = m._toolStatus?.[tc.id] ?? "running";
        const el = document.createElement("div");
        el.className = `agent-tool-live agent-tool-live--${st}`;
        const icon = st === "running" ? '<span class="agent-spinner"></span>' : st === "ok" ? "✓" : "✗";
        el.innerHTML = `${icon}<span class="agent-tool-live__name">${tc.function.name}</span>`;
        host.appendChild(el);
    }
}

function renderDoneTools(host: HTMLElement, m: ChatMessage): void {
    host.replaceChildren();
    if (!m.tool_calls?.length || m._toolStatus) {
        return;
    }
    for (const tc of m.tool_calls) {
        const card = document.createElement("details");
        card.className = "agent-tool-card";
        card.innerHTML = `<summary>🔧 ${tc.function.name}</summary><pre>${tc.function.arguments ?? "{}"}</pre>`;
        host.appendChild(card);
    }
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
}

export async function patchAssistantRow(
    row: HTMLElement,
    m: ChatMessage,
    lute: LuteEngine,
    streamOpen: boolean,
    destroyed: () => boolean,
): Promise<void> {
    const reasoningRaw = m.reasoning_content ? String(m.reasoning_content) : "";
    const contentRaw = m.content ?? "";
    const toolsSig = m.tool_calls?.map((t) => t.function.name).join(",") ?? "";
    const statusSig = toolStatusSig(m);
    const prev = (row as unknown as Record<string, Patch | undefined>)[PATCH];
    if (
        prev &&
        prev.content === contentRaw &&
        prev.reasoning === reasoningRaw &&
        prev.toolsSig === toolsSig &&
        prev.statusSig === statusSig &&
        prev.streamOpen === streamOpen
    ) {
        return;
    }
    (row as unknown as Record<string, Patch>)[PATCH] = {
        content: contentRaw,
        reasoning: reasoningRaw,
        toolsSig,
        statusSig,
        streamOpen,
    };

    const think = row.querySelector(".agent-msg__think") as HTMLDetailsElement | null;
    if (think) {
        think.hidden = !reasoningRaw;
    }

    renderLiveTools(row.querySelector(".agent-msg__tools-live") as HTMLElement, m);
    renderDoneTools(row.querySelector(".agent-msg__tools-done") as HTMLElement, m);

    const copyBtn = row.querySelector("[data-copy-md]");
    if (copyBtn && !copyBtn.hasAttribute("data-bound")) {
        copyBtn.setAttribute("data-bound", "1");
        copyBtn.addEventListener("click", () => {
            void navigator.clipboard.writeText(m.content ?? "");
        });
    }

    await syncAssistantMessageDom(row, m, lute, streamOpen, destroyed);
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
            row = buildUserMessageRow(m.content ?? "");
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
