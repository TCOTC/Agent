import type Agent from "../../index";
import {abortAllAgentSessions, runAgentLoop} from "../../agent/agentLoop";
import {AGENT_MODES, type AgentMode} from "../../agent/modes";
import type {AuditEvent, ChatMessage, ToolConfirmRequest, ToolDiffPreviewInfo} from "../../agent/types";
import {listDeepSeekModels} from "../../agent/deepseekClient";
import {createFetchSyncKernelExecutor} from "../../agent/kernelExecutor";
import {ActivityLogBuffer} from "../../core/activityLog";
import {STORAGE_KEY_ACTIVITY, STORAGE_KEY_SESSIONS, STORAGE_KEY_TOKEN_STATS} from "../../core/constants";
import {closeAllComposerDropdowns, mountComposerDropdown} from "../composer/composerDropdown";
import {mountComposerEditor, type ComposerEditorHandle} from "../composer/composerEditor";
import {agentBus, AgentEvents} from "../../core/eventBus";
import {AGENT_ICON_IDS, agentIconHtml} from "../../icons/agentIcons";
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
import {reapplyPendingRiskConfirms} from "../../settings/reapplyRiskConfirms";
import {subscribeSettingsChange} from "../../settings/settingsNotify";
import {normalizeSettings, STORAGE_KEY_SETTINGS} from "../../settings/storage";
import {getSendKeyHintHtml, handleComposerEnterKey} from "../../settings/sendKey";
import type {PersistedSettings} from "../../settings/types";
import {mountTimelinePanel, parseJsonlLines} from "../activity/TimelinePanel";
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
    isWindowNotVisibleToUser,
    clearConfirmNotifyState,
    notifyToolConfirmRequired,
    registerConfirmToastHandler,
} from "../notify/desktopNotify";
import {downloadTextFile, sessionToMarkdown} from "../chat/exportSession";
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
    const streamRafBySession = new Map<string, number>();
    type SessionRunHandle = {
        sessionId: string;
        messages: ChatMessage[];
        ctl: AbortController;
        abortAgent: () => void;
    };

    /** 各会话独立的 Agent 运行（切换视图不中断其它会话） */
    const sessionRuns = new Map<string, SessionRunHandle>();
    let afterAbortAction: (() => void) | null = null;
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

    const getSessionById = (id: string): ChatSession | undefined =>
        sessions.sessions.find((s) => s.id === id);

    /** 指定会话运行中的 messages；缺省为当前可见会话 */
    const getAgentSyncMessages = (sessionId?: string): ChatMessage[] => {
        const id = sessionId ?? sessions.activeId;
        const run = sessionRuns.get(id);
        if (run) {
            return run.messages;
        }
        const s = getSessionById(id);
        return s?.messages ?? getActive().messages;
    };

    const isSessionRunning = (sessionId: string = sessions.activeId) => sessionRuns.has(sessionId);

    const getSessionRunSignal = (sessionId?: string) =>
        sessionRuns.get(sessionId ?? sessions.activeId)?.ctl.signal;

    const abortSessionRun = (sessionId: string) => {
        const run = sessionRuns.get(sessionId);
        if (!run) {
            return;
        }
        run.ctl.abort();
        run.abortAgent();
        cancelPendingInlineActions(sessionId);
    };

    const resumeStreamRenderIfNeeded = () => {
        if (isSessionRunning(sessions.activeId)) {
            scheduleStreamRender(sessions.activeId);
        }
    };

    /** 工具确认条在消息 DOM 上，需切回正在跑 agent 的会话才能看到 */
    const focusRunningSessionForAgentUi = (sessionId: string): boolean => {
        if (sessionId === sessions.activeId) {
            return false;
        }
        switchToSession(sessionId);
        renderSessionList();
        updateSessionTitle();
        updateContextRing();
        modelDropdown.refresh();
        return true;
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
        <button type="button" class="agent-icon-btn" data-new-session title="新对话 (Ctrl+N)" aria-label="新对话">${agentIconHtml(AGENT_ICON_IDS.plus, { size: 14 })}</button>
        <button type="button" class="agent-icon-btn" data-rail-history title="对话历史" aria-label="对话历史">${agentIconHtml(AGENT_ICON_IDS.history, { size: 14 })}</button>
        <button type="button" class="agent-icon-btn" data-regenerate title="重新生成" aria-label="重新生成">${agentIconHtml(AGENT_ICON_IDS.refresh, { size: 14 })}</button>
        <button type="button" class="agent-icon-btn" data-export-session title="导出对话" aria-label="导出对话">${agentIconHtml(AGENT_ICON_IDS.download, { size: 14 })}</button>
        <button type="button" class="agent-icon-btn" data-pin-session title="置顶" aria-label="置顶" aria-pressed="false">${agentIconHtml(AGENT_ICON_IDS.pin, { size: 14 })}</button>
        <button type="button" class="agent-icon-btn" data-open-settings title="设置" aria-label="设置">${agentIconHtml(AGENT_ICON_IDS.settings, { size: 14 })}</button>
        <button type="button" class="agent-icon-btn" data-toggle-rail title="会话列表" aria-label="会话列表" aria-expanded="false">${agentIconHtml(AGENT_ICON_IDS.panelRight, { size: 14 })}</button>
      </div>
    </header>
    <div class="agent-main__body fn__flex-1" data-tab-chat>
      <div class="agent-messages" data-messages></div>
    </div>
    <div class="agent-main__body fn__flex-1 fn__none" data-tab-activity>
      <div class="agent-timeline" data-timeline></div>
    </div>
    <div class="agent-composer">
      <div class="agent-context-card fn__none" data-context-card aria-label="上下文明细">
        <header class="agent-context-card__head fn__flex">
          <span class="agent-context-card__title">上下文</span>
          <button type="button" class="agent-context-card__close" data-context-close title="关闭" aria-label="关闭">${agentIconHtml(AGENT_ICON_IDS.x, { size: 14 })}</button>
        </header>
        <div class="agent-context-card__meta fn__flex">
          <span data-context-pct-label></span>
          <span class="fn__flex-1"></span>
          <span data-context-token-range></span>
        </div>
        <div class="agent-context-card__bar" aria-hidden="true"><span data-context-bar-fill></span></div>
        <div class="agent-context-card__body" data-context-card-body></div>
      </div>
      <div class="agent-composer__card">
        <div class="agent-composer__input-wrap">
          <div class="agent-composer__editor" data-composer-editor></div>
        </div>
        <div class="agent-composer__footer">
          <div class="agent-composer__footer-start fn__flex">
            <button type="button" data-mode-dropdown></button>
            <button type="button" data-model-dropdown></button>
          </div>
          <div class="agent-composer__footer-end fn__flex">
            <button type="button" class="agent-context-ring" data-context-ring title="上下文占用" aria-label="上下文占用" aria-expanded="false">
              <svg class="agent-context-ring__svg" viewBox="0 0 28 28" aria-hidden="true">
                <circle class="agent-context-ring__track" cx="14" cy="14" r="11.5" fill="none"/>
                <circle class="agent-context-ring__fill" cx="14" cy="14" r="11.5" fill="none" data-ring-fill/>
              </svg>
              <span class="agent-context-ring__pct" data-ring-pct>0</span>
            </button>
            <button type="button" class="agent-composer__submit" data-submit title="发送" aria-label="发送">
              ${agentIconHtml(AGENT_ICON_IDS.arrowUp, { size: 9, className: "agent-composer__submit-icon", attrs: { "data-submit-icon-send": "" } })}
              ${agentIconHtml(AGENT_ICON_IDS.square, { size: 9, className: "agent-composer__submit-icon fn__none", attrs: { "data-submit-icon-stop": "" } })}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <aside class="agent-rail agent-rail--collapsed fn__flex-column" data-rail aria-label="会话列表">
    <div class="agent-rail__head fn__flex">
      <span class="agent-rail__title">对话</span>
      <button type="button" class="agent-icon-btn agent-icon-btn--sm" data-new-session-rail title="新对话" aria-label="新对话">${agentIconHtml(AGENT_ICON_IDS.plus, { size: 13 })}</button>
      <button type="button" class="agent-icon-btn agent-icon-btn--sm" data-toggle-rail-close title="收起" aria-label="收起">${agentIconHtml(AGENT_ICON_IDS.x, { size: 13 })}</button>
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
    const elComposerEditor = root.querySelector("[data-composer-editor]") as HTMLElement;
    const elModeDropdown = root.querySelector("[data-mode-dropdown]") as HTMLButtonElement;
    const elModelDropdown = root.querySelector("[data-model-dropdown]") as HTMLButtonElement;
    const elRingFill = root.querySelector("[data-ring-fill]") as SVGCircleElement;
    const elRingPct = root.querySelector("[data-ring-pct]") as HTMLElement;
    const elContextCard = root.querySelector("[data-context-card]") as HTMLElement;
    const elContextCardBody = root.querySelector("[data-context-card-body]") as HTMLElement;
    const elContextPctLabel = root.querySelector("[data-context-pct-label]") as HTMLElement;
    const elContextTokenRange = root.querySelector("[data-context-token-range]") as HTMLElement;
    const elContextBarFill = root.querySelector("[data-context-bar-fill]") as HTMLElement;
    const btnContextClose = root.querySelector("[data-context-close]") as HTMLButtonElement;
    const btnSubmit = root.querySelector("[data-submit]") as HTMLButtonElement;
    const elSubmitIconSend = root.querySelector("[data-submit-icon-send]") as SVGElement;
    const elSubmitIconStop = root.querySelector("[data-submit-icon-stop]") as SVGElement;
    const btnToggleRail = root.querySelector("[data-toggle-rail]") as HTMLButtonElement;
    const btnPinSession = root.querySelector("[data-pin-session]") as HTMLButtonElement;
    const RING_CIRC = 2 * Math.PI * 11.5;
    let modelOptionIds: string[] = [];

    const getSettings = () => normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);

    const getSessionModel = (sess: ChatSession): string => {
        const settings = getSettings();
        const fromSession = sess.model?.trim();
        if (fromSession) {
            return fromSession;
        }
        return settings.model || modelOptionIds[0] || "";
    };

    const getActiveSessionModel = () => getSessionModel(getActive());

    const isThinkingEnabled = () => getSettings().thinkingEnabled !== false;

    const persistSettings = (patch: Partial<PersistedSettings>) => {
        void plugin.persistPluginSettings({...getSettings(), ...patch});
    };

    const isDestroyed = () => destroyed;

    const setSubmitRunning = (running: boolean) => {
        btnSubmit.classList.toggle("agent-composer__submit--stop", running);
        btnSubmit.title = running ? "停止" : "发送";
        btnSubmit.setAttribute("aria-label", running ? "停止" : "发送");
        elSubmitIconSend.classList.toggle("fn__none", running);
        elSubmitIconStop.classList.toggle("fn__none", !running);
    };

    const isActiveSessionStreaming = () => isSessionRunning(sessions.activeId);

    const syncSubmitRunning = () => {
        setSubmitRunning(isActiveSessionStreaming());
    };

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
        btnPinSession.classList.toggle("agent-icon-btn--active", s.pinned);
        btnPinSession.setAttribute("aria-pressed", String(s.pinned));
        const pinLabel = s.pinned ? "取消置顶" : "置顶";
        btnPinSession.title = pinLabel;
        btnPinSession.setAttribute("aria-label", pinLabel);
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
        const model = getActiveSessionModel() || settings.model;
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
        elContextPctLabel.textContent = pct >= 100 ? "已满" : `${pct}% 已用`;
        elContextTokenRange.textContent =
            `~${contextTokens.toLocaleString()} / ${contextLimit.toLocaleString()} Tokens`;
        elContextBarFill.style.width = `${pct}%`;
        elContextCardBody.innerHTML = `
<ul class="agent-context-card__list">
<li><span class="agent-context-card__dot agent-context-card__dot--prompt"></span><span class="agent-context-card__name">上下文窗口</span><span class="agent-context-card__val">${contextTokens.toLocaleString()}</span></li>
<li><span class="agent-context-card__dot agent-context-card__dot--round"></span><span class="agent-context-card__name">本轮统计</span><span class="agent-context-card__val">${contextSource}</span></li>
<li><span class="agent-context-card__dot agent-context-card__dot--total"></span><span class="agent-context-card__name">累计 Token</span><span class="agent-context-card__val">${formatTokenBrief(u)}</span></li>
</ul>
<p class="agent-context-card__note">用量来自 API；窗口上限见插件设置。</p>`;
    };

    const btnContextRing = root.querySelector("[data-context-ring]") as HTMLButtonElement;

    const closeContextCard = () => {
        elContextCard.classList.add("fn__none");
        btnContextRing.setAttribute("aria-expanded", "false");
    };

    const toggleContextCard = () => {
        const willOpen = elContextCard.classList.contains("fn__none");
        if (willOpen) {
            updateContextRing();
            elContextCard.classList.remove("fn__none");
            btnContextRing.setAttribute("aria-expanded", "true");
        } else {
            closeContextCard();
        }
    };

    const modeDropdown = mountComposerDropdown<AgentMode>({
        host: elModeDropdown,
        menuId: "agent-composer-mode",
        ariaLabel: "模式",
        onOpen: () => {
            closeContextCard();
        },
        getValue: () => getActive().mode,
        getOptions: () => AGENT_MODES.map((m) => ({
            value: m.id,
            label: m.label,
            hint: m.description,
        })),
        onChange: (id) => {
            getActive().mode = id;
            persistSessions();
            renderSessionList();
            modeDropdown.refresh();
        },
    });

    const modelDropdown = mountComposerDropdown<string>({
        host: elModelDropdown,
        menuId: "agent-composer-model",
        ariaLabel: "模型",
        onOpen: () => {
            closeContextCard();
        },
        getValue: () => getActiveSessionModel(),
        getOptions: () => {
            const cur = getActiveSessionModel();
            const ids = modelOptionIds.length ? modelOptionIds : (cur ? [cur] : []);
            return ids.map((id) => ({value: id, label: id}));
        },
        onChange: (id) => {
            getActive().model = id;
            persistSessions();
            updateContextRing();
            modelDropdown.refresh();
        },
        buildMenuItems: (menu) => {
            menu.addSeparator();
            menu.addItem({
                type: "empty",
                label: [
                    "<label class=\"b3-menu__item\">",
                    "<span class=\"fn__flex-center\">思考</span>",
                    "<span class=\"fn__space fn__flex-1\"></span>",
                    "<input type=\"checkbox\" class=\"b3-switch b3-switch--menu\">",
                    "</label>",
                ].join(""),
                bind: (element) => {
                    const input = element.querySelector("input") as HTMLInputElement;
                    input.checked = isThinkingEnabled();
                    input.addEventListener("change", () => {
                        persistSettings({thinkingEnabled: input.checked});
                    });
                },
            });
        },
    });

    const cycleMode = (dir: 1 | -1) => {
        const idx = AGENT_MODES.findIndex((m) => m.id === getActive().mode);
        const next = AGENT_MODES[(idx + dir + AGENT_MODES.length) % AGENT_MODES.length];
        getActive().mode = next.id;
        persistSessions();
        modeDropdown.refresh();
        renderSessionList();
    };

    const cycleModel = () => {
        if (modelOptionIds.length < 2) {
            return;
        }
        const cur = getActiveSessionModel();
        const i = modelOptionIds.indexOf(cur);
        const next = modelOptionIds[(i + 1) % modelOptionIds.length];
        getActive().model = next;
        persistSessions();
        updateContextRing();
        modelDropdown.refresh();
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

    const pushAudit = (e: AuditEvent, sessionId?: string) => {
        activityBuf.push(e);
        if (e.kind === "llm_response" && e.usage) {
            const u = parseDeepSeekUsage(e.usage);
            if (u) {
                const s = getSessionById(sessionId ?? sessions.activeId) ?? getActive();
                s.tokenUsage = mergeUsage(s.tokenUsage, u);
                if (u.promptTokens > 0) {
                    s.lastContextTokens = u.promptTokens;
                }
                if ((sessionId ?? sessions.activeId) === sessions.activeId) {
                    updateContextRing();
                }
                persistSessions();
                void persistTokenStats(u, sessionId);
            }
        }
        if (activeTab === "activity") {
            void refreshTimeline();
        }
        scheduleActivityFlush();
    };

    const persistTokenStats = async (delta: TokenUsageRecord, sessionId?: string) => {
        const raw = (await plugin.loadData(STORAGE_KEY_TOKEN_STATS)) as TokenStatsPersisted | null;
        const base: TokenStatsPersisted = raw?.lifetime
            ? raw
            : {lifetime: {promptTokens: 0, completionTokens: 0, totalTokens: 0}, sessions: {}, lastUpdated: ""};
        base.lifetime = mergeUsage(base.lifetime, delta);
        const statsSessionId = sessionId ?? sessions.activeId;
        base.sessions[statsSessionId] = mergeUsage(
            base.sessions[statsSessionId] ?? {promptTokens: 0, completionTokens: 0, totalTokens: 0},
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
            const running = isSessionRunning(s.id);
            btn.className =
                "agent-rail__item" +
                (s.id === sessions.activeId ? " agent-rail__item--active" : "") +
                (running ? " agent-rail__item--running" : "");
            btn.dataset.id = s.id;
            const titleHtml = highlightFilter(esc(s.title), sessionFilter);
            const modeLabel = AGENT_MODES.find((m) => m.id === s.mode)?.label ?? "智能体";
            const metaSuffix = running ? " · 运行中" : "";
            btn.innerHTML = `<span class="agent-rail__item-title fn__ellipsis">${s.pinned ? `${agentIconHtml(AGENT_ICON_IDS.pin, { size: 12, className: "agent-rail__pin" })} ` : ""}${titleHtml}</span>
<span class="agent-rail__item-meta">${modeLabel}${metaSuffix}</span>`;
            btn.addEventListener("click", () => {
                switchToSession(s.id);
                persistSessions();
                renderSessionList();
                modeDropdown.refresh();
                modelDropdown.refresh();
                updateSessionTitle();
                void renderMessages({scrollToEnd: true});
                resumeStreamRenderIfNeeded();
                updateContextRing();
            });
            btn.addEventListener("contextmenu", (ev) => {
                ev.preventDefault();
                if (confirm("删除此对话？")) {
                    const deletingActive = sessions.activeId === s.id;
                    abortSessionRun(s.id);
                    sessionRuns.delete(s.id);
                    if (deletingActive) {
                        flushComposerDraft();
                    }
                    sessions.sessions = sessions.sessions.filter((x) => x.id !== s.id);
                    if (!sessions.sessions.length) {
                        const settings = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
                        const n = createSession("新对话", settings.defaultMode, settings.model);
                        sessions.sessions.push(n);
                        sessions.activeId = n.id;
                    } else if (deletingActive) {
                        sessions.activeId = sessions.sessions[0].id;
                    }
                    if (deletingActive) {
                        restoreComposerDraft();
                        syncSubmitRunning();
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

    const scheduleStreamRender = (originSessionId?: string) => {
        if (destroyed) {
            return;
        }
        const streamSessionId = originSessionId ?? sessions.activeId;
        const prevRaf = streamRafBySession.get(streamSessionId);
        if (prevRaf) {
            cancelAnimationFrame(prevRaf);
        }
        const raf = requestAnimationFrame(() => {
            streamRafBySession.delete(streamSessionId);
            if (streamSessionId !== sessions.activeId) {
                persistSessions();
                return;
            }
            const msgs = getActive().messages;
            const visibleMsgs = msgs.filter((m) => m.role !== "tool");
            const tail = visibleMsgs[visibleMsgs.length - 1];
            const streamingActive = isActiveSessionStreaming();
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
        streamRafBySession.set(streamSessionId, raf);
    };

    const scheduleStreamRenderForAllRuns = () => {
        scheduleStreamRender(sessions.activeId);
        for (const sid of sessionRuns.keys()) {
            if (sid !== sessions.activeId) {
                scheduleStreamRender(sid);
            }
        }
    };

    const refreshInlineActionUi = (sessionId?: string) => {
        scheduleStreamRender(sessionId ?? sessions.activeId);
    };

    const handleToolConfirmRequired = (sessionId: string, req: ToolConfirmRequest) => {
        if (focusRunningSessionForAgentUi(sessionId)) {
            persistSessions();
        }
        void renderMessages();
        notifyToolConfirmRequired(req);
    };

    const attachDiffToMessages = (sessionId: string, toolCallId: string, html: string, title: string) => {
        const info: ToolDiffPreviewInfo = {html, title, status: "pending"};
        const chatAsst = findLatestAssistantMessage(getAgentSyncMessages(sessionId));
        if (chatAsst?.role === "assistant") {
            chatAsst._toolDiff = {...(chatAsst._toolDiff ?? {}), [toolCallId]: info};
        }
    };

    registerConfirmToastHandler((text) => {
        plugin.showPluginMessage(text, 10_000, "info");
    });

    bindAssistantConfirmNotify((_message, anchorEl) => {
        if (!isWindowNotVisibleToUser()) {
            anchorEl.scrollIntoView({block: "center", behavior: "smooth"});
        }
    });

    bindInlineToolActionHandlers({
        onConfirm: (sessionId, toolCallId, _approved) => {
            const chatAsst = findLatestAssistantMessage(getAgentSyncMessages(sessionId));
            if (!chatAsst?._toolConfirm?.[toolCallId]) {
                return;
            }
            const next = {...chatAsst._toolConfirm};
            delete next[toolCallId];
            chatAsst._toolConfirm = Object.keys(next).length ? next : undefined;
            refreshInlineActionUi(sessionId);
        },
        onDiff: (sessionId, toolCallId, approved) => {
            const chatAsst = findLatestAssistantMessage(getAgentSyncMessages(sessionId));
            if (!chatAsst?._toolDiff?.[toolCallId]) {
                return;
            }
            if (approved) {
                const next = {...chatAsst._toolDiff};
                delete next[toolCallId];
                chatAsst._toolDiff = Object.keys(next).length ? next : undefined;
            } else {
                chatAsst._toolDiff[toolCallId] = {...chatAsst._toolDiff[toolCallId], status: "rejected"};
            }
            refreshInlineActionUi(sessionId);
        },
    });

    function clearMessagesEmptyState(): void {
        elMessages.querySelector(".agent-empty")?.remove();
    }

    const scrollChatToEnd = () => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                elChatBody.scrollTop = elChatBody.scrollHeight;
            });
        });
    };

    async function renderMessages(options?: {scrollToEnd?: boolean}): Promise<void> {
        if (destroyed) {
            return;
        }
        const seq = ++renderSeq;
        const msgs = getActive().messages;
        elMessages.dataset.sessionId = sessions.activeId;

        if (!msgs.length) {
            const sendHint = getSendKeyHintHtml(normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]).sendKeyMode);
            elMessages.innerHTML = `<div class="agent-empty">
<h3>Agent 已就绪</h3>
<p>问答 · 多步工具 · 文档 Diff 编辑</p>
<ul>
<li><kbd>@</kbd> 搜索并引用块（内联芯片）</li>
<li><kbd>Shift+Tab</kbd> 切换模式</li>
<li>${sendHint}</li>
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

            const streamingActive = isActiveSessionStreaming();
            const isStreamingTail =
                streamingActive && i === visibleMsgs.length - 1 && m.role === "assistant";

            if (streamingActive && !isStreamingTail && m.role === "assistant") {
                patchAssistantTooling(row, m);
                continue;
            }

            if (m.role === "user") {
                const input = row.querySelector(".agent-msg__input") as HTMLTextAreaElement | null;
                if (input && document.activeElement !== input) {
                    const next = m.content ?? "";
                    if (input.value !== next) {
                        input.value = next;
                    }
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
            if (options?.scrollToEnd) {
                scrollChatToEnd();
            } else {
                const dist = elChatBody.scrollHeight - elChatBody.scrollTop - elChatBody.clientHeight;
                if (dist < 120) {
                    scrollChatToEnd();
                }
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
        const settings = getSettings();
        if (!settings.apiKey) {
            modelOptionIds = settings.model ? [settings.model] : [];
            modelDropdown.refresh();
            return;
        }
        try {
            const models = await listDeepSeekModels(settings);
            modelOptionIds = models.map((m) => m.id);
        } catch {
            modelOptionIds = settings.model ? [settings.model] : [];
        }
        modelDropdown.refresh();
    };

    const createNewSession = () => {
        const settings = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
        const s = createSession("新对话", settings.defaultMode, settings.model);
        sessions.sessions.unshift(s);
        switchToSession(s.id);
        persistSessions();
        renderSessionList();
        modeDropdown.refresh();
        updateSessionTitle();
        void renderMessages();
    };

    const findMessageForRow = (row: HTMLElement): ChatMessage | undefined => {
        for (const msg of getActive().messages) {
            if (rowByMessage.get(msg) === row) {
                return msg;
            }
        }
        return undefined;
    };

    const truncateFromMessage = (m: ChatMessage) => {
        const s = getActive();
        const idx = s.messages.indexOf(m);
        if (idx < 0) {
            return;
        }
        const removed = s.messages.splice(idx);
        for (const msg of removed) {
            clearAssistantCache(msg);
        }
        persistSessions();
    };

    const resendUserMessage = (row: HTMLElement) => {
        const m = findMessageForRow(row);
        if (!m || m.role !== "user") {
            return;
        }
        const input = row.querySelector(".agent-msg__input") as HTMLTextAreaElement | null;
        if (!input) {
            return;
        }
        const text = input.value.trim();
        if (!text) {
            return;
        }
        const doResend = () => void runSend({text, truncateFrom: m});
        if (isActiveSessionStreaming()) {
            afterAbortAction = doResend;
            abortSessionRun(sessions.activeId);
            return;
        }
        doResend();
    };

    const getSendKeyMode = () => normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]).sendKeyMode;

    let composerDraftTimer: ReturnType<typeof setTimeout> | null = null;

    const applyComposerDraftToActiveSession = () => {
        const session = getActive();
        if (composerEditor.hasVisibleContent()) {
            session.composerDraft = composerEditor.getDocumentJSON();
        } else {
            delete session.composerDraft;
        }
    };

    const flushComposerDraft = () => {
        if (composerDraftTimer !== null) {
            clearTimeout(composerDraftTimer);
            composerDraftTimer = null;
        }
        applyComposerDraftToActiveSession();
        persistSessions();
    };

    const scheduleComposerDraftPersist = () => {
        if (composerDraftTimer !== null) {
            clearTimeout(composerDraftTimer);
        }
        const sessionId = sessions.activeId;
        composerDraftTimer = setTimeout(() => {
            composerDraftTimer = null;
            if (sessionId !== sessions.activeId) {
                return;
            }
            applyComposerDraftToActiveSession();
            persistSessions();
        }, 400);
    };

    const restoreComposerDraft = () => {
        const session = getActive();
        composerEditor.setDocumentJSON(session.composerDraft ?? null);
    };

    const switchToSession = (id: string) => {
        if (id === sessions.activeId) {
            return;
        }
        flushComposerDraft();
        sessions.activeId = id;
        restoreComposerDraft();
        syncSubmitRunning();
        resumeStreamRenderIfNeeded();
        modelDropdown.refresh();
        updateContextRing();
    };

    const composerEditor: ComposerEditorHandle = mountComposerEditor({
        editorHost: elComposerEditor,
        app: plugin.app,
        kernel,
        placeholder: "说点什么…",
        sendKeyMode: getSendKeyMode(),
        onSend: () => void runSend(),
        onDraftChange: scheduleComposerDraftPersist,
    });

    restoreComposerDraft();

    const runSend = async (opts?: {text?: string; truncateFrom?: ChatMessage}) => {
        const text = (opts?.text ?? composerEditor.getSendText()).trim();
        if (!text) {
            return;
        }
        const settings = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
        if (!settings.apiKey) {
            plugin.showPluginMessage("请先配置 DeepSeek API Key");
            return;
        }
        if (!opts?.text) {
            composerEditor.clear();
            delete getActive().composerDraft;
        }
        if (opts?.truncateFrom) {
            truncateFromMessage(opts.truncateFrom);
        }

        const sess = getActive();
        const sendSessionId = sess.id;
        const prevRun = sessionRuns.get(sendSessionId);
        prevRun?.ctl.abort();
        prevRun?.abortAgent();
        const runCtl = new AbortController();
        let sessionAbort: (() => void) | null = null;
        sessionRuns.set(sendSessionId, {
            sessionId: sendSessionId,
            messages: sess.messages,
            ctl: runCtl,
            abortAgent: () => sessionAbort?.(),
        });
        const runSignal = runCtl.signal;
        syncSubmitRunning();
        renderSessionList();

        let outcome: Awaited<ReturnType<typeof runAgentLoop>> | undefined;
        try {
            outcome = await runAgentLoop({
                plugin,
                sessionId: sendSessionId,
                mode: sess.mode,
                llm: {
                    baseUrl: settings.baseUrl,
                    apiKey: settings.apiKey,
                    model: getSessionModel(sess) || settings.model,
                    thinkingEnabled: isThinkingEnabled(),
                },
                messages: sess.messages,
                userText: text,
                signal: runSignal,
                onAudit: (e) => pushAudit(e, sendSessionId),
                onStreamDelta: () => scheduleStreamRender(sendSessionId),
                onMessagesChanged: () => {
                    scheduleStreamRender(sendSessionId);
                    if (sendSessionId === sessions.activeId) {
                    updateContextRing();
                }
                },
                customInstructions: [settings.customInstructions, sess.customInstructions].filter(Boolean).join("\n"),
                worksetNotebookIds: settings.worksetNotebookIds,
                getRiskAutoApproveMax: () => getSettings().riskAutoApproveMax,
                requestConfirm: createInlineToolConfirm(
                    sendSessionId,
                    () => scheduleStreamRender(sendSessionId),
                    () => getSessionRunSignal(sendSessionId),
                    (req) => handleToolConfirmRequired(sendSessionId, req),
                ),
                showDiffPreview: createInlineDiffPreview(
                    sendSessionId,
                    () => scheduleStreamRender(sendSessionId),
                    (toolCallId, html, title) => attachDiffToMessages(sendSessionId, toolCallId, html, title),
                    () => getSessionRunSignal(sendSessionId),
                ),
                onRunReady: (handles) => {
                    sessionAbort = handles.abort;
                },
            });
            sess.updatedAt = new Date().toISOString();
            sess.title = deriveSessionTitle(sess.messages);
            persistSessions();
            renderSessionList();
            updateSessionTitle();
            const showRunToast = sendSessionId === sessions.activeId && !runSignal.aborted;
            if (showRunToast && outcome.kind === "stopped") {
                const r = outcome.reason;
                if (r.kind !== "aborted") {
                    const detail = r.kind === "http_error" ? `HTTP ${r.status}` : r.kind;
                    plugin.showPluginMessage(`Agent 中断：${detail}`);
                }
            } else if (showRunToast && outcome.kind === "unexpected_error") {
                plugin.showPluginMessage(outcome.message);
            }
        } finally {
            sessionRuns.delete(sendSessionId);
            syncSubmitRunning();
            renderSessionList();
            if (sendSessionId === sessions.activeId) {
                void renderMessages();
            }
            if (afterAbortAction) {
                const fn = afterAbortAction;
                afterAbortAction = null;
                fn();
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
        composerEditor.setSendText(lastUser.content);
        s.messages.pop();
        persistSessions();
        void renderMessages();
        void runSend();
    };

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
        if (isActiveSessionStreaming()) {
            afterAbortAction = () => performRegenerate();
            abortSessionRun(sessions.activeId);
            return;
        }
        performRegenerate();
    });

    elMessages.addEventListener("mousedown", (e) => {
        if (e.button !== 0) {
            return;
        }
        const row = (e.target as HTMLElement).closest(".agent-msg--user") as HTMLElement | null;
        if (!row) {
            return;
        }
        const t = e.target as HTMLElement;
        if (t.closest(".agent-msg__input") || t.closest("[data-user-resend]")) {
            return;
        }
        const input = row.querySelector(".agent-msg__input") as HTMLTextAreaElement | null;
        input?.focus();
    });
    elMessages.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("[data-user-resend]");
        if (!btn) {
            return;
        }
        const row = btn.closest(".agent-msg--user") as HTMLElement | null;
        if (row) {
            resendUserMessage(row);
        }
    });
    elMessages.addEventListener("keydown", (e) => {
        const el = e.target;
        if (!(el instanceof HTMLTextAreaElement) || !el.classList.contains("agent-msg__input")) {
            return;
        }
        const row = el.closest(".agent-msg--user") as HTMLElement | null;
        if (!row) {
            return;
        }
        const sendKeyMode = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]).sendKeyMode;
        handleComposerEnterKey(e, el, sendKeyMode, () => resendUserMessage(row));
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
        updateSessionTitle();
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

    btnContextRing.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeAllComposerDropdowns();
        toggleContextCard();
    });
    btnContextClose.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeContextCard();
    });
    const onShellClick = (ev: MouseEvent) => {
        const t = ev.target as HTMLElement;
        if (!t.closest("[data-context-ring]") && !t.closest("[data-context-card]")) {
            closeContextCard();
        }
    };
    root.addEventListener("click", onShellClick);

    btnSubmit.addEventListener("click", () => {
        if (isActiveSessionStreaming()) {
            abortSessionRun(sessions.activeId);
            return;
        }
        void runSend();
    });
    elComposerEditor.addEventListener("keydown", (ev) => {
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
            closeAllComposerDropdowns();
            closeContextCard();
        }
    });

    const offMessages = agentBus.on(AgentEvents.MESSAGES_RENDER, () => scheduleStreamRenderForAllRuns());
    const offStream = agentBus.on(AgentEvents.STREAM_DELTA, () => scheduleStreamRenderForAllRuns());
    const offSettingsChange = subscribeSettingsChange((settings) => {
        if (reapplyPendingRiskConfirms(sessions, settings.riskAutoApproveMax)) {
            persistSessions();
            scheduleStreamRenderForAllRuns();
        }
    });

    void (async () => {
        if (reapplyPendingRiskConfirms(sessions, getSettings().riskAutoApproveMax)) {
            await renderMessages();
        }
    })();

    modeDropdown.refresh();
    renderSessionList();
    updateSessionTitle();
    updateContextRing();
    void loadModels();
    void renderMessages({scrollToEnd: true});

    const cleanup = () => {
        destroyed = true;
        afterAbortAction = null;
        clearConfirmNotifications();
        clearConfirmNotifyState();
        bindAssistantConfirmNotify(undefined);
        bindInlineToolActionHandlers(null);
        cancelPendingInlineActions();
        for (const run of sessionRuns.values()) {
            run.ctl.abort();
            run.abortAgent();
        }
        sessionRuns.clear();
        streamRafBySession.forEach((raf) => cancelAnimationFrame(raf));
        streamRafBySession.clear();
        abortAllAgentSessions();
        modeDropdown.destroy();
        modelDropdown.destroy();
        flushComposerDraft();
        composerEditor.destroy();
        if (composerDraftTimer !== null) {
            clearTimeout(composerDraftTimer);
            composerDraftTimer = null;
        }
        root.removeEventListener("click", onShellClick);
        offMessages();
        offStream();
        offSettingsChange();
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
