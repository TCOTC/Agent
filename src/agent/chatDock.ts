import {
    getAllEditor,
    showMessage,
} from "siyuan";
import type {Plugin} from "siyuan";
import {runAgentLoop} from "./agentLoop";
import {
    defaultAgentSettings,
    defaultWorkset,
    normalizeSettings,
    normalizeWorkset,
    STORAGE_AGENT_SETTINGS,
    STORAGE_AGENT_WORKSET,
} from "./storage";
import {
    finalizeStreamingMdRemainder,
    forgetStreamMdCache,
    getLuteOrNull,
    getStreamingAssistantMdParts,
} from "./streamMdRender";
import {postRenderAgentMarkdownFragment} from "./typographyPostRender";
import type {
    AuditEvent,
    ChatMessage,
} from "./types";

function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

const lastAssistantPatchKey = "__agentLastPatch" as const;

type LastAssistantPatch = {
    content: string;
    reasoning: string;
    toolsSig: string;
    luteOn: boolean;
};

function formatAuditLine(e: AuditEvent): string {
    switch (e.kind) {
        case "user_message":
            return `[user] ${e.preview}`;
        case "llm_request":
            return `[llm→] model=${e.model} msgs=${e.messageCount}`;
        case "llm_response":
            return `[llm←] ${e.durationMs}ms reason=${e.finishReason ?? "-"}`;
        case "tool_call":
            return `[tool] ${e.name}(${e.argsPreview})`;
        case "tool_result":
            return `[tool] ${e.name} ${e.ok ? "ok" : "fail"} ${e.durationMs}ms${e.error ? " " + e.error : ""}`;
        case "tool_blocked":
            return `[blocked] ${e.name}: ${e.reason}`;
        default:
            return JSON.stringify(e);
    }
}

/**
 * 在 Dock 面板挂载方案 A 的聊天与工作集 UI。
 */
export function mountAgentDock(plugin: Plugin, dockElement: HTMLElement): void {
    const L = (k: string, fb: string) => (plugin.i18n as Record<string, string>)[k] ?? fb;

    dockElement.innerHTML = `<div class="plugin-agent-dock fn__flex-column">
  <div class="plugin-agent-dock__toolbar fn__flex">
    <button type="button" class="b3-button b3-button--outline" data-action="add-doc">${
        esc(L("agentAddWorkset", "加入当前文档"))
    }</button>
    <button type="button" class="b3-button b3-button--outline" data-action="clear-ws">${
        esc(L("agentClearWorkset", "清空工作集"))
    }</button>
    <button type="button" class="b3-button b3-button--outline" data-action="clear-chat">${
        esc(L("agentClearChat", "清空对话"))
    }</button>
  </div>
  <div class="plugin-agent-dock__workset b3-label__text" data-workset></div>
  <details class="plugin-agent-dock__audit">
    <summary>${esc(L("agentAuditLog", "运行日志"))}</summary>
    <pre class="plugin-agent-dock__audit-pre" data-audit></pre>
  </details>
  <div class="plugin-agent-dock__messages fn__flex-1" data-messages></div>
  <div class="plugin-agent-dock__input-row fn__flex">
    <textarea class="b3-text-field fn__flex-1" rows="3" data-input placeholder="${
        esc(L("agentInputPlaceholder", "输入消息…"))
    }"></textarea>
    <div class="plugin-agent-dock__send-col fn__flex-column">
      <button type="button" class="b3-button b3-button--text" data-send>${esc(L("agentSend", "发送"))}</button>
      <button type="button" class="b3-button b3-button--cancel" data-stop disabled>${
        esc(L("agentStop", "停止"))
    }</button>
    </div>
  </div>
</div>`;

    const elWorkset = dockElement.querySelector("[data-workset]") as HTMLElement;
    const elAudit = dockElement.querySelector("[data-audit]") as HTMLElement;
    const elMessages = dockElement.querySelector("[data-messages]") as HTMLElement;
    const elInput = dockElement.querySelector("[data-input]") as HTMLTextAreaElement;
    const btnSend = dockElement.querySelector("[data-send]") as HTMLButtonElement;
    const btnStop = dockElement.querySelector("[data-stop]") as HTMLButtonElement;

    let settings = {...defaultAgentSettings};
    let workset = {...defaultWorkset};
    const chatMessages: ChatMessage[] = [];
    /** 每条内存中的消息对应一行 DOM，流式时只更新该行子节点 */
    const rowByMessage = new WeakMap<ChatMessage, HTMLElement>();
    let abortCtl: AbortController | null = null;
    let streamRenderRaf = 0;

    const scheduleStreamRender = () => {
        if (streamRenderRaf) {
            return;
        }
        streamRenderRaf = requestAnimationFrame(() => {
            streamRenderRaf = 0;
            renderMessages();
        });
    };

    const auditLines: string[] = [];
    const pushAudit = (e: AuditEvent) => {
        auditLines.push(`${new Date().toLocaleTimeString()} ${formatAuditLine(e)}`);
        if (auditLines.length > 200) {
            auditLines.splice(0, auditLines.length - 200);
        }
        elAudit.textContent = auditLines.join("\n");
    };

    const persistWorkset = () => plugin.saveData(STORAGE_AGENT_WORKSET, workset).catch(() => {});

    function renderWorkset() {
        if (!workset.rootIds.length) {
            elWorkset.textContent = L("agentWorksetEmpty", "工作集为空：请先「加入当前文档」。");
            return;
        }
        elWorkset.innerHTML = `<span class="b3-label__text">${esc(L("agentWorksetLabel", "工作集"))}：</span>` +
            workset.rootIds.map((id) =>
                `<span class="b3-chip" data-root="${esc(id)}">${esc(id.slice(0, 8))}…` +
                `<span class="b3-chip__close" data-remove="${esc(id)}">×</span></span>`
            ).join(" ");
        elWorkset.querySelectorAll("[data-remove]").forEach((chip) => {
            chip.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const id = (chip as HTMLElement).dataset.remove;
                if (!id) {
                    return;
                }
                workset.rootIds = workset.rootIds.filter((x) => x !== id);
                persistWorkset();
                renderWorkset();
            });
        });
    }

    function renderEmptyMessagesPlaceholder(): void {
        elMessages.replaceChildren();
        const empty = document.createElement("div");
        empty.className = "b3-label__text";
        empty.dataset.agentPlaceholder = "1";
        empty.textContent = L("agentNoMessages", "暂无消息");
        elMessages.appendChild(empty);
    }

    function buildUserRow(m: ChatMessage): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "plugin-agent-msg plugin-agent-msg--user";
        const role = document.createElement("div");
        role.className = "plugin-agent-msg__role";
        role.textContent = "User";
        const pre = document.createElement("pre");
        pre.textContent = m.content ?? "";
        wrap.append(role, pre);
        return wrap;
    }

    function patchUserRow(row: HTMLElement, m: ChatMessage): void {
        const pre = row.querySelector("pre");
        if (pre) {
            pre.textContent = m.content ?? "";
        }
    }

    function buildToolRow(m: ChatMessage): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "plugin-agent-msg plugin-agent-msg--tool";
        const role = document.createElement("div");
        role.className = "plugin-agent-msg__role";
        role.textContent = `Tool ${m.tool_call_id ?? ""}`;
        const pre = document.createElement("pre");
        pre.textContent = (m.content ?? "").slice(0, 4000);
        wrap.append(role, pre);
        return wrap;
    }

    function patchToolRow(row: HTMLElement, m: ChatMessage): void {
        const pre = row.querySelector("pre");
        if (pre) {
            pre.textContent = (m.content ?? "").slice(0, 4000);
        }
    }

    function buildAssistantRow(): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "plugin-agent-msg plugin-agent-msg--assistant";
        const role = document.createElement("div");
        role.className = "plugin-agent-msg__role";
        role.textContent = "Assistant";
        const reasoningHost = document.createElement("div");
        reasoningHost.className = "plugin-agent-msg__reasoning-host";
        const body = document.createElement("div");
        body.dataset.part = "body";
        const tools = document.createElement("pre");
        tools.className = "plugin-agent-msg__tools";
        tools.hidden = true;
        tools.dataset.part = "tools";
        wrap.append(role, reasoningHost, body, tools);
        return wrap;
    }

    type LuteNonNull = NonNullable<ReturnType<typeof getLuteOrNull>>;

    /**
     * 将「已封存的第一层块」各自对应一个子节点且只写一次 innerHTML；仅尾部容器每帧更新。
     */
    function syncStreamingMdHost(
        host: HTMLElement,
        m: ChatMessage,
        fullMd: string,
        lute: LuteNonNull,
        kind: "content" | "reasoning",
    ): void {
        const {sealedHtmlParts, tailHtml} = getStreamingAssistantMdParts(m, fullMd, lute, kind);
        const n = sealedHtmlParts.length;

        host.querySelectorAll("[data-agent-md-sealed]").forEach((el) => {
            const idx = parseInt((el as HTMLElement).dataset.agentMdSealed ?? "", 10);
            if (!Number.isFinite(idx) || idx >= n) {
                el.remove();
            }
        });

        const tailList = [...host.querySelectorAll("[data-agent-md-tail=\"1\"]")];
        if (tailList.length > 1) {
            for (let i = 1; i < tailList.length; i++) {
                tailList[i].remove();
            }
        }
        let tailEl = host.querySelector("[data-agent-md-tail=\"1\"]") as HTMLElement | null;

        for (let i = 0; i < n; i++) {
            const html = sealedHtmlParts[i];
            let chunk = host.querySelector(`[data-agent-md-sealed="${i}"]`) as HTMLElement | null;
            if (!chunk) {
                chunk = document.createElement("div");
                chunk.dataset.agentMdSealed = String(i);
                chunk.className = "plugin-agent-md-sealed";
                chunk.innerHTML = html;
                if (tailEl) {
                    host.insertBefore(chunk, tailEl);
                } else {
                    host.appendChild(chunk);
                }
            }
        }

        if (!tailEl) {
            tailEl = document.createElement("div");
            tailEl.dataset.agentMdTail = "1";
            tailEl.className = "plugin-agent-md-tail";
            host.appendChild(tailEl);
        }
        if (tailEl.innerHTML !== tailHtml) {
            tailEl.innerHTML = tailHtml;
        }
        postRenderAgentMarkdownFragment(host);
    }

    function patchAssistantRow(row: HTMLElement, m: ChatMessage, lute: ReturnType<typeof getLuteOrNull>): void {
        const reasoningRaw = m.reasoning_content != null && m.reasoning_content !== "" ?
            String(m.reasoning_content) :
            "";
        const toolsSig = m.tool_calls?.map((t) => `${t.function.name}(${t.function.arguments})`).join("\n") ?? "";
        const contentRaw = m.content ?? "";
        const prev = (row as unknown as Record<string, LastAssistantPatch | undefined>)[lastAssistantPatchKey];
        if (
            prev &&
            prev.content === contentRaw &&
            prev.reasoning === reasoningRaw &&
            prev.toolsSig === toolsSig &&
            prev.luteOn === Boolean(lute)
        ) {
            return;
        }
        (row as unknown as Record<string, LastAssistantPatch>)[lastAssistantPatchKey] = {
            content: contentRaw,
            reasoning: reasoningRaw,
            toolsSig,
            luteOn: Boolean(lute),
        };

        const reasoningHost = row.querySelector(".plugin-agent-msg__reasoning-host") as HTMLElement | null;
        const bodyEl = row.querySelector("[data-part=\"body\"]") as HTMLElement | null;
        const toolsEl = row.querySelector("[data-part=\"tools\"]") as HTMLPreElement | null;
        if (!reasoningHost || !bodyEl || !toolsEl) {
            return;
        }

        if (!reasoningRaw) {
            reasoningHost.replaceChildren();
            reasoningHost.className = "plugin-agent-msg__reasoning-host";
        } else if (!lute) {
            reasoningHost.className = "plugin-agent-msg__reasoning-host";
            reasoningHost.replaceChildren();
            const pre = document.createElement("pre");
            pre.className = "plugin-agent-msg__reasoning";
            pre.textContent = reasoningRaw;
            reasoningHost.append(pre);
        } else {
            reasoningHost.className =
                "plugin-agent-msg__reasoning-host plugin-agent-msg__reasoning b3-typography b3-typography--default";
            if (reasoningHost.querySelector(":scope > pre")) {
                reasoningHost.replaceChildren();
            }
            // 正文一旦出现输出，将推理通道仍留在 tail 的 Markdown 一次性封存（幂等），避免 tail 每帧随 RAF 重绘
            if (contentRaw.length > 0) {
                finalizeStreamingMdRemainder(m, reasoningRaw, lute, "reasoning");
            }
            syncStreamingMdHost(reasoningHost, m, reasoningRaw, lute, "reasoning");
        }

        if (lute) {
            const wasPlain = bodyEl.classList.contains("plugin-agent-msg__body--plain");
            bodyEl.className = "plugin-agent-msg__body b3-typography b3-typography--default";
            if (wasPlain) {
                bodyEl.replaceChildren();
            }
            syncStreamingMdHost(bodyEl, m, contentRaw, lute, "content");
        } else {
            bodyEl.className = "plugin-agent-msg__body plugin-agent-msg__body--plain";
            bodyEl.replaceChildren();
            bodyEl.textContent = contentRaw;
        }

        if (toolsSig) {
            toolsEl.hidden = false;
            toolsEl.textContent = toolsSig;
        } else {
            toolsEl.hidden = true;
            toolsEl.textContent = "";
        }
    }

    function buildMessageRow(m: ChatMessage, lute: ReturnType<typeof getLuteOrNull>): HTMLElement {
        if (m.role === "user") {
            return buildUserRow(m);
        }
        if (m.role === "tool") {
            return buildToolRow(m);
        }
        if (m.role === "assistant") {
            const row = buildAssistantRow();
            patchAssistantRow(row, m, lute);
            return row;
        }
        const fallback = document.createElement("div");
        fallback.className = "plugin-agent-msg";
        fallback.textContent = m.role;
        return fallback;
    }

    function patchMessageRow(row: HTMLElement, m: ChatMessage, lute: ReturnType<typeof getLuteOrNull>): void {
        if (m.role === "user") {
            patchUserRow(row, m);
        } else if (m.role === "tool") {
            patchToolRow(row, m);
        } else if (m.role === "assistant") {
            patchAssistantRow(row, m, lute);
        }
    }

    function renderMessages(): void {
        if (!chatMessages.length) {
            renderEmptyMessagesPlaceholder();
            elMessages.scrollTop = 0;
            return;
        }

        elMessages.querySelector("[data-agent-placeholder]")?.remove();

        const lute = getLuteOrNull();

        while (elMessages.lastElementChild && elMessages.children.length > chatMessages.length) {
            elMessages.removeChild(elMessages.lastElementChild);
        }

        for (let i = 0; i < chatMessages.length; i++) {
            const m = chatMessages[i];
            const slot = elMessages.children[i] as HTMLElement | undefined;
            let row = rowByMessage.get(m);

            if (row && slot === row) {
                patchMessageRow(row, m, lute);
                continue;
            }

            if (row && slot !== row) {
                elMessages.insertBefore(row, slot ?? null);
                patchMessageRow(row, m, lute);
                continue;
            }

            row = buildMessageRow(m, lute);
            rowByMessage.set(m, row);
            if (slot) {
                elMessages.replaceChild(row, slot);
            } else {
                elMessages.appendChild(row);
            }
        }

        elMessages.scrollTop = elMessages.scrollHeight;
    }

    plugin.loadData(STORAGE_AGENT_SETTINGS).then((d) => {
        settings = normalizeSettings(d);
    }).catch(() => {});
    plugin.loadData(STORAGE_AGENT_WORKSET).then((d) => {
        workset = normalizeWorkset(d);
        renderWorkset();
    }).catch(() => {});

    renderWorkset();
    renderMessages();

    dockElement.querySelector('[data-action="add-doc"]')?.addEventListener("click", () => {
        const eds = getAllEditor();
        if (!eds.length) {
            showMessage(L("agentOpenDocFirst", "请先打开文档"));
            return;
        }
        const rootId = eds[0].protyle.block.rootID;
        if (!rootId) {
            return;
        }
        if (workset.rootIds.indexOf(rootId) === -1) {
            workset.rootIds.push(rootId);
            persistWorkset();
            renderWorkset();
        }
    });
    dockElement.querySelector('[data-action="clear-ws"]')?.addEventListener("click", () => {
        workset.rootIds = [];
        persistWorkset();
        renderWorkset();
    });
    dockElement.querySelector('[data-action="clear-chat"]')?.addEventListener("click", () => {
        for (const m of chatMessages) {
            if (m.role === "assistant") {
                forgetStreamMdCache(m);
            }
        }
        chatMessages.length = 0;
        renderMessages();
    });

    const runSend = async () => {
        const text = elInput.value.trim();
        if (!text) {
            return;
        }
        try {
            const raw = await plugin.loadData(STORAGE_AGENT_SETTINGS);
            settings = normalizeSettings(raw);
        } catch {
            /* 忽略加载失败，沿用内存中的默认配置 */
        }
        if (!settings.apiKey) {
            showMessage(L("agentNeedApiKey", "请先在插件设置中填写 API Key"));
            return;
        }
        elInput.value = "";
        abortCtl?.abort();
        abortCtl = new AbortController();
        btnSend.disabled = true;
        btnStop.disabled = false;

        try {
            await runAgentLoop({
                llm: {
                    baseUrl: settings.baseUrl,
                    apiKey: settings.apiKey,
                    model: settings.model,
                },
                allowSqlTool: settings.allowSqlTool,
                worksetRootIds: new Set(workset.rootIds),
                messages: chatMessages,
                userText: text,
                signal: abortCtl.signal,
                onAudit: pushAudit,
                onStreamDelta: scheduleStreamRender,
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg !== "aborted") {
                showMessage(`${L("agentError", "错误")}: ${msg}`);
                pushAudit({kind: "tool_blocked", name: "agent", reason: msg});
            }
        } finally {
            if (streamRenderRaf) {
                cancelAnimationFrame(streamRenderRaf);
                streamRenderRaf = 0;
            }
            btnSend.disabled = false;
            btnStop.disabled = true;
            abortCtl = null;
            renderMessages();
        }
    };

    btnSend.addEventListener("click", () => void runSend());
    elInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
            ev.preventDefault();
            void runSend();
        }
    });
    btnStop.addEventListener("click", () => {
        abortCtl?.abort();
    });
}
