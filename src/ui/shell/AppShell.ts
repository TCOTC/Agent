import type Agent from "../../index";
import {getActiveAgentSession, runAgentLoop} from "../../agent/agentLoop";
import {syncChatMessagesFromAgent} from "../../agent/messageSync";
import {AGENT_MODES, type AgentMode} from "../../agent/modes";
import type {AuditEvent, ChatMessage, ToolDiffPreviewInfo} from "../../agent/types";
import {listDeepSeekModels} from "../../agent/deepseekClient";
import {createFetchSyncKernelExecutor} from "../../agent/kernelExecutor";
import {ActivityLogBuffer} from "../../core/activityLog";
import {STORAGE_KEY_ACTIVITY, STORAGE_KEY_SESSIONS, STORAGE_KEY_TOKEN_STATS} from "../../core/constants";
import {captureEditorContext, formatEditorContextForPrompt} from "../../core/editorContext";
import {agentBus, AgentEvents} from "../../core/eventBus";
import {
    formatTokenBrief,
    getModelContextLimit,
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
import {mountTimelinePanel, parseJsonlLines} from "../activity/TimelinePanel";
import {
    applySlashCommand,
    filterSlashCommands,
    SLASH_COMMANDS,
} from "../chat/slashCommands";
import {
    bindAssistantConfirmNotify,
    clearAssistantCache,
    ensureMessageRow,
    patchAssistantRow,
    patchAssistantRowPlain,
    patchAssistantToolCallsOnly,
    patchAssistantTooling,
} from "../chat/messageRenderer";
import {clearConfirmNotifications} from "../chat/toolConfirmBanner";
import {
    isSiYuanDesktopClient,
    isWindowNotVisibleToUser,
    isWindowVisibilityDebugEnabled,
    logWindowVisibilityDiagnostics,
    sendSiYuanDesktopNotification,
} from "../notify/desktopNotify";
import {renderMentionMenu, searchMentionHits} from "../chat/mentionPicker";
import {downloadTextFile, sessionToMarkdown} from "../chat/exportSession";
import {preloadAttachmentPreviews} from "../../context/preload";
import {
    bindInlineToolActionHandlers,
    cancelPendingInlineActions,
    createInlineDiffPreview,
    createInlineToolConfirm,
    findLatestAssistantMessage,
} from "../chat/inlineToolActions";
const shellCleanups = new WeakMap<HTMLElement, () => void>();

export function mountAppShell(plugin: Agent, root: HTMLElement): () => void {
    shellCleanups.get(root)?.();
    const mountedAt = Date.now();
    let destroyed = false;
    let renderSeq = 0;
    let streamRaf = 0;
    let abortCtl: AbortController | null = null;
    let regenerateAfterAbort = false;
    let railExpanded = false;
    const rowByMessage = new WeakMap<ChatMessage, HTMLElement>();
    const activityBuf = new ActivityLogBuffer();
    const kernel = createFetchSyncKernelExecutor();

    const sessions: SessionsPersisted = normalizeSessions(plugin.data[STORAGE_KEY_SESSIONS]);
    let sessionFilter = "";
    let activeTab: "chat" | "activity" = "chat";

    const getActive = (): ChatSession => {
        return sessions.sessions.find((s) => s.id === sessions.activeId) ?? sessions.sessions[0];
    };

    root.innerHTML = `<div class="agent-shell fn__flex">
  <div class="agent-main fn__flex-column fn__flex-1">
    <header class="agent-header fn__flex">
      <div class="agent-header__start fn__flex">
        <h2 class="agent-header__title fn__ellipsis" data-session-title>对话</h2>
        <nav class="agent-tabs fn__flex" aria-label="主视图">
          <button type="button" class="agent-tabs__btn agent-tabs__btn--active" data-tab="chat">聊天</button>
          <button type="button" class="agent-tabs__btn" data-tab="activity">运行</button>
        </nav>
      </div>
      <div class="agent-header__actions fn__flex">
        <button type="button" class="agent-icon-btn" data-new-session title="新对话 (Ctrl+N)" aria-label="新对话">+</button>
        <button type="button" class="agent-icon-btn" data-rail-history title="对话历史" aria-label="对话历史">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5H8V1.5zm0 2.2v4.3h4.1A4.3 4.3 0 0 1 8 3.7z"/></svg>
        </button>
        <button type="button" class="agent-icon-btn" data-regenerate title="重新生成" aria-label="重新生成">↻</button>
        <button type="button" class="agent-icon-btn" data-export-session title="导出对话" aria-label="导出对话">↓</button>
        <button type="button" class="agent-icon-btn" data-pin-session title="置顶" aria-label="置顶">📌</button>
        <button type="button" class="agent-icon-btn" data-open-settings title="设置" aria-label="设置">⚙</button>
        <button type="button" class="agent-icon-btn" data-toggle-rail title="会话列表" aria-label="会话列表" aria-expanded="false">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 3.5h12v1.2H2V3.5zm0 4.1h12v1.2H2V7.6zm0 4.1h8v1.2H2v-1.2z"/></svg>
        </button>
      </div>
    </header>
    <div class="agent-main__ctx fn__flex" data-ctx-chips></div>
    <div class="agent-main__body fn__flex-1" data-tab-chat>
      <div class="agent-messages" data-messages></div>
    </div>
    <div class="agent-main__body fn__flex-1 fn__none" data-tab-activity>
      <div class="agent-timeline" data-timeline></div>
    </div>
    <div class="agent-composer">
      <div class="agent-composer__toolbar fn__flex">
        <div class="agent-mode-picker fn__flex" data-mode-picker role="group" aria-label="模式"></div>
        <select class="agent-select agent-composer__model" data-model aria-label="模型"></select>
      </div>
      <div class="agent-composer__attach fn__flex" data-attach-bar>
        <label class="agent-chip"><input type="checkbox" data-include-ctx checked /><span>当前文档</span></label>
        <button type="button" class="agent-chip agent-chip--btn" data-add-doc>@ 附加文档</button>
      </div>
      <div class="agent-composer__input-wrap">
        <textarea class="agent-input agent-composer__input" rows="3" data-input placeholder="Plan, @ for context, / for commands"></textarea>
        <div class="agent-composer__menu fn__none" data-slash-menu></div>
        <div class="agent-composer__menu fn__none" data-mention-menu></div>
      </div>
      <div class="agent-composer__bar fn__flex">
        <div class="agent-context-wrap">
          <button type="button" class="agent-context-ring" data-context-ring title="上下文占用" aria-label="上下文占用" aria-expanded="false">
            <svg class="agent-context-ring__svg" viewBox="0 0 36 36" aria-hidden="true">
              <circle class="agent-context-ring__track" cx="18" cy="18" r="15.5" fill="none"/>
              <circle class="agent-context-ring__fill" cx="18" cy="18" r="15.5" fill="none" data-ring-fill/>
            </svg>
            <span class="agent-context-ring__pct" data-ring-pct>0</span>
          </button>
          <div class="agent-context-tray fn__none" data-context-tray role="tooltip" aria-label="上下文明细"></div>
        </div>
        <label class="agent-composer__think"><input type="checkbox" data-thinking checked /><span>思考</span></label>
        <span class="fn__flex-1"></span>
        <button type="button" class="agent-btn agent-btn--ghost" data-send>发送</button>
        <button type="button" class="agent-btn agent-btn--stop" data-stop disabled>停止</button>
      </div>
    </div>
  </div>
  <aside class="agent-rail agent-rail--collapsed fn__flex-column" data-rail aria-label="会话列表">
    <div class="agent-rail__head fn__flex">
      <span class="agent-rail__title">对话</span>
      <button type="button" class="agent-icon-btn agent-icon-btn--sm" data-new-session-rail title="新对话" aria-label="新对话">+</button>
      <button type="button" class="agent-icon-btn agent-icon-btn--sm" data-toggle-rail-close title="收起" aria-label="收起">×</button>
    </div>
    <input class="agent-input agent-rail__search" data-session-search placeholder="搜索对话…" />
    <div class="agent-rail__list fn__flex-1" data-session-list></div>
  </aside>
</div>`;

    const elRail = root.querySelector("[data-rail]") as HTMLElement;
    const elMessages = root.querySelector("[data-messages]") as HTMLElement;
    const elChatBody = root.querySelector("[data-tab-chat]") as HTMLElement;
    const elTimeline = root.querySelector("[data-timeline]") as HTMLElement;
    const elSessionList = root.querySelector("[data-session-list]") as HTMLElement;
    const elSessionTitle = root.querySelector("[data-session-title]") as HTMLElement;
    const elSessionSearch = root.querySelector("[data-session-search]") as HTMLInputElement;
    const elInput = root.querySelector("[data-input]") as HTMLTextAreaElement;
    const elModel = root.querySelector("[data-model]") as HTMLSelectElement;
    const elModePicker = root.querySelector("[data-mode-picker]") as HTMLElement;
    const elCtxChips = root.querySelector("[data-ctx-chips]") as HTMLElement;
    const elRingFill = root.querySelector("[data-ring-fill]") as SVGCircleElement;
    const elRingPct = root.querySelector("[data-ring-pct]") as HTMLElement;
    const elContextTray = root.querySelector("[data-context-tray]") as HTMLElement;
    const elSlashMenu = root.querySelector("[data-slash-menu]") as HTMLElement;
    const elMentionMenu = root.querySelector("[data-mention-menu]") as HTMLElement;
    const btnSend = root.querySelector("[data-send]") as HTMLButtonElement;
    const btnStop = root.querySelector("[data-stop]") as HTMLButtonElement;
    const btnToggleRail = root.querySelector("[data-toggle-rail]") as HTMLButtonElement;
    const chkThinking = root.querySelector("[data-thinking]") as HTMLInputElement;
    const chkCtx = root.querySelector("[data-include-ctx]") as HTMLInputElement;

    const RING_CIRC = 2 * Math.PI * 15.5;

    const isDestroyed = () => destroyed;

    const persistSessions = () => {
        plugin.data[STORAGE_KEY_SESSIONS] = sessions;
        void plugin.saveData(STORAGE_KEY_SESSIONS, sessions);
    };

    const setRailExpanded = (expanded: boolean, focusSearch = false) => {
        railExpanded = expanded;
        elRail.classList.toggle("agent-rail--collapsed", !expanded);
        btnToggleRail.setAttribute("aria-expanded", String(expanded));
        if (expanded && focusSearch) {
            elSessionSearch.focus();
            elSessionSearch.select();
        }
    };

    const updateSessionTitle = () => {
        const s = getActive();
        elSessionTitle.textContent = s.title || "新对话";
        elSessionTitle.title = s.title;
    };

    const estimateMessageTokens = (msgs: ChatMessage[]): number => {
        let chars = 0;
        for (const m of msgs) {
            if (m.role === "tool") {
                continue;
            }
            if (typeof m.content === "string") {
                chars += m.content.length;
            }
            if (m.reasoning_content) {
                chars += m.reasoning_content.length;
            }
            if (m._toolResults) {
                for (const t of Object.values(m._toolResults)) {
                    if (typeof t === "string") {
                        chars += t.length;
                    }
                }
            }
        }
        return chars > 0 ? Math.max(1, Math.ceil(chars / 3)) : 0;
    };

    const updateContextRing = () => {
        const s = getActive();
        const u = s.tokenUsage;
        const settings = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
        const model = elModel.value || settings.model;
        const contextLimit = getModelContextLimit(model, settings.modelContextLimits);
        const contextTokens = s.lastContextTokens
            ?? (u.promptTokens > 0 ? u.promptTokens : estimateMessageTokens(s.messages));
        const hasApiContext = (s.lastContextTokens ?? 0) > 0;
        let pct = Math.min(100, Math.round((contextTokens / contextLimit) * 100));
        if (contextTokens > 0 && pct === 0) {
            pct = 1;
        }
        const offset = RING_CIRC * (1 - pct / 100);
        elRingFill.style.strokeDasharray = `${RING_CIRC}`;
        elRingFill.style.strokeDashoffset = String(offset);
        elRingPct.textContent = pct >= 100 ? "满" : String(pct);
        const contextSource = hasApiContext ? "API" : contextTokens > 0 ? "估算" : "—";
        elContextTray.innerHTML = `
<ul class="agent-context-tray__list">
<li><span>占用</span><span>${contextTokens.toLocaleString()} / ${contextLimit.toLocaleString()}（${pct}%）</span></li>
<li><span>本轮</span><span>${contextSource}</span></li>
<li><span>累计</span><span>${formatTokenBrief(u)}</span></li>
</ul>
<p class="agent-context-tray__note">用量来自 API；窗口上限见插件设置。</p>`;
    };

    const renderModePicker = () => {
        const mode = getActive().mode;
        elModePicker.innerHTML = AGENT_MODES.map((m) =>
            `<button type="button" class="agent-mode-picker__btn${m.id === mode ? " agent-mode-picker__btn--active" : ""}"
              data-mode-id="${m.id}" title="${esc(m.description)}">${m.label}</button>`,
        ).join("");
    };

    elModePicker.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("[data-mode-id]") as HTMLElement | null;
        if (!btn) {
            return;
        }
        const id = btn.dataset.modeId as AgentMode;
        getActive().mode = id;
        persistSessions();
        renderModePicker();
        renderSessionList();
    });

    const cycleMode = (dir: 1 | -1) => {
        const idx = AGENT_MODES.findIndex((m) => m.id === getActive().mode);
        const next = AGENT_MODES[(idx + dir + AGENT_MODES.length) % AGENT_MODES.length];
        getActive().mode = next.id;
        persistSessions();
        renderModePicker();
        renderSessionList();
    };

    const cycleModel = () => {
        const opts = Array.from(elModel.options);
        if (opts.length < 2) {
            return;
        }
        const i = elModel.selectedIndex;
        elModel.selectedIndex = (i + 1) % opts.length;
        elModel.dispatchEvent(new Event("change"));
    };

    let activityFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushActivity = async () => {
        const chunk = activityBuf.drain();
        if (!chunk) {
            return;
        }
        const prev = (await plugin.loadData(STORAGE_KEY_ACTIVITY)) as string | null;
        const merged = prev ? `${prev}\n${chunk}` : chunk;
        await plugin.saveData(STORAGE_KEY_ACTIVITY, merged.split("\n").slice(-8000).join("\n"));
    };

    const scheduleActivityFlush = () => {
        if (activityFlushTimer !== null) {
            return;
        }
        activityFlushTimer = setTimeout(() => {
            activityFlushTimer = null;
            void flushActivity();
        }, 5000);
    };

    const pushAudit = (e: AuditEvent) => {
        activityBuf.push(e);
        if (e.kind === "llm_response" && e.usage) {
            const u = parseDeepSeekUsage(e.usage);
            if (u) {
                const s = getActive();
                s.tokenUsage = mergeUsage(s.tokenUsage, u);
                if (u.promptTokens > 0) {
                    s.lastContextTokens = u.promptTokens;
                }
                updateContextRing();
                persistSessions();
                void persistTokenStats(u);
            }
        }
        if (activeTab === "activity") {
            void refreshTimeline();
        }
        scheduleActivityFlush();
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

    const renderSessionList = () => {
        elSessionList.innerHTML = "";
        const list = sortSessions(filterSessions(sessions.sessions, sessionFilter));
        for (const s of list) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "agent-rail__item" + (s.id === sessions.activeId ? " agent-rail__item--active" : "");
            btn.dataset.id = s.id;
            const titleHtml = highlightFilter(esc(s.title), sessionFilter);
            btn.innerHTML = `<span class="agent-rail__item-title fn__ellipsis">${s.pinned ? "📌 " : ""}${titleHtml}</span>
<span class="agent-rail__item-meta">${AGENT_MODES.find((m) => m.id === s.mode)?.label ?? "Agent"}</span>`;
            btn.addEventListener("click", () => {
                sessions.activeId = s.id;
                persistSessions();
                renderSessionList();
                renderCtxChips();
                renderModePicker();
                updateSessionTitle();
                void renderMessages();
                updateContextRing();
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
                    updateSessionTitle();
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
            const msgs = getActive().messages;
            const visibleMsgs = msgs.filter((m) => m.role !== "tool");
            const tail = visibleMsgs[visibleMsgs.length - 1];
            const streamingActive = abortCtl !== null;
            const toolArgsComposing = tail?._streaming &&
                !!tail.tool_calls?.length &&
                !(tail._toolStatus && Object.keys(tail._toolStatus).length > 0);
            if (
                streamingActive &&
                tail?.role === "assistant" &&
                toolArgsComposing &&
                !tail._mdStreaming
            ) {
                for (let i = 0; i < visibleMsgs.length; i++) {
                    const m = visibleMsgs[i];
                    if (m.role !== "assistant" || !m.tool_calls?.length) {
                        continue;
                    }
                    const slot = elMessages.children[i] as HTMLElement | undefined;
                    const row = ensureMessageRow(elMessages, m, rowByMessage, slot);
                    patchAssistantToolCallsOnly(row, m);
                }
                const dist = elChatBody.scrollHeight - elChatBody.scrollTop - elChatBody.clientHeight;
                if (dist < 120) {
                    elChatBody.scrollTop = elChatBody.scrollHeight;
                }
                return;
            }
            void renderMessages();
        });
    };

    const refreshInlineActionUi = () => {
        const session = getActiveAgentSession();
        if (session) {
            syncChatMessagesFromAgent(
                getActive().messages,
                session.agent.state.messages,
                session.agent.state.streamingMessage,
            );
        }
        scheduleStreamRender();
    };

    const attachDiffToMessages = (toolCallId: string, html: string, title: string) => {
        const info: ToolDiffPreviewInfo = {html, title, status: "pending"};
        const chatAsst = findLatestAssistantMessage(getActive().messages);
        const agentAsst = findLatestAssistantMessage(getActiveAgentSession()?.agent.state.messages ?? []);
        for (const asst of [chatAsst, agentAsst]) {
            if (asst?.role === "assistant") {
                asst._toolDiff = {...(asst._toolDiff ?? {}), [toolCallId]: info};
            }
        }
    };

    const inlineRequestConfirm = createInlineToolConfirm(
        refreshInlineActionUi,
        () => abortCtl?.signal,
    );
    const inlineShowDiffPreview = createInlineDiffPreview(
        refreshInlineActionUi,
        attachDiffToMessages,
        () => abortCtl?.signal,
    );

    bindAssistantConfirmNotify((message, anchorEl) => {
        if (isWindowVisibilityDebugEnabled()) {
            logWindowVisibilityDiagnostics("confirm-notify");
        }
        const hidden = isWindowNotVisibleToUser();
        // 桌面端始终尝试系统通知（platformUtils 或 Notification API）；隐藏时勿用应用内 toast（会延后到聚焦才弹）
        if (isSiYuanDesktopClient()) {
            void sendSiYuanDesktopNotification({
                title: "Agent 等待确认",
                body: message,
            });
        }
        if (hidden) {
            return;
        }
        plugin.showPluginMessage(message, 10_000, "info");
        anchorEl.scrollIntoView({block: "center", behavior: "smooth"});
    });

    bindInlineToolActionHandlers({
        onConfirm: (toolCallId, approved) => {
            const aborted = abortCtl?.signal.aborted === true;
            const chatAsst = findLatestAssistantMessage(getActive().messages);
            const agentAsst = findLatestAssistantMessage(getActiveAgentSession()?.agent.state.messages ?? []);
            for (const asst of [chatAsst, agentAsst]) {
                if (!asst?._toolConfirm?.[toolCallId]) {
                    continue;
                }
                if (approved) {
                    const next = {...asst._toolConfirm};
                    delete next[toolCallId];
                    asst._toolConfirm = Object.keys(next).length ? next : undefined;
                } else if (aborted) {
                    const next = {...asst._toolConfirm};
                    delete next[toolCallId];
                    asst._toolConfirm = Object.keys(next).length ? next : undefined;
                } else {
                    asst._toolConfirm[toolCallId] = {
                        ...asst._toolConfirm[toolCallId],
                        status: "rejected",
                    };
                }
            }
            refreshInlineActionUi();
        },
        onDiff: (toolCallId, approved) => {
            const chatAsst = findLatestAssistantMessage(getActive().messages);
            const agentAsst = findLatestAssistantMessage(getActiveAgentSession()?.agent.state.messages ?? []);
            for (const asst of [chatAsst, agentAsst]) {
                if (!asst?._toolDiff?.[toolCallId]) {
                    continue;
                }
                if (approved) {
                    const next = {...asst._toolDiff};
                    delete next[toolCallId];
                    asst._toolDiff = Object.keys(next).length ? next : undefined;
                } else {
                    asst._toolDiff[toolCallId] = {...asst._toolDiff[toolCallId], status: "rejected"};
                }
            }
            refreshInlineActionUi();
        },
    });

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
<li><kbd>Shift+Tab</kbd> 切换模式</li>
<li><kbd>Ctrl+Enter</kbd> 发送</li>
</ul>
</div>`;
            return;
        }

        clearMessagesEmptyState();

        const luteRes = getLuteResult();
        const lute = luteRes.ok ? luteRes.lute : null;

        const visibleMsgs = msgs.filter((m) => m.role !== "tool");

        while (elMessages.children.length > visibleMsgs.length) {
            elMessages.removeChild(elMessages.lastElementChild!);
        }

        for (let i = 0; i < visibleMsgs.length; i++) {
            if (destroyed) {
                return;
            }
            const m = visibleMsgs[i];
            const slot = elMessages.children[i] as HTMLElement | undefined;
            const row = ensureMessageRow(elMessages, m, rowByMessage, slot);

            if (seq !== renderSeq) {
                continue;
            }

            const streamingActive = abortCtl !== null;
            const isStreamingTail =
                streamingActive && i === visibleMsgs.length - 1 && m.role === "assistant";

            if (streamingActive && !isStreamingTail && m.role === "assistant") {
                patchAssistantTooling(row, m);
                continue;
            }

            if (m.role === "user") {
                const pre = row.querySelector(".agent-msg__text");
                if (pre) {
                    pre.textContent = m.content ?? "";
                }
            } else if (m.role === "assistant") {
                if (lute) {
                    try {
                        await patchAssistantRow(row, m, lute, isDestroyed);
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
            const dist = elChatBody.scrollHeight - elChatBody.scrollTop - elChatBody.clientHeight;
            if (dist < 120) {
                elChatBody.scrollTop = elChatBody.scrollHeight;
            }
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

    const createNewSession = () => {
        const settings = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
        const s = createSession("新对话", settings.defaultMode);
        sessions.sessions.unshift(s);
        sessions.activeId = s.id;
        persistSessions();
        renderSessionList();
        renderModePicker();
        updateSessionTitle();
        void renderMessages();
    };

    const runSend = async () => {
        const text = elInput.value.trim();
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
                onMessagesChanged: () => {
                    scheduleStreamRender();
                    updateContextRing();
                },
                customInstructions: [settings.customInstructions, sess.customInstructions].filter(Boolean).join("\n"),
                editorContext: editorCtx,
                attachments,
                worksetNotebookIds: settings.worksetNotebookIds,
                riskAutoApproveMax: settings.riskAutoApproveMax,
                requestConfirm: inlineRequestConfirm,
                showDiffPreview: inlineShowDiffPreview,
            });
            sess.updatedAt = new Date().toISOString();
            sess.title = deriveSessionTitle(sess.messages);
            persistSessions();
            renderSessionList();
            updateSessionTitle();
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
            if (regenerateAfterAbort) {
                regenerateAfterAbort = false;
                performRegenerate();
            }
        }
    };

    const performRegenerate = () => {
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
    };

    function hideMenus(): void {
        elSlashMenu.classList.add("fn__none");
        elMentionMenu.classList.add("fn__none");
    }

    function esc(s: string): string {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function highlightFilter(text: string, filter: string): string {
        if (!filter.trim()) {
            return text;
        }
        const re = new RegExp(`(${filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
        return text.replace(re, "<mark class=\"agent-rail__hl\">$1</mark>");
    }

    // Events
    const bindNewSession = () => createNewSession();

    root.querySelector("[data-new-session]")?.addEventListener("click", bindNewSession);
    root.querySelector("[data-new-session-rail]")?.addEventListener("click", bindNewSession);

    root.querySelector("[data-toggle-rail]")?.addEventListener("click", () => {
        setRailExpanded(!railExpanded);
    });
    root.querySelector("[data-toggle-rail-close]")?.addEventListener("click", () => {
        setRailExpanded(false);
    });
    root.querySelector("[data-rail-history]")?.addEventListener("click", () => {
        setRailExpanded(true, true);
    });

    root.querySelector("[data-regenerate]")?.addEventListener("click", () => {
        if (abortCtl) {
            regenerateAfterAbort = true;
            abortCtl.abort();
            getActiveAgentSession()?.abort();
            cancelPendingInlineActions();
            return;
        }
        performRegenerate();
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

    elSessionSearch.addEventListener("input", (e) => {
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

    const btnContextRing = root.querySelector("[data-context-ring]") as HTMLButtonElement;
    btnContextRing.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const open = elContextTray.classList.toggle("fn__none");
        btnContextRing.setAttribute("aria-expanded", String(!open));
    });
    const onShellClick = (ev: MouseEvent) => {
        if (!(ev.target as HTMLElement).closest(".agent-context-wrap")) {
            elContextTray.classList.add("fn__none");
            btnContextRing.setAttribute("aria-expanded", "false");
        }
    };
    root.addEventListener("click", onShellClick);

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
    btnStop.addEventListener("click", () => {
        if (!abortCtl) {
            return;
        }
        abortCtl.abort();
        getActiveAgentSession()?.abort();
        cancelPendingInlineActions();
    });
    elInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            void runSend();
        }
        if (ev.key === "Tab" && ev.shiftKey) {
            ev.preventDefault();
            cycleMode(1);
        }
        if (ev.key === "/" && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            cycleModel();
        }
        if (ev.key === "n" && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            createNewSession();
        }
        if (ev.key === "Escape") {
            hideMenus();
            elContextTray.classList.add("fn__none");
        }
    });

    elModel.addEventListener("change", () => {
        const s = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
        s.model = elModel.value;
        plugin.data[STORAGE_KEY_SETTINGS] = s;
        void plugin.saveData(STORAGE_KEY_SETTINGS, s);
        updateContextRing();
    });

    const offMessages = agentBus.on(AgentEvents.MESSAGES_RENDER, () => scheduleStreamRender());
    const offStream = agentBus.on(AgentEvents.STREAM_DELTA, () => scheduleStreamRender());

    const settings = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
    chkThinking.checked = settings.thinkingEnabled !== false;
    getActive().includeEditorContext = getActive().includeEditorContext ?? true;
    chkCtx.checked = getActive().includeEditorContext;

    renderModePicker();
    renderSessionList();
    renderCtxChips();
    updateSessionTitle();
    updateContextRing();
    void loadModels();
    void renderMessages();

    const cleanup = () => {
        destroyed = true;
        regenerateAfterAbort = false;
        clearConfirmNotifications();
        bindAssistantConfirmNotify(undefined);
        bindInlineToolActionHandlers(null);
        cancelPendingInlineActions();
        abortCtl?.abort();
        root.removeEventListener("click", onShellClick);
        offMessages();
        offStream();
        if (activityFlushTimer !== null) {
            clearTimeout(activityFlushTimer);
            activityFlushTimer = null;
        }
        // 闪断重载时不写盘，避免 saveData → 同步 → 界面抖动加剧
        const livedMs = Date.now() - mountedAt;
        if (livedMs >= 8000 && activityBuf.peekRecent(1).length > 0) {
            void flushActivity();
        }
        shellCleanups.delete(root);
    };
    shellCleanups.set(root, cleanup);
    return cleanup;
}
