import type Agent from "../../index";
import {runAgentLoop} from "../../agent/agentLoop";
import type {AuditEvent, ChatMessage} from "../../agent/types";
import {listDeepSeekModels} from "../../agent/deepseekClient";
import {ActivityLogBuffer} from "../../core/activityLog";
import {STORAGE_KEY_ACTIVITY, STORAGE_KEY_SESSIONS, STORAGE_KEY_TOKEN_STATS} from "../../core/constants";
import {captureEditorContext, formatEditorContextForPrompt} from "../../core/editorContext";
import {
    formatTokenBrief,
    mergeUsage,
    parseDeepSeekUsage,
    type TokenStatsPersisted,
    type TokenUsageRecord,
} from "../../core/tokenUsage";
import {forgetStreamMdCache} from "../../render/streamMdRender";
import {getLuteResult} from "../../render/lute";
import {syncAssistantMessageDom} from "../../render/streamingDom";
import {
    createSession,
    deriveSessionTitle,
    normalizeSessions,
} from "../../session/storage";
import type {ChatSession, SessionsPersisted} from "../../session/types";
import {normalizeSettings, STORAGE_KEY_SETTINGS} from "../../settings/storage";
import type {PersistedSettings} from "../../settings/types";
import {confirmPromise} from "../../util";

function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

const lastPatchKey = "__agentPatch" as const;

type AssistantPatch = {
    content: string;
    reasoning: string;
    toolsSig: string;
    streamOpen: boolean;
};

/**
 * Cursor 风格 Agent 侧栏：多会话、流式 Markdown、工具卡片、Composer、Token 统计。
 */
export function mountAgentPanel(plugin: Agent, root: HTMLElement): () => void {
    let destroyed = false;
    let renderSeq = 0;
    let streamRaf = 0;
    let abortCtl: AbortController | null = null;
    const rowByMessage = new WeakMap<ChatMessage, HTMLElement>();
    const activityBuf = new ActivityLogBuffer();
    let includeEditorContext = true;

    let sessions: SessionsPersisted = normalizeSessions(plugin.data[STORAGE_KEY_SESSIONS]);
    const getActiveSession = (): ChatSession => {
        const s = sessions.sessions.find((x) => x.id === sessions.activeId);
        return s ?? sessions.sessions[0];
    };

    root.innerHTML = `<div class="agent-panel fn__flex-column">
  <header class="agent-panel__header fn__flex">
    <span class="agent-panel__brand fn__flex-center">Agent</span>
    <select class="b3-select agent-panel__session-select fn__flex-1" data-session-select></select>
    <button type="button" class="b3-button b3-button--text" data-new-session title="新对话">+</button>
    <button type="button" class="b3-button b3-button--text" data-clear-session title="清空当前对话">⌫</button>
    <button type="button" class="b3-button b3-button--text" data-open-settings title="设置">⚙</button>
  </header>
  <div class="agent-panel__messages fn__flex-1" data-messages></div>
  <footer class="agent-panel__footer">
    <div class="agent-panel__token fn__ellipsis" data-token-stats>Token：—</div>
    <label class="agent-panel__ctx fn__flex-center">
      <input type="checkbox" data-include-ctx checked />
      <span>附带当前文档上下文</span>
    </label>
  </footer>
  <div class="agent-panel__composer fn__flex-column">
    <textarea class="b3-text-field agent-panel__input" rows="3" data-input placeholder="输入消息，Ctrl+Enter 发送…"></textarea>
    <div class="agent-panel__composer-bar fn__flex">
      <select class="b3-select agent-panel__model" data-model></select>
      <label class="fn__flex-center agent-panel__thinking-label">
        <input type="checkbox" data-thinking checked />
        <span>思考</span>
      </label>
      <button type="button" class="b3-button b3-button--text" data-insert-ctx title="插入当前文档 ID">@ 文档</button>
      <span class="fn__flex-1"></span>
      <button type="button" class="b3-button b3-button--text" data-send>发送</button>
      <button type="button" class="b3-button b3-button--cancel" data-stop disabled>停止</button>
    </div>
  </div>
</div>`;

    const elMessages = root.querySelector("[data-messages]") as HTMLElement;
    const elInput = root.querySelector("[data-input]") as HTMLTextAreaElement;
    const elSessionSelect = root.querySelector("[data-session-select]") as HTMLSelectElement;
    const elModel = root.querySelector("[data-model]") as HTMLSelectElement;
    const elToken = root.querySelector("[data-token-stats]") as HTMLElement;
    const btnSend = root.querySelector("[data-send]") as HTMLButtonElement;
    const btnStop = root.querySelector("[data-stop]") as HTMLButtonElement;
    const chkThinking = root.querySelector("[data-thinking]") as HTMLInputElement;
    const chkCtx = root.querySelector("[data-include-ctx]") as HTMLInputElement;

    const isDestroyed = () => destroyed;

    const persistSessions = () => {
        plugin.data[STORAGE_KEY_SESSIONS] = sessions;
        void plugin.saveData(STORAGE_KEY_SESSIONS, sessions);
    };

    const flushActivity = async () => {
        const chunk = activityBuf.drain();
        if (!chunk) {
            return;
        }
        const prev = (await plugin.loadData(STORAGE_KEY_ACTIVITY)) as string | null;
        const merged = prev ? `${prev}\n${chunk}` : chunk;
        const lines = merged.split("\n");
        const trimmed = lines.slice(-8000).join("\n");
        await plugin.saveData(STORAGE_KEY_ACTIVITY, trimmed);
    };

    const pushAudit = (e: AuditEvent) => {
        if (destroyed) {
            return;
        }
        activityBuf.push(e);
        if (e.kind === "llm_response" && e.usage) {
            const u = parseDeepSeekUsage(e.usage);
            if (u) {
                const sess = getActiveSession();
                sess.tokenUsage = mergeUsage(sess.tokenUsage, u);
                updateTokenDisplay();
                void persistTokenStats(u);
            }
        }
        void flushActivity();
    };

    const persistTokenStats = async (delta: TokenUsageRecord) => {
        const raw = (await plugin.loadData(STORAGE_KEY_TOKEN_STATS)) as TokenStatsPersisted | null;
        const base: TokenStatsPersisted = raw?.lifetime ?
            raw :
            {lifetime: {promptTokens: 0, completionTokens: 0, totalTokens: 0}, sessions: {}, lastUpdated: ""};
        base.lifetime = mergeUsage(base.lifetime, delta);
        const sid = sessions.activeId;
        base.sessions[sid] = mergeUsage(base.sessions[sid] ?? {promptTokens: 0, completionTokens: 0, totalTokens: 0}, delta);
        base.lastUpdated = new Date().toISOString();
        await plugin.saveData(STORAGE_KEY_TOKEN_STATS, base);
    };

    const updateTokenDisplay = () => {
        const s = getActiveSession();
        elToken.textContent = `Token：${formatTokenBrief(s.tokenUsage)}`;
    };

    const refreshSessionSelect = () => {
        elSessionSelect.innerHTML = "";
        for (const s of sessions.sessions) {
            const opt = document.createElement("option");
            opt.value = s.id;
            opt.textContent = s.title;
            if (s.id === sessions.activeId) {
                opt.selected = true;
            }
            elSessionSelect.appendChild(opt);
        }
        updateTokenDisplay();
    };

    const scheduleStreamRender = () => {
        if (destroyed || streamRaf) {
            return;
        }
        streamRaf = requestAnimationFrame(() => {
            streamRaf = 0;
            void renderMessages();
        });
    };

    const buildToolCards = (m: ChatMessage): HTMLElement | null => {
        if (!m.tool_calls?.length) {
            return null;
        }
        const wrap = document.createElement("div");
        wrap.className = "agent-tools";
        for (const tc of m.tool_calls) {
            const card = document.createElement("details");
            card.className = "agent-tool-card";
            card.open = false;
            const sum = document.createElement("summary");
            sum.textContent = `🔧 ${tc.function.name}`;
            const pre = document.createElement("pre");
            pre.textContent = tc.function.arguments ?? "{}";
            card.append(sum, pre);
            wrap.appendChild(card);
        }
        return wrap;
    };

    const buildAssistantRow = (): HTMLElement => {
        const wrap = document.createElement("article");
        wrap.className = "agent-msg agent-msg--assistant";
        const head = document.createElement("div");
        head.className = "agent-msg__head";
        head.textContent = "Assistant";
        const thinkWrap = document.createElement("details");
        thinkWrap.className = "agent-msg__think-wrap";
        thinkWrap.open = true;
        const thinkSum = document.createElement("summary");
        thinkSum.textContent = "思考过程";
        const reasoning = document.createElement("div");
        reasoning.className = "agent-msg__reasoning b3-typography b3-typography--default";
        reasoning.hidden = true;
        thinkWrap.append(thinkSum, reasoning);
        const body = document.createElement("div");
        body.className = "agent-msg__body b3-typography b3-typography--default";
        const toolsHost = document.createElement("div");
        toolsHost.className = "agent-msg__tools-host";
        wrap.append(head, thinkWrap, body, toolsHost);
        return wrap;
    };

    const patchAssistantRow = async (row: HTMLElement, m: ChatMessage, lute: import("../../render/lute").LuteEngine) => {
        const reasoningRaw = m.reasoning_content != null && m.reasoning_content !== "" ? String(m.reasoning_content) : "";
        const contentRaw = m.content ?? "";
        const toolsSig = m.tool_calls?.map((t) => t.function.name).join(",") ?? "";
        const streamOpen = abortCtl !== null;
        const prev = (row as unknown as Record<string, AssistantPatch | undefined>)[lastPatchKey];
        if (prev && prev.content === contentRaw && prev.reasoning === reasoningRaw && prev.toolsSig === toolsSig && prev.streamOpen === streamOpen) {
            return;
        }
        (row as unknown as Record<string, AssistantPatch>)[lastPatchKey] = {
            content: contentRaw,
            reasoning: reasoningRaw,
            toolsSig,
            streamOpen,
        };

        const thinkWrap = row.querySelector(".agent-msg__think-wrap") as HTMLDetailsElement | null;
        if (thinkWrap) {
            thinkWrap.hidden = !reasoningRaw;
        }

        const toolsHost = row.querySelector(".agent-msg__tools-host") as HTMLElement;
        toolsHost.replaceChildren();
        const cards = buildToolCards(m);
        if (cards) {
            toolsHost.appendChild(cards);
        }

        await syncAssistantMessageDom(row, m, lute, streamOpen, isDestroyed);
    };

    const buildUserRow = (m: ChatMessage): HTMLElement => {
        const wrap = document.createElement("article");
        wrap.className = "agent-msg agent-msg--user";
        const head = document.createElement("div");
        head.className = "agent-msg__head";
        head.textContent = "你";
        const pre = document.createElement("pre");
        pre.className = "agent-msg__text";
        pre.textContent = m.content ?? "";
        wrap.append(head, pre);
        return wrap;
    };

    const buildToolRow = (m: ChatMessage): HTMLElement => {
        const wrap = document.createElement("article");
        wrap.className = "agent-msg agent-msg--tool";
        const head = document.createElement("div");
        head.className = "agent-msg__head";
        head.textContent = `工具结果 · ${m.tool_call_id ?? ""}`;
        const pre = document.createElement("pre");
        pre.className = "agent-msg__text";
        pre.textContent = (m.content ?? "").slice(0, 4000);
        wrap.append(head, pre);
        return wrap;
    };

    async function renderMessages(): Promise<void> {
        if (destroyed) {
            return;
        }
        const seq = ++renderSeq;
        const msgs = getActiveSession().messages;

        if (!msgs.length) {
            elMessages.innerHTML = `<div class="agent-panel__empty">开始对话，向 Agent 提问或让它编辑笔记。</div>`;
            return;
        }

        const luteRes = getLuteResult();
        if (luteRes.ok === false) {
            elMessages.innerHTML = `<div class="agent-panel__empty">${esc(luteRes.message)}</div>`;
            return;
        }
        const lute = luteRes.lute;

        while (elMessages.lastElementChild && elMessages.children.length > msgs.length) {
            elMessages.removeChild(elMessages.lastElementChild);
        }

        for (let i = 0; i < msgs.length; i++) {
            if (destroyed || seq !== renderSeq) {
                return;
            }
            const m = msgs[i];
            const slot = elMessages.children[i] as HTMLElement | undefined;
            let row = rowByMessage.get(m);

            if (row && slot === row) {
                if (m.role === "assistant") {
                    await patchAssistantRow(row, m, lute);
                } else if (m.role === "user") {
                    const pre = row.querySelector(".agent-msg__text");
                    if (pre) {
                        pre.textContent = m.content ?? "";
                    }
                } else if (m.role === "tool") {
                    const pre = row.querySelector(".agent-msg__text");
                    if (pre) {
                        pre.textContent = (m.content ?? "").slice(0, 4000);
                    }
                }
                continue;
            }

            if (m.role === "assistant") {
                row = buildAssistantRow();
                await patchAssistantRow(row, m, lute);
            } else if (m.role === "user") {
                row = buildUserRow(m);
            } else if (m.role === "tool") {
                row = buildToolRow(m);
            } else {
                row = document.createElement("article");
                row.textContent = m.role;
            }

            rowByMessage.set(m, row);
            if (slot) {
                elMessages.replaceChild(row, slot);
            } else {
                elMessages.appendChild(row);
            }
        }

        if (seq === renderSeq) {
            elMessages.scrollTop = elMessages.scrollHeight;
        }
    }

    const loadModels = async () => {
        const settings = plugin.data[STORAGE_KEY_SETTINGS] as PersistedSettings;
        if (!settings.apiKey) {
            elModel.innerHTML = `<option value="${esc(settings.model)}">${esc(settings.model)}</option>`;
            return;
        }
        try {
            const models = await listDeepSeekModels(settings);
            elModel.innerHTML = "";
            for (const m of models) {
                const opt = document.createElement("option");
                opt.value = m.id;
                opt.textContent = m.id;
                if (m.id === settings.model) {
                    opt.selected = true;
                }
                elModel.appendChild(opt);
            }
            if (!elModel.value && settings.model) {
                const opt = document.createElement("option");
                opt.value = settings.model;
                opt.textContent = settings.model;
                opt.selected = true;
                elModel.appendChild(opt);
            }
        } catch {
            elModel.innerHTML = `<option value="${esc(settings.model)}">${esc(settings.model)}</option>`;
        }
    };

    const runSend = async () => {
        const text = elInput.value.trim();
        if (!text) {
            return;
        }
        const settings = plugin.data[STORAGE_KEY_SETTINGS] as PersistedSettings;
        if (!settings.apiKey) {
            plugin.showPluginMessage("请先在插件设置中填写 DeepSeek API Key");
            return;
        }

        elInput.value = "";
        abortCtl?.abort();
        abortCtl = new AbortController();
        btnSend.disabled = true;
        btnStop.disabled = false;

        const sess = getActiveSession();
        let systemExtra = "";
        if (includeEditorContext) {
            systemExtra = "【当前编辑器上下文】\n" + formatEditorContextForPrompt(captureEditorContext());
        }

        const llm = {
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            model: elModel.value || settings.model,
            thinkingEnabled: chkThinking.checked,
            reasoningEffort: "high" as const,
        };

        try {
            const outcome = await runAgentLoop({
                plugin,
                llm,
                messages: sess.messages,
                userText: text,
                signal: abortCtl.signal,
                onAudit: pushAudit,
                onStreamDelta: scheduleStreamRender,
                systemExtra,
                requestConfirm: confirmPromise,
            });

            sess.updatedAt = new Date().toISOString();
            sess.title = deriveSessionTitle(sess.messages);
            persistSessions();
            refreshSessionSelect();

            if (outcome.kind === "stopped") {
                const r = outcome.reason;
                let detail: string | undefined;
                switch (r.kind) {
                    case "aborted":
                        break;
                    case "no_response_body":
                        detail = "响应无正文";
                        break;
                    case "invalid_response":
                        detail = "模型返回为空";
                        break;
                    case "http_error":
                        detail = `HTTP ${r.status}: ${r.bodySnippet}`;
                        break;
                    case "network_error":
                        detail = r.message;
                        break;
                }
                if (detail) {
                    plugin.showPluginMessage(`Agent：${detail}`);
                    pushAudit({kind: "tool_blocked", name: "assistant", reason: detail});
                }
            } else if (outcome.kind === "unexpected_error") {
                plugin.showPluginMessage(`Agent 异常：${outcome.message}`);
            }
        } finally {
            if (streamRaf) {
                cancelAnimationFrame(streamRaf);
                streamRaf = 0;
            }
            btnSend.disabled = false;
            btnStop.disabled = true;
            abortCtl = null;
            void renderMessages();
        }
    };

    root.querySelector("[data-clear-session]")?.addEventListener("click", () => {
        const sess = getActiveSession();
        for (const m of sess.messages) {
            if (m.role === "assistant") {
                forgetStreamMdCache(m);
            }
        }
        sess.messages.length = 0;
        sess.title = "新对话";
        persistSessions();
        refreshSessionSelect();
        void renderMessages();
    });

    root.querySelector("[data-insert-ctx]")?.addEventListener("click", () => {
        const ctx = captureEditorContext();
        const id = ctx.focusedBlockId ?? ctx.rootId;
        if (!id) {
            plugin.showPluginMessage("当前没有打开的文档");
            return;
        }
        const snippet = ctx.rootTitle ? `${ctx.rootTitle}（${id}）` : id;
        elInput.value = (elInput.value ? `${elInput.value}\n` : "") + `@${snippet} `;
        elInput.focus();
    });

    root.querySelector("[data-new-session]")?.addEventListener("click", () => {
        const s = createSession();
        sessions.sessions.unshift(s);
        sessions.activeId = s.id;
        persistSessions();
        refreshSessionSelect();
        void renderMessages();
    });

    elSessionSelect.addEventListener("change", () => {
        sessions.activeId = elSessionSelect.value;
        persistSessions();
        void renderMessages();
    });

    root.querySelector("[data-open-settings]")?.addEventListener("click", () => {
        plugin.openSetting();
    });

    chkCtx.addEventListener("change", () => {
        includeEditorContext = chkCtx.checked;
    });

    btnSend.addEventListener("click", () => void runSend());
    btnStop.addEventListener("click", () => abortCtl?.abort());
    elInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            void runSend();
        }
    });

    elModel.addEventListener("change", () => {
        const settings = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
        settings.model = elModel.value;
        plugin.data[STORAGE_KEY_SETTINGS] = settings;
        void plugin.saveData(STORAGE_KEY_SETTINGS, settings);
    });

    const settings = plugin.data[STORAGE_KEY_SETTINGS] as PersistedSettings;
    chkThinking.checked = settings.thinkingEnabled !== false;

    refreshSessionSelect();
    void loadModels();
    void renderMessages();

    return () => {
        destroyed = true;
        renderSeq++;
        abortCtl?.abort();
        if (streamRaf) {
            cancelAnimationFrame(streamRaf);
        }
        for (const m of getActiveSession().messages) {
            if (m.role === "assistant") {
                forgetStreamMdCache(m);
            }
        }
        void flushActivity();
    };
}
