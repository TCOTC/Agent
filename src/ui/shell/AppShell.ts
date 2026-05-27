import type Agent from "../../index";
import {runAgentLoop} from "../../agent/agentLoop";
import {AGENT_MODES, type AgentMode} from "../../agent/modes";
import type {AuditEvent, ChatMessage} from "../../agent/types";
import {listDeepSeekModels} from "../../agent/deepseekClient";
import {createFetchSyncKernelExecutor} from "../../agent/kernelExecutor";
import {ActivityLogBuffer} from "../../core/activityLog";
import {STORAGE_KEY_ACTIVITY, STORAGE_KEY_SESSIONS, STORAGE_KEY_TOKEN_STATS} from "../../core/constants";
import {captureEditorContext, formatEditorContextForPrompt} from "../../core/editorContext";
import {agentBus, AgentEvents} from "../../core/eventBus";
import {
    formatTokenBrief,
    mergeUsage,
    parseDeepSeekUsage,
    type TokenStatsPersisted,
    type TokenUsageRecord,
} from "../../core/tokenUsage";
import {getLuteResult} from "../../render/lute";
import {
    createSession,
    deriveSessionTitle,
    filterSessions,
    normalizeSessions,
    sortSessions,
} from "../../session/storage";
import type {ChatSession, SessionsPersisted} from "../../session/types";
import {normalizeSettings, STORAGE_KEY_SETTINGS} from "../../settings/storage";
import type {PersistedSettings} from "../../settings/types";
import {confirmPromise} from "../../util";
import {mountTimelinePanel, parseJsonlLines} from "../activity/TimelinePanel";
import {
    applySlashCommand,
    filterSlashCommands,
    SLASH_COMMANDS,
} from "../chat/slashCommands";
import {
    buildAssistantRow,
    clearAssistantCache,
    ensureMessageRow,
    patchAssistantRow,
    patchAssistantRowPlain,
} from "../chat/messageRenderer";
import {renderMentionMenu, searchMentionHits} from "../chat/mentionPicker";
import {downloadTextFile, sessionToMarkdown} from "../chat/exportSession";
import {preloadAttachmentPreviews} from "../../context/preload";
import {showDiffPreviewModal} from "../diff/DiffModal";

export function mountAppShell(plugin: Agent, root: HTMLElement): () => void {
    let destroyed = false;
    let renderSeq = 0;
    let streamRaf = 0;
    let abortCtl: AbortController | null = null;
    const rowByMessage = new WeakMap<ChatMessage, HTMLElement>();
    const activityBuf = new ActivityLogBuffer();
    const kernel = createFetchSyncKernelExecutor();

    let sessions: SessionsPersisted = normalizeSessions(plugin.data[STORAGE_KEY_SESSIONS]);
    let sessionFilter = "";
    let activeTab: "chat" | "activity" = "chat";

    const getActive = (): ChatSession => {
        return sessions.sessions.find((s) => s.id === sessions.activeId) ?? sessions.sessions[0];
    };

    root.innerHTML = `<div class="agent-shell fn__flex">
  <aside class="agent-rail fn__flex-column" data-rail>
    <div class="agent-rail__head fn__flex">
      <span class="agent-rail__title">对话</span>
      <button type="button" class="b3-button b3-button--text" data-new-session title="新对话">+</button>
    </div>
    <input class="b3-text-field agent-rail__search" data-session-search placeholder="搜索对话…" />
    <div class="agent-rail__list fn__flex-1" data-session-list></div>
  </aside>
  <div class="agent-main fn__flex-column fn__flex-1">
    <header class="agent-main__header fn__flex">
      <div class="agent-tabs fn__flex">
        <button type="button" class="agent-tabs__btn agent-tabs__btn--active" data-tab="chat">聊天</button>
        <button type="button" class="agent-tabs__btn" data-tab="activity">运行</button>
      </div>
      <select class="b3-select agent-main__mode" data-mode></select>
      <button type="button" class="b3-button b3-button--text" data-regenerate title="重新生成">↻</button>
      <button type="button" class="b3-button b3-button--text" data-export-session title="导出对话">↓</button>
      <button type="button" class="b3-button b3-button--text" data-pin-session title="置顶">📌</button>
      <button type="button" class="b3-button b3-button--text" data-open-settings title="设置">⚙</button>
    </header>
    <div class="agent-main__ctx fn__flex" data-ctx-chips></div>
    <div class="agent-main__body fn__flex-1" data-tab-chat>
      <div class="agent-messages fn__flex-1" data-messages></div>
    </div>
    <div class="agent-main__body fn__flex-1 fn__none" data-tab-activity>
      <div class="agent-timeline fn__flex-1" data-timeline></div>
    </div>
    <footer class="agent-main__footer">
      <span data-token-stats>Token —</span>
    </footer>
    <div class="agent-composer fn__flex-column">
      <div class="agent-composer__attach fn__flex" data-attach-bar>
        <label class="agent-chip"><input type="checkbox" data-include-ctx checked /><span>当前文档</span></label>
        <button type="button" class="agent-chip agent-chip--btn" data-add-doc>@ 附加文档</button>
      </div>
      <div class="agent-composer__input-wrap">
        <textarea class="b3-text-field agent-composer__input" rows="2" data-input placeholder="输入消息 · / 命令 · @ 引用块 · Ctrl+Enter 发送"></textarea>
        <div class="agent-composer__menu fn__none" data-slash-menu></div>
        <div class="agent-composer__menu fn__none" data-mention-menu></div>
      </div>
      <div class="agent-composer__bar fn__flex">
        <select class="b3-select agent-composer__model" data-model></select>
        <label class="agent-composer__think"><input type="checkbox" data-thinking checked /><span>思考</span></label>
        <span class="fn__flex-1"></span>
        <button type="button" class="b3-button b3-button--text" data-send>发送</button>
        <button type="button" class="b3-button b3-button--cancel" data-stop disabled>停止</button>
      </div>
    </div>
  </div>
</div>`;

    const elMessages = root.querySelector("[data-messages]") as HTMLElement;
    const elTimeline = root.querySelector("[data-timeline]") as HTMLElement;
    const elSessionList = root.querySelector("[data-session-list]") as HTMLElement;
    const elInput = root.querySelector("[data-input]") as HTMLTextAreaElement;
    const elModel = root.querySelector("[data-model]") as HTMLSelectElement;
    const elMode = root.querySelector("[data-mode]") as HTMLSelectElement;
    const elToken = root.querySelector("[data-token-stats]") as HTMLElement;
    const elCtxChips = root.querySelector("[data-ctx-chips]") as HTMLElement;
    const elSlashMenu = root.querySelector("[data-slash-menu]") as HTMLElement;
    const elMentionMenu = root.querySelector("[data-mention-menu]") as HTMLElement;
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
        await plugin.saveData(STORAGE_KEY_ACTIVITY, merged.split("\n").slice(-8000).join("\n"));
    };

    const pushAudit = (e: AuditEvent) => {
        activityBuf.push(e);
        if (e.kind === "llm_response" && e.usage) {
            const u = parseDeepSeekUsage(e.usage);
            if (u) {
                const s = getActive();
                s.tokenUsage = mergeUsage(s.tokenUsage, u);
                updateTokenDisplay();
                void persistTokenStats(u);
            }
        }
        if (activeTab === "activity") {
            void refreshTimeline();
        }
        void flushActivity();
    };

    const persistTokenStats = async (delta: TokenUsageRecord) => {
        const raw = (await plugin.loadData(STORAGE_KEY_TOKEN_STATS)) as TokenStatsPersisted | null;
        const base: TokenStatsPersisted = raw?.lifetime
            ? raw
            : {lifetime: {promptTokens: 0, completionTokens: 0, totalTokens: 0}, sessions: {}, lastUpdated: ""};
        base.lifetime = mergeUsage(base.lifetime, delta);
        base.sessions[sessions.activeId] = mergeUsage(
            base.sessions[sessions.activeId] ?? {promptTokens: 0, completionTokens: 0, totalTokens: 0},
            delta,
        );
        base.lastUpdated = new Date().toISOString();
        await plugin.saveData(STORAGE_KEY_TOKEN_STATS, base);
    };

    const updateTokenDisplay = () => {
        elToken.textContent = `Token · ${formatTokenBrief(getActive().tokenUsage)}`;
    };

    const renderSessionList = () => {
        elSessionList.innerHTML = "";
        const list = sortSessions(filterSessions(sessions.sessions, sessionFilter));
        for (const s of list) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "agent-rail__item" + (s.id === sessions.activeId ? " agent-rail__item--active" : "");
            btn.dataset.id = s.id;
            btn.innerHTML = `<span class="agent-rail__item-title fn__ellipsis">${s.pinned ? "📌 " : ""}${esc(s.title)}</span>
<span class="agent-rail__item-meta">${AGENT_MODES.find((m) => m.id === s.mode)?.label ?? "Agent"}</span>`;
            btn.addEventListener("click", () => {
                sessions.activeId = s.id;
                persistSessions();
                renderSessionList();
                renderCtxChips();
                void renderMessages();
                updateTokenDisplay();
            });
            btn.addEventListener("contextmenu", (ev) => {
                ev.preventDefault();
                if (confirm("删除此对话？")) {
                    sessions.sessions = sessions.sessions.filter((x) => x.id !== s.id);
                    if (!sessions.sessions.length) {
                        const n = createSession();
                        sessions.sessions.push(n);
                        sessions.activeId = n.id;
                    } else if (sessions.activeId === s.id) {
                        sessions.activeId = sessions.sessions[0].id;
                    }
                    persistSessions();
                    renderSessionList();
                    void renderMessages();
                }
            });
            elSessionList.appendChild(btn);
        }
    };

    const renderCtxChips = () => {
        const s = getActive();
        elCtxChips.replaceChildren();
        for (const a of s.contextAttachments) {
            const chip = document.createElement("span");
            chip.className = "agent-ctx-chip";
            chip.innerHTML = `${esc(a.label)} <button type="button" data-rm="${a.id}">×</button>`;
            chip.querySelector("button")?.addEventListener("click", () => {
                s.contextAttachments = s.contextAttachments.filter((x) => x.id !== a.id);
                persistSessions();
                renderCtxChips();
            });
            elCtxChips.appendChild(chip);
        }
    };

    const scheduleStreamRender = () => {
        if (destroyed) {
            return;
        }
        if (streamRaf) {
            cancelAnimationFrame(streamRaf);
        }
        streamRaf = requestAnimationFrame(() => {
            streamRaf = 0;
            void renderMessages();
        });
    };

    function clearMessagesEmptyState(): void {
        elMessages.querySelector(".agent-empty")?.remove();
    }

    async function renderMessages(): Promise<void> {
        if (destroyed) {
            return;
        }
        const seq = ++renderSeq;
        const msgs = getActive().messages;

        if (!msgs.length) {
            elMessages.innerHTML = `<div class="agent-empty">
<h3>Agent 已就绪</h3>
<p>问答 · 多步工具 · 文档 Diff 编辑</p>
<ul>
<li><kbd>/doc</kbd> 读取当前文档</li>
<li><kbd>@</kbd> 搜索并引用块</li>
<li>切换模式：问答 / Agent / 编辑</li>
</ul>
</div>`;
            return;
        }

        clearMessagesEmptyState();

        const luteRes = getLuteResult();
        const lute = luteRes.ok ? luteRes.lute : null;

        while (elMessages.children.length > msgs.length) {
            elMessages.removeChild(elMessages.lastElementChild!);
        }

        for (let i = 0; i < msgs.length; i++) {
            if (destroyed) {
                return;
            }
            const m = msgs[i];
            const slot = elMessages.children[i] as HTMLElement | undefined;
            const row = ensureMessageRow(elMessages, m, rowByMessage, slot);

            if (seq !== renderSeq) {
                // 新一轮渲染已开始；当前行已在 DOM 中，交给新轮次继续 patch
                continue;
            }

            if (m.role === "user") {
                const pre = row.querySelector(".agent-msg__text");
                if (pre) {
                    pre.textContent = m.content ?? "";
                }
            } else if (m.role === "tool") {
                const pre = row.querySelector(".agent-msg__text");
                if (pre) {
                    pre.textContent = (m.content ?? "").slice(0, 3000);
                }
            } else if (m.role === "assistant") {
                if (lute) {
                    try {
                        await patchAssistantRow(row, m, lute, abortCtl !== null, isDestroyed);
                    } catch {
                        patchAssistantRowPlain(row, m);
                    }
                } else {
                    patchAssistantRowPlain(row, m);
                }
            }

            if (destroyed || seq !== renderSeq) {
                return;
            }
        }

        if (seq === renderSeq) {
            elMessages.scrollTop = elMessages.scrollHeight;
        }
    }

    async function refreshTimeline(): Promise<void> {
        const raw = (await plugin.loadData(STORAGE_KEY_ACTIVITY)) as string | null;
        const recent = [...activityBuf.peekRecent(100)];
        const fromFile = raw ? parseJsonlLines(raw).slice(-200) : [];
        mountTimelinePanel(elTimeline, [...fromFile, ...recent.map((l) => {
            try {
                const o = JSON.parse(l) as {ts?: string; event?: AuditEvent};
                if (o.event) {
                    return `${o.ts ? new Date(o.ts).toLocaleTimeString() : ""} ${o.event.kind}`;
                }
            } catch { /* */ }
            return l;
        })]);
    }

    const loadModels = async () => {
        const settings = plugin.data[STORAGE_KEY_SETTINGS] as PersistedSettings;
        if (!settings.apiKey) {
            elModel.innerHTML = `<option>${esc(settings.model)}</option>`;
            return;
        }
        try {
            const models = await listDeepSeekModels(settings);
            elModel.innerHTML = models.map((m) =>
                `<option value="${esc(m.id)}"${m.id === settings.model ? " selected" : ""}>${esc(m.id)}</option>`,
            ).join("");
        } catch {
            elModel.innerHTML = `<option>${esc(settings.model)}</option>`;
        }
    };

    const initModes = () => {
        elMode.innerHTML = AGENT_MODES.map((m) =>
            `<option value="${m.id}">${m.label} — ${m.description}</option>`,
        ).join("");
        elMode.value = getActive().mode;
    };

    const runSend = async () => {
        let text = elInput.value.trim();
        if (!text) {
            return;
        }
        const settings = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
        if (!settings.apiKey) {
            plugin.showPluginMessage("请先配置 DeepSeek API Key");
            return;
        }
        elInput.value = "";
        hideMenus();

        const sess = getActive();
        let editorCtx = "";
        if (sess.includeEditorContext) {
            editorCtx = formatEditorContextForPrompt(captureEditorContext());
        }
        const attachments = await preloadAttachmentPreviews(kernel, sess.contextAttachments);

        abortCtl?.abort();
        abortCtl = new AbortController();
        btnSend.disabled = true;
        btnStop.disabled = false;

        try {
            const outcome = await runAgentLoop({
                plugin,
                mode: sess.mode,
                llm: {
                    baseUrl: settings.baseUrl,
                    apiKey: settings.apiKey,
                    model: elModel.value || settings.model,
                    thinkingEnabled: chkThinking.checked,
                },
                messages: sess.messages,
                userText: text,
                signal: abortCtl.signal,
                onAudit: pushAudit,
                onStreamDelta: scheduleStreamRender,
                onMessagesChanged: scheduleStreamRender,
                customInstructions: [settings.customInstructions, sess.customInstructions].filter(Boolean).join("\n"),
                editorContext: editorCtx,
                attachments,
                worksetNotebookIds: settings.worksetNotebookIds,
                riskAutoApproveMax: settings.riskAutoApproveMax,
                requestConfirm: confirmPromise,
                showDiffPreview: showDiffPreviewModal,
            });
            sess.updatedAt = new Date().toISOString();
            sess.title = deriveSessionTitle(sess.messages);
            persistSessions();
            renderSessionList();
            if (outcome.kind === "stopped") {
                const r = outcome.reason;
                if (r.kind !== "aborted") {
                    const detail = r.kind === "http_error" ? `HTTP ${r.status}` : r.kind;
                    plugin.showPluginMessage(`Agent 中断：${detail}`);
                }
            } else if (outcome.kind === "unexpected_error") {
                plugin.showPluginMessage(outcome.message);
            }
        } finally {
            btnSend.disabled = false;
            btnStop.disabled = true;
            abortCtl = null;
            void renderMessages();
        }
    };

    function hideMenus(): void {
        elSlashMenu.classList.add("fn__none");
        elMentionMenu.classList.add("fn__none");
    }

    function esc(s: string): string {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // Events
    root.querySelector("[data-new-session]")?.addEventListener("click", () => {
        const settings = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
        const s = createSession("新对话", settings.defaultMode);
        sessions.sessions.unshift(s);
        sessions.activeId = s.id;
        persistSessions();
        renderSessionList();
        initModes();
        void renderMessages();
    });

    root.querySelector("[data-regenerate]")?.addEventListener("click", () => {
        if (abortCtl) {
            return;
        }
        const s = getActive();
        while (s.messages.length && s.messages[s.messages.length - 1].role !== "user") {
            const m = s.messages.pop()!;
            clearAssistantCache(m);
        }
        const lastUser = s.messages[s.messages.length - 1];
        if (!lastUser?.content) {
            plugin.showPluginMessage("没有可重新生成的消息");
            return;
        }
        elInput.value = lastUser.content;
        s.messages.pop();
        persistSessions();
        void renderMessages();
        void runSend();
    });

    root.querySelector("[data-export-session]")?.addEventListener("click", () => {
        const s = getActive();
        downloadTextFile(`${s.title.replace(/[/\\?%*:|"<>]/g, "_")}.md`, sessionToMarkdown(s));
    });

    root.querySelector("[data-pin-session]")?.addEventListener("click", () => {
        const s = getActive();
        s.pinned = !s.pinned;
        persistSessions();
        renderSessionList();
    });

    root.querySelector("[data-open-settings]")?.addEventListener("click", () => plugin.openSetting());

    root.querySelector("[data-session-search]")?.addEventListener("input", (e) => {
        sessionFilter = (e.target as HTMLInputElement).value;
        renderSessionList();
    });

    root.querySelectorAll("[data-tab]").forEach((btn) => {
        btn.addEventListener("click", () => {
            activeTab = (btn as HTMLElement).dataset.tab as "chat" | "activity";
            root.querySelectorAll(".agent-tabs__btn").forEach((b) => b.classList.remove("agent-tabs__btn--active"));
            btn.classList.add("agent-tabs__btn--active");
            root.querySelector("[data-tab-chat]")!.classList.toggle("fn__none", activeTab !== "chat");
            root.querySelector("[data-tab-activity]")!.classList.toggle("fn__none", activeTab !== "activity");
            if (activeTab === "activity") {
                void refreshTimeline();
            }
        });
    });

    elMode.addEventListener("change", () => {
        getActive().mode = elMode.value as AgentMode;
        persistSessions();
    });

    chkCtx.addEventListener("change", () => {
        getActive().includeEditorContext = chkCtx.checked;
        persistSessions();
    });

    root.querySelector("[data-add-doc]")?.addEventListener("click", () => {
        const ctx = captureEditorContext();
        if (!ctx.rootId) {
            plugin.showPluginMessage("无当前文档");
            return;
        }
        const s = getActive();
        if (!s.contextAttachments.some((a) => a.id === ctx.rootId)) {
            s.contextAttachments.push({
                id: ctx.rootId,
                kind: "document",
                label: ctx.rootTitle ?? ctx.rootId,
                addedAt: new Date().toISOString(),
            });
            persistSessions();
            renderCtxChips();
        }
    });

    elInput.addEventListener("input", () => {
        const v = elInput.value;
        const slash = filterSlashCommands(v);
        if (slash.length) {
            elSlashMenu.classList.remove("fn__none");
            elSlashMenu.innerHTML = slash.map((c) =>
                `<button type="button" class="agent-menu-item" data-slash="${c.id}"><strong>${c.label}</strong> ${c.hint}</button>`,
            ).join("");
        } else {
            elSlashMenu.classList.add("fn__none");
        }
        const at = v.match(/@([\w\u4e00-\u9fa5]{1,20})$/);
        if (at) {
            void searchMentionHits(kernel, at[1]).then((hits) => {
                elMentionMenu.classList.remove("fn__none");
                elMentionMenu.replaceChildren(renderMentionMenu(hits));
                elMentionMenu.querySelectorAll("[data-id]").forEach((btn) => {
                    btn.addEventListener("click", () => {
                        const id = (btn as HTMLElement).dataset.id!;
                        const label = btn.querySelector(".agent-mention-menu__label")?.textContent ?? id;
                        elInput.value = v.replace(/@[\w\u4e00-\u9fa5]{1,20}$/, `@${label}(${id}) `);
                        const s = getActive();
                        s.contextAttachments.push({id, kind: "block", label, addedAt: new Date().toISOString()});
                        persistSessions();
                        renderCtxChips();
                        hideMenus();
                    });
                });
            });
        } else {
            elMentionMenu.classList.add("fn__none");
        }
    });

    elSlashMenu.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("[data-slash]") as HTMLElement | null;
        if (!btn) {
            return;
        }
        const cmd = SLASH_COMMANDS.find((c) => c.id === btn.dataset.slash);
        if (!cmd) {
            return;
        }
        if (cmd.id === "clear") {
            const s = getActive();
            for (const m of s.messages) {
                clearAssistantCache(m);
            }
            s.messages.length = 0;
            persistSessions();
            void renderMessages();
            elInput.value = "";
        } else {
            elInput.value = applySlashCommand(cmd, elInput.value);
        }
        hideMenus();
    });

    btnSend.addEventListener("click", () => void runSend());
    btnStop.addEventListener("click", () => abortCtl?.abort());
    elInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            void runSend();
        }
        if (ev.key === "Escape") {
            hideMenus();
        }
    });

    elModel.addEventListener("change", () => {
        const s = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
        s.model = elModel.value;
        plugin.data[STORAGE_KEY_SETTINGS] = s;
        void plugin.saveData(STORAGE_KEY_SETTINGS, s);
    });

    agentBus.on(AgentEvents.MESSAGES_RENDER, () => scheduleStreamRender());
    agentBus.on(AgentEvents.STREAM_DELTA, () => scheduleStreamRender());

    const settings = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
    chkThinking.checked = settings.thinkingEnabled !== false;
    getActive().includeEditorContext = getActive().includeEditorContext ?? true;
    chkCtx.checked = getActive().includeEditorContext;

    initModes();
    renderSessionList();
    renderCtxChips();
    updateTokenDisplay();
    void loadModels();
    void renderMessages();

    return () => {
        destroyed = true;
        abortCtl?.abort();
        agentBus.clear();
        void flushActivity();
    };
}
