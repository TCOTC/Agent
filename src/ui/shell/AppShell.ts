import {Menu, type IMenu} from "siyuan";
import type Agent from "../../index";
import {abortAllAgentSessions, runAgentLoop} from "../../agent/agentLoop";
import {AGENT_MODES, type AgentMode} from "../../agent/modes";
import type {AuditEvent, ChatMessage, ToolConfirmRequest, ToolDiffPreviewInfo} from "../../agent/types";
import {listDeepSeekModels} from "../../agent/deepseekClient";
import {createFetchSyncKernelExecutor} from "../../agent/kernelExecutor";
import {STORAGE_KEY_SESSIONS, STORAGE_KEY_TOKEN_STATS} from "../../core/constants";
import {closeAllComposerDropdowns, mountComposerDropdown} from "../composer/composerDropdown";
import {composerDocToLlmText, legacyUserContentToComposerDoc} from "../composer/blockMentionText";
import {mountComposerEditor, type ComposerEditorHandle} from "../composer/composerEditor";
import type {JSONContent} from "@tiptap/core";
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
    filterSessions,
    normalizeSessions,
    sortSessions,
} from "../../session/storage";
import {
    generateSessionTitle,
    shouldAutoSummarizeSessionTitle,
} from "../../session/summarizeTitle";
import type {ChatSession, SessionsPersisted} from "../../session/types";
import {reapplyPendingRiskConfirms} from "../../settings/reapplyRiskConfirms";
import {subscribeSettingsChange} from "../../settings/settingsNotify";
import {normalizeSettings, STORAGE_KEY_SETTINGS} from "../../settings/storage";
import {getSendKeyHintHtml} from "../../settings/sendKey";
import type {PersistedSettings} from "../../settings/types";
import {
    bindAssistantConfirmNotify,
    clearAssistantCache,
    ensureMessageRow,
    patchAssistantRow,
    patchAssistantRowPlain,
    patchAssistantToolCallsOnly,
    patchAssistantTooling,
    isRoundTailAssistant,
    syncAllAssistantActionsVisibility,
} from "../chat/messageRenderer";
import {clearConfirmNotifications} from "../chat/toolConfirmBanner";
import {
    isWindowNotVisibleToUser,
    clearConfirmNotifyState,
    notifyToolConfirmRequired,
    registerConfirmToastHandler,
} from "../notify/desktopNotify";
import {downloadTextFile, sessionToMarkdown} from "../chat/exportSession";
import {confirmPromise} from "../../util";
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
    const rowToMessage = new Map<HTMLElement, ChatMessage>();
    const userEditorByMessage = new WeakMap<ChatMessage, ComposerEditorHandle>();
    const userEditorDocSigByMessage = new WeakMap<ChatMessage, string>();
    const userMessageEditors = new Set<ComposerEditorHandle>();
    let userMessageDraftTimer: ReturnType<typeof setTimeout> | null = null;
    const kernel = createFetchSyncKernelExecutor();

    const sessions: SessionsPersisted = normalizeSessions(plugin.data[STORAGE_KEY_SESSIONS]);
    let sessionFilter = "";

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
      </div>
      <div class="agent-header__actions fn__flex">
        <button type="button" class="agent-icon-btn" data-new-session title="新对话 (Ctrl+N)" aria-label="新对话">${agentIconHtml(AGENT_ICON_IDS.plus, { size: 14 })}</button>
        <button type="button" class="agent-icon-btn" data-open-settings title="设置" aria-label="设置">${agentIconHtml(AGENT_ICON_IDS.settings, { size: 14 })}</button>
        <button type="button" class="agent-icon-btn" data-toggle-rail title="会话列表" aria-label="会话列表" aria-expanded="false">${agentIconHtml(AGENT_ICON_IDS.panelRight, { size: 14 })}</button>
      </div>
    </header>
    <div class="agent-main__body fn__flex-1" data-chat-body>
      <div class="agent-messages" data-messages></div>
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
            <button type="button" class="agent-send-btn" data-submit title="发送" aria-label="发送">
              ${agentIconHtml(AGENT_ICON_IDS.arrowUp, { size: 10, className: "agent-send-btn__icon", attrs: { "data-submit-icon-send": "" } })}
              ${agentIconHtml(AGENT_ICON_IDS.square, { size: 9, className: "agent-send-btn__icon fn__none", attrs: { "data-submit-icon-stop": "" } })}
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
    const elChatBody = root.querySelector("[data-chat-body]") as HTMLElement;
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
        btnSubmit.classList.toggle("agent-send-btn--stop", running);
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
    };

    const titleSummaryInFlight = new Set<string>();

    const requestSessionTitleSummary = (
        sessionId: string,
        userText: string,
        composerDoc?: ChatMessage["composerDoc"],
    ) => {
        if (titleSummaryInFlight.has(sessionId)) {
            return;
        }
        const sess = getSessionById(sessionId);
        if (!sess || !shouldAutoSummarizeSessionTitle(sess)) {
            return;
        }
        const settings = getSettings();
        if (!settings.apiKey?.trim()) {
            return;
        }
        titleSummaryInFlight.add(sessionId);
        const model = getSessionModel(sess) || settings.model;
        void generateSessionTitle(
            settings,
            {userText, composerDoc},
            model,
        )
            .then((title) => {
                const s = getSessionById(sessionId);
                if (!s || destroyed) {
                    return;
                }
                if (title) {
                    s.title = title;
                    s.titleAutoGenerated = true;
                    persistSessions();
                    renderSessionList();
                    if (sessions.activeId === sessionId) {
                        updateSessionTitle();
                    }
                }
            })
            .finally(() => {
                titleSummaryInFlight.delete(sessionId);
            });
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

    const pushAudit = (e: AuditEvent, sessionId?: string) => {
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

    const deleteSession = async (sessionId: string) => {
        const target = getSessionById(sessionId);
        if (!target) {
            return;
        }
        const title = target.title || "新对话";
        const ok = await confirmPromise("删除对话", `确定删除「${title}」？此操作不可恢复。`);
        if (!ok) {
            return;
        }
        const deletingActive = sessions.activeId === sessionId;
        abortSessionRun(sessionId);
        sessionRuns.delete(sessionId);
        if (deletingActive) {
            flushComposerDraft();
        }
        sessions.sessions = sessions.sessions.filter((x) => x.id !== sessionId);
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
    };

    const openSessionContextMenu = (sessionId: string, ev: MouseEvent) => {
        ev.preventDefault();
        const s = getSessionById(sessionId);
        if (!s) {
            return;
        }
        const menu = new Menu("agent-session-ctx");
        const pinItem: IMenu = {
            iconHTML: "",
            label: s.pinned ? "取消置顶" : "置顶",
            click: () => {
                s.pinned = !s.pinned;
                persistSessions();
                renderSessionList();
                updateSessionTitle();
            },
        };
        menu.addItem(pinItem);
        menu.addSeparator();
        menu.addItem({
            iconHTML: "",
            label: "删除",
            warning: true,
            click: () => {
                void deleteSession(sessionId);
            },
        });
        menu.open({x: ev.clientX, y: ev.clientY});
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
            btn.addEventListener("contextmenu", (ev) => openSessionContextMenu(s.id, ev));
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
            void (async () => {
                streamRafBySession.delete(streamSessionId);
                if (streamSessionId !== sessions.activeId) {
                    persistSessions();
                    return;
                }
                const msgs = getActive().messages;
                const visibleMsgs = msgs.filter((m) => m.role !== "tool");
                const tail = visibleMsgs[visibleMsgs.length - 1];
                const streamingActive = isActiveSessionStreaming();
                if (streamingActive && tail?.role === "assistant") {
                    const tailIdx = visibleMsgs.length - 1;
                    for (let i = 0; i < visibleMsgs.length; i++) {
                        const m = visibleMsgs[i];
                        const slot = elMessages.children[i] as HTMLElement | undefined;
                        ensureMessageRow(elMessages, m, rowByMessage, slot, rowToMessage);
                        if (i < tailIdx && m.role === "user") {
                            ensureUserMessageEditor(m, rowByMessage.get(m)!);
                        }
                    }
                    const tailSlot = elMessages.children[tailIdx] as HTMLElement | undefined;
                    const tailRow = ensureMessageRow(
                        elMessages,
                        tail,
                        rowByMessage,
                        tailSlot,
                        rowToMessage,
                    );
                    const toolArgsComposing =
                        !!tail.tool_calls?.length &&
                        !(tail._toolStatus && Object.keys(tail._toolStatus).length > 0);
                    if (toolArgsComposing && !tail._mdStreaming) {
                        patchAssistantToolCallsOnly(tailRow, tail);
                    } else {
                        const luteRes = getLuteResult();
                        const showActions = isRoundTailAssistant(visibleMsgs, tailIdx);
                        if (luteRes.ok) {
                            try {
                                await patchAssistantRow(tailRow, tail, luteRes.lute, isDestroyed, {
                                    showActions,
                                });
                            } catch {
                                patchAssistantRowPlain(tailRow, tail, {showActions});
                            }
                        } else {
                            patchAssistantRowPlain(tailRow, tail, {showActions});
                        }
                    }
                    syncAllAssistantActionsVisibility(visibleMsgs, rowByMessage);
                    const dist =
                        elChatBody.scrollHeight - elChatBody.scrollTop - elChatBody.clientHeight;
                    if (dist < 120) {
                        elChatBody.scrollTop = elChatBody.scrollHeight;
                    }
                    return;
                }
                void renderMessages();
            })();
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
            rowToMessage.clear();
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
        if (!isActiveSessionStreaming()) {
            rowToMessage.clear();
        }

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
            const row = ensureMessageRow(elMessages, m, rowByMessage, slot, rowToMessage);

            if (seq !== renderSeq) {
                continue;
            }

            const streamingActive = isActiveSessionStreaming();
            const isStreamingTail =
                streamingActive && i === visibleMsgs.length - 1 && m.role === "assistant";

            // 流式阶段仅刷新尾部 assistant；user 与历史 assistant 需保留已渲染内容
            if (streamingActive && !isStreamingTail) {
                if (m.role === "user") {
                    ensureUserMessageEditor(m, row);
                }
                continue;
            }

            if (m.role === "user") {
                ensureUserMessageEditor(m, row);
            } else if (m.role === "assistant") {
                const showActions = isRoundTailAssistant(visibleMsgs, i);
                if (lute) {
                    try {
                        await patchAssistantRow(row, m, lute, isDestroyed, {showActions});
                    } catch {
                        patchAssistantRowPlain(row, m, {showActions});
                    }
                } else {
                    patchAssistantRowPlain(row, m, {showActions});
                }
            }

            if (destroyed || seq !== renderSeq) {
                return;
            }
        }

        syncAllAssistantActionsVisibility(visibleMsgs, rowByMessage);

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
        return rowToMessage.get(row);
    };

    /** 该 assistant 之前最近一条 user（跳过同轮 tool / 中间 assistant） */
    const findPrecedingUserMessage = (messages: ChatMessage[], assistantIdx: number): ChatMessage | undefined => {
        for (let i = assistantIdx - 1; i >= 0; i--) {
            const role = messages[i].role;
            if (role === "user") {
                return messages[i];
            }
            if (role !== "tool" && role !== "assistant") {
                break;
            }
        }
        return undefined;
    };

    const getUserMessageSendText = (m: ChatMessage): string => {
        const editor = userEditorByMessage.get(m);
        const fromEditor = editor?.getSendText()?.trim();
        if (fromEditor) {
            return fromEditor;
        }
        const doc = m.composerDoc as JSONContent | undefined;
        if (doc?.type === "doc") {
            const t = composerDocToLlmText(doc).trim();
            if (t) {
                return t;
            }
        }
        return (m.content ?? "").trim();
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
            if (msg.role === "user") {
                destroyUserMessageEditor(msg);
            }
        }
        persistSessions();
    };

    const destroyUserMessageEditor = (m: ChatMessage) => {
        const ed = userEditorByMessage.get(m);
        if (!ed) {
            return;
        }
        ed.destroy();
        userMessageEditors.delete(ed);
        userEditorByMessage.delete(m);
        userEditorDocSigByMessage.delete(m);
    };

    const userMessageComposerDoc = (m: ChatMessage): JSONContent =>
        m.composerDoc && (m.composerDoc as JSONContent).type === "doc"
            ? (m.composerDoc as JSONContent)
            : legacyUserContentToComposerDoc(m.content ?? "");

    const userMessageComposerDocSig = (m: ChatMessage): string => {
        if (m.composerDoc && (m.composerDoc as JSONContent).type === "doc") {
            return `doc:${JSON.stringify(m.composerDoc)}`;
        }
        return `legacy:${m.content ?? ""}`;
    };

    const scheduleUserMessageDraftPersist = (m: ChatMessage) => {
        if (userMessageDraftTimer !== null) {
            clearTimeout(userMessageDraftTimer);
        }
        userMessageDraftTimer = setTimeout(() => {
            userMessageDraftTimer = null;
            persistSessions();
        }, 400);
    };

    const ensureUserMessageEditor = (m: ChatMessage, row: HTMLElement) => {
        const host = row.querySelector("[data-user-editor]") as HTMLElement | null;
        if (!host) {
            return;
        }
        const doc = userMessageComposerDoc(m);
        const docSig = userMessageComposerDocSig(m);
        let editor = userEditorByMessage.get(m);
        if (!editor) {
            editor = mountComposerEditor({
                editorHost: host,
                app: plugin.app,
                kernel,
                placeholder: "",
                sendKeyMode: getSendKeyMode(),
                onSend: () => resendUserMessage(row),
                onDraftChange: () => {
                    m.composerDoc = editor!.getDocumentJSON();
                    userEditorDocSigByMessage.set(m, userMessageComposerDocSig(m));
                    scheduleUserMessageDraftPersist(m);
                },
            });
            userEditorByMessage.set(m, editor);
            userMessageEditors.add(editor);
            editor.setDocumentJSON(doc);
            userEditorDocSigByMessage.set(m, docSig);
            return;
        }
        if (userEditorDocSigByMessage.get(m) !== docSig) {
            editor.setDocumentJSON(doc);
            userEditorDocSigByMessage.set(m, docSig);
        }
    };

    const resendUserMessage = (row: HTMLElement) => {
        const m = findMessageForRow(row);
        if (!m || m.role !== "user") {
            return;
        }
        const editor = userEditorByMessage.get(m);
        const text = getUserMessageSendText(m);
        if (!text) {
            return;
        }
        if (editor) {
            m.composerDoc = editor.getDocumentJSON();
        }
        const doResend = () => void runSend({text, truncateFrom: m, composerDoc: m.composerDoc});
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
        placeholder: "说点什么，或按下 @ 引用文档",
        sendKeyMode: getSendKeyMode(),
        onSend: () => void runSend(),
        onDraftChange: scheduleComposerDraftPersist,
    });

    restoreComposerDraft();

    const runSend = async (opts?: {
        text?: string;
        truncateFrom?: ChatMessage;
        composerDoc?: ChatMessage["composerDoc"];
    }) => {
        const text = (opts?.text ?? composerEditor.getSendText()).trim();
        if (!text) {
            return;
        }
        const pendingUserComposerDoc: JSONContent | undefined = opts?.composerDoc
            ? (opts.composerDoc as JSONContent)
            : !opts?.text
                ? composerEditor.getDocumentJSON()
                : undefined;
        let attachedUserComposerDoc = false;
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
        const attachPendingUserComposerDoc = () => {
            if (!pendingUserComposerDoc || attachedUserComposerDoc) {
                return;
            }
            const msgs = getSessionById(sendSessionId)?.messages ?? sess.messages;
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === "user") {
                    msgs[i].composerDoc = pendingUserComposerDoc;
                    attachedUserComposerDoc = true;
                    return;
                }
            }
        };
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
        requestSessionTitleSummary(
            sendSessionId,
            text,
            pendingUserComposerDoc as ChatMessage["composerDoc"] | undefined,
        );

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
                    attachPendingUserComposerDoc();
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

    const regenerateFromAssistantRow = (row: HTMLElement) => {
        const assistantMsg = findMessageForRow(row);
        if (!assistantMsg || assistantMsg.role !== "assistant") {
            return;
        }
        const s = getActive();
        const idx = s.messages.indexOf(assistantMsg);
        if (idx < 0) {
            return;
        }
        const userMsg = findPrecedingUserMessage(s.messages, idx);
        const text = userMsg ? getUserMessageSendText(userMsg) : "";
        if (!userMsg || !text) {
            plugin.showPluginMessage("没有可重新生成的消息");
            return;
        }
        const userEditor = userEditorByMessage.get(userMsg);
        if (userEditor) {
            userMsg.composerDoc = userEditor.getDocumentJSON();
        }
        const composerDoc =
            userMsg.composerDoc && (userMsg.composerDoc as JSONContent).type === "doc"
                ? (userMsg.composerDoc as JSONContent)
                : legacyUserContentToComposerDoc(text);
        const doRegen = () => void runSend({text, truncateFrom: userMsg, composerDoc});
        if (isActiveSessionStreaming()) {
            afterAbortAction = doRegen;
            abortSessionRun(sessions.activeId);
            return;
        }
        doRegen();
    };

    const exportFromAssistantRow = (row: HTMLElement) => {
        const assistantMsg = findMessageForRow(row);
        if (!assistantMsg || assistantMsg.role !== "assistant") {
            return;
        }
        const s = getActive();
        const idx = s.messages.indexOf(assistantMsg);
        if (idx < 0) {
            return;
        }
        const safeTitle = s.title.replace(/[/\\?%*:|"<>]/g, "_");
        downloadTextFile(
            `${safeTitle}.md`,
            sessionToMarkdown(s, s.messages.slice(0, idx + 1)),
        );
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
    elMessages.addEventListener("mousedown", (e) => {
        if (e.button !== 0) {
            return;
        }
        const row = (e.target as HTMLElement).closest(".agent-msg--user") as HTMLElement | null;
        if (!row) {
            return;
        }
        const t = e.target as HTMLElement;
        if (t.closest(".agent-msg__editor") || t.closest("[data-user-resend]")) {
            return;
        }
        const um = findMessageForRow(row);
        if (um) {
            userEditorByMessage.get(um)?.focus();
        }
    });
    elMessages.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target.closest("[data-regenerate-assistant]")) {
            const row = target.closest(".agent-msg--assistant") as HTMLElement | null;
            if (row) {
                regenerateFromAssistantRow(row);
            }
            return;
        }
        if (target.closest("[data-export-assistant]")) {
            const row = target.closest(".agent-msg--assistant") as HTMLElement | null;
            if (row) {
                exportFromAssistantRow(row);
            }
            return;
        }
        const btn = target.closest("[data-user-resend]");
        if (!btn) {
            return;
        }
        const row = btn.closest(".agent-msg--user") as HTMLElement | null;
        if (row) {
            resendUserMessage(row);
        }
    });
    root.querySelector("[data-open-settings]")?.addEventListener("click", () => plugin.openSetting());

    elSessionSearch.addEventListener("input", (e) => {
        sessionFilter = (e.target as HTMLInputElement).value;
        renderSessionList();
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
        titleSummaryInFlight.clear();
        streamRafBySession.forEach((raf) => cancelAnimationFrame(raf));
        streamRafBySession.clear();
        abortAllAgentSessions();
        modeDropdown.destroy();
        modelDropdown.destroy();
        flushComposerDraft();
        composerEditor.destroy();
        for (const ed of userMessageEditors) {
            ed.destroy();
        }
        userMessageEditors.clear();
        if (userMessageDraftTimer !== null) {
            clearTimeout(userMessageDraftTimer);
            userMessageDraftTimer = null;
        }
        if (composerDraftTimer !== null) {
            clearTimeout(composerDraftTimer);
            composerDraftTimer = null;
        }
        root.removeEventListener("click", onShellClick);
        offMessages();
        offStream();
        offSettingsChange();
        shellCleanups.delete(root);
    };
    shellCleanups.set(root, cleanup);
    return cleanup;
}
