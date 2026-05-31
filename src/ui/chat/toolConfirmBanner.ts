import type {ChatMessage, ToolConfirmInfo} from "../../agent/types";
import {detachAssistantConfirmHost, mountAssistantConfirmHost} from "./assistantRowChrome";
import {pendingActionKey, readSessionIdFromMessagesEl, resolveInlineToolConfirm} from "./inlineToolActions";

const notifiedPendingIds = new Set<string>();

/** 新会话或卸载时清空，避免重复通知被跳过 */
export function clearConfirmNotifications(): void {
    notifiedPendingIds.clear();
}

export interface RenderConfirmBannerOptions {
    /** 所属会话 id（缺省时从 data-messages 读取） */
    sessionId?: string;
    /** 首次出现待确认项时提醒用户（如 showPluginMessage） */
    onNotify?: (message: string, anchorEl: HTMLElement) => void;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function toolNameForId(m: ChatMessage, toolCallId: string): string {
    const tc = m.tool_calls?.find((t) => t.id === toolCallId);
    return tc?.function.name ?? "工具";
}

function dismissConfirmPanel(row: HTMLElement, toolCallId: string): void {
    const host = row.querySelector(".agent-msg__confirms");
    if (!host) {
        return;
    }
    host.querySelector(`[data-confirm-id="${CSS.escape(toolCallId)}"]`)?.remove();
    if (!host.querySelector(".agent-msg-confirm")) {
        host.replaceChildren();
        detachAssistantConfirmHost(row);
    }
}

function bindConfirmPanel(panel: HTMLElement, sessionId: string, toolCallId: string): void {
    if (panel.hasAttribute("data-bound")) {
        return;
    }
    panel.setAttribute("data-bound", "1");
    const finish = (approved: boolean) => {
        const row = panel.closest(".agent-msg--assistant") as HTMLElement | null;
        if (row) {
            dismissConfirmPanel(row, toolCallId);
        } else {
            panel.remove();
        }
        resolveInlineToolConfirm(sessionId, toolCallId, approved);
    };
    panel.querySelector("[data-approve]")?.addEventListener("click", () => finish(true));
    panel.querySelector("[data-reject]")?.addEventListener("click", () => finish(false));
}

function createConfirmPanel(sessionId: string, toolCallId: string): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "agent-msg-confirm";
    panel.dataset.confirmId = toolCallId;
    panel.dataset.agentSessionId = sessionId;
    panel.setAttribute("role", "alert");
    panel.innerHTML = `
<div class="agent-msg-confirm__badge">待确认</div>
<div class="agent-msg-confirm__head">
  <span class="agent-msg-confirm__tool"></span>
  <span class="agent-msg-confirm__hint">写操作需你确认后才会执行</span>
</div>
<div class="agent-msg-confirm__risk"></div>
<details class="agent-msg-confirm__detail">
  <summary>查看参数摘要</summary>
  <pre class="agent-msg-confirm__detail-pre"></pre>
</details>
<div class="agent-msg-confirm__actions fn__flex">
  <button type="button" class="b3-button b3-button--cancel" data-reject>拒绝</button>
  <button type="button" class="b3-button b3-button--text agent-msg-confirm__approve" data-approve>允许执行</button>
</div>`;
    bindConfirmPanel(panel, sessionId, toolCallId);
    return panel;
}

function patchConfirmPanel(panel: HTMLElement, m: ChatMessage, toolCallId: string, info: ToolConfirmInfo): void {
    const name = toolNameForId(m, toolCallId);
    const toolEl = panel.querySelector(".agent-msg-confirm__tool")!;
    if (toolEl.textContent !== name) {
        toolEl.textContent = name;
    }
    const riskEl = panel.querySelector(".agent-msg-confirm__risk")!;
    const riskText = info.riskSummary;
    if (riskEl.textContent !== riskText) {
        riskEl.textContent = riskText;
    }
    const pre = panel.querySelector(".agent-msg-confirm__detail-pre")!;
    const detail = info.detail.trim();
    if (pre.textContent !== detail) {
        pre.textContent = detail || "（无摘要）";
    }
}

/** 消息级风险确认条（位于 agent-msg__tools 下方） */
export function renderAssistantConfirmBanner(
    row: HTMLElement,
    m: ChatMessage,
    options: RenderConfirmBannerOptions = {},
): void {
    const sessionId = options.sessionId ?? readSessionIdFromMessagesEl(row);
    if (!sessionId) {
        return;
    }

    const pending = Object.entries(m._toolConfirm ?? {}).filter(([, v]) => v.status === "pending");
    if (!pending.length) {
        detachAssistantConfirmHost(row);
        return;
    }

    const host = mountAssistantConfirmHost(row);
    const seen = new Set<string>();

    for (const [toolCallId, info] of pending) {
        seen.add(toolCallId);
        let panel = host.querySelector(
            `[data-confirm-id="${CSS.escape(toolCallId)}"]`,
        ) as HTMLElement | null;
        if (!panel) {
            panel = createConfirmPanel(sessionId, toolCallId);
            host.appendChild(panel);
        } else if (panel.dataset.agentSessionId !== sessionId) {
            panel.dataset.agentSessionId = sessionId;
            panel.removeAttribute("data-bound");
            bindConfirmPanel(panel, sessionId, toolCallId);
        }
        patchConfirmPanel(panel, m, toolCallId, info);

        const notifyKey = pendingActionKey(sessionId, toolCallId);
        if (!notifiedPendingIds.has(notifyKey)) {
            notifiedPendingIds.add(notifyKey);
            const name = toolNameForId(m, toolCallId);
            options.onNotify?.(
                `Agent 等待确认：${name}。请在对话中高亮区域点击「允许执行」或「拒绝」。`,
                panel,
            );
        }
    }

    for (const old of host.querySelectorAll(".agent-msg-confirm")) {
        const id = (old as HTMLElement).dataset.confirmId;
        if (id && !seen.has(id)) {
            old.remove();
        }
    }
}
