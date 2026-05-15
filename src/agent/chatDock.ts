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
    forgetStreamMdCache,
    getLuteOrNull,
    renderStreamingAssistantMd,
} from "./streamMdRender";
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

    function renderMessages() {
        const parts: string[] = [];
        for (const m of chatMessages) {
            if (m.role === "user") {
                parts.push(
                    `<div class="plugin-agent-msg plugin-agent-msg--user"><div class="plugin-agent-msg__role">User</div><pre>${
                        esc(m.content ?? "")
                    }</pre></div>`,
                );
            } else if (m.role === "assistant") {
                const lute = getLuteOrNull();
                const reasoningRaw = m.reasoning_content != null && m.reasoning_content !== "" ?
                    String(m.reasoning_content) :
                    "";
                const reasoning = reasoningRaw ?
                    (lute ?
                        `<div class="plugin-agent-msg__reasoning b3-typography b3-typography--default">${
                            renderStreamingAssistantMd(m, reasoningRaw, lute, "reasoning")
                        }</div>` :
                        `<pre class="plugin-agent-msg__reasoning">${esc(reasoningRaw)}</pre>`) :
                    "";
                const bodyRaw = m.content ?? "";
                const body = lute ?
                    `<div class="plugin-agent-msg__body b3-typography b3-typography--default">${
                        renderStreamingAssistantMd(m, bodyRaw, lute, "content")
                    }</div>` :
                    `<pre>${esc(bodyRaw)}</pre>`;
                const tools = m.tool_calls?.map((t) => `${t.function.name}(${t.function.arguments})`).join("\n");
                parts.push(
                    `<div class="plugin-agent-msg plugin-agent-msg--assistant"><div class="plugin-agent-msg__role">Assistant</div>${
                        reasoning
                    }${body}${
                        tools ?
                            `<pre class="plugin-agent-msg__tools">${esc(tools)}</pre>` :
                            ""
                    }</div>`,
                );
            } else if (m.role === "tool") {
                parts.push(
                    `<div class="plugin-agent-msg plugin-agent-msg--tool"><div class="plugin-agent-msg__role">Tool ${
                        esc(m.tool_call_id ?? "")
                    }</div><pre>${esc((m.content ?? "").slice(0, 4000))}</pre></div>`,
                );
            }
        }
        elMessages.innerHTML = parts.join("") ||
            `<div class="b3-label__text">${esc(L("agentNoMessages", "暂无消息"))}</div>`;
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
