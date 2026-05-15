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
    getMd2BlockDomLute,
    getStreamingAssistantMdParts,
    type LuteEngine,
} from "./streamMdRender";
import {postRenderMarkdownRootsInTypographyHost} from "./typographyPostRender";
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
    /** 与 `abortCtl !== null` 对齐；流式从 true→false 时需再跑一轮以补尾部后处理 */
    streamOpen: boolean;
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
    const {i18n} = plugin;

    dockElement.innerHTML = `<div class="plugin-agent-dock fn__flex-column">
  <div class="plugin-agent-dock__toolbar fn__flex">
    <button type="button" class="b3-button b3-button--outline" data-action="add-doc">${
        esc(i18n.agentAddWorkset)
    }</button>
    <button type="button" class="b3-button b3-button--outline" data-action="clear-ws">${
        esc(i18n.agentClearWorkset)
    }</button>
    <button type="button" class="b3-button b3-button--outline" data-action="clear-chat">${
        esc(i18n.agentClearChat)
    }</button>
  </div>
  <div class="plugin-agent-dock__workset b3-label__text" data-workset></div>
  <details class="plugin-agent-dock__audit">
    <summary>${esc(i18n.agentAuditLog)}</summary>
    <pre class="plugin-agent-dock__audit-pre" data-audit></pre>
  </details>
  <div class="plugin-agent-dock__messages fn__flex-1" data-messages></div>
  <div class="plugin-agent-dock__input-row fn__flex">
    <textarea class="b3-text-field fn__flex-1" rows="3" data-input placeholder="${
        esc(i18n.agentInputPlaceholder)
    }"></textarea>
    <div class="plugin-agent-dock__send-col fn__flex-column">
      <button type="button" class="b3-button b3-button--text" data-send>${esc(i18n.agentSend)}</button>
      <button type="button" class="b3-button b3-button--cancel" data-stop disabled>${
        esc(i18n.agentStop)
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
    /** 避免异步 `renderMessages` 交叠时旧帧覆盖新内容 */
    let renderMessagesSeq = 0;

    /** 流式尾部：避免同一 `tailHtml` + 封存块数未变时反复置换尾部节点 */
    const tailSyncStateByHost = new WeakMap<HTMLElement, {tailHtml: string; sealedN: number}>();

    /** 与 `host` 子树同步：已封存块顶层节点按序号、当前尾部顶层节点 */
    type AgentMdStreamDom = {
        sealedRoots: Map<number, Element[]>;
        tailRoots: Element[];
    };
    const agentMdStreamDomByHost = new WeakMap<HTMLElement, AgentMdStreamDom>();

    function getAgentMdStreamDom(host: HTMLElement): AgentMdStreamDom {
        let d = agentMdStreamDomByHost.get(host);
        if (!d) {
            d = {sealedRoots: new Map(), tailRoots: []};
            agentMdStreamDomByHost.set(host, d);
        }
        return d;
    }

    /** 第一个「封存序号 ≥ sealedIndex」的块的第一个节点，否则为尾部首节点 */
    function firstBoundaryAtOrAfterSealed(dom: AgentMdStreamDom, sealedIndex: number): Element | null {
        for (let j = sealedIndex; j < 4096; j++) {
            const roots = dom.sealedRoots.get(j);
            if (roots?.length) {
                return roots[0]!;
            }
        }
        return dom.tailRoots[0] ?? null;
    }

    /** 插入封存 HTML，返回本次插入的顶层元素（仅 `Element`） */
    function insertSealedHtmlAsDirectChildren(
        host: HTMLElement,
        dom: AgentMdStreamDom,
        sealedIndex: number,
        html: string,
    ): Element[] {
        const trimmed = html.trim();
        if (!trimmed) {
            dom.sealedRoots.set(sealedIndex, []);
            return [];
        }
        const tpl = document.createElement("template");
        tpl.innerHTML = trimmed;
        const roots: Element[] = [];
        for (const node of Array.from(tpl.content.childNodes)) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                roots.push(node as Element);
            }
        }
        const ref = firstBoundaryAtOrAfterSealed(dom, sealedIndex);
        if (ref) {
            host.insertBefore(tpl.content, ref);
        } else {
            host.append(tpl.content);
        }
        dom.sealedRoots.set(sealedIndex, roots);
        return roots;
    }

    function syncTailDirectChildren(host: HTMLElement, dom: AgentMdStreamDom, tailHtml: string, sealedN: number): void {
        const prev = tailSyncStateByHost.get(host);
        if (prev && prev.tailHtml === tailHtml && prev.sealedN === sealedN) {
            return;
        }
        for (const el of dom.tailRoots) {
            el.remove();
        }
        dom.tailRoots = [];
        const trimmed = tailHtml.trim();
        if (trimmed) {
            const tpl = document.createElement("template");
            tpl.innerHTML = trimmed;
            for (const node of Array.from(tpl.content.childNodes)) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    dom.tailRoots.push(node as Element);
                }
            }
            host.append(tpl.content);
        }
        tailSyncStateByHost.set(host, {tailHtml, sealedN});
    }

    const scheduleStreamRender = () => {
        if (streamRenderRaf) {
            return;
        }
        streamRenderRaf = requestAnimationFrame(() => {
            streamRenderRaf = 0;
            void renderMessages();
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
            elWorkset.textContent = i18n.agentWorksetEmpty;
            return;
        }
        elWorkset.innerHTML = `<span class="b3-label__text">${esc(i18n.agentWorksetLabel)}：</span>` +
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
        empty.textContent = i18n.agentNoMessages;
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
        const footer = document.createElement("div");
        footer.className = "plugin-agent-msg__footer";
        footer.dataset.part = "footer";
        const btnCopyMd = document.createElement("button");
        btnCopyMd.type = "button";
        btnCopyMd.className = "b3-button b3-button--text";
        btnCopyMd.dataset.copyMd = "1";
        btnCopyMd.textContent = i18n.agentCopyMd;
        footer.appendChild(btnCopyMd);
        wrap.append(role, reasoningHost, body, tools, footer);
        return wrap;
    }

    /**
     * 已封存的顶层块：将 HTML 解析为 `host` 的多个直接子节点；封存与尾部的顶层 `Element` 由 `agentMdStreamDomByHost` 记录。
     */
    async function syncStreamingMdHost(
        host: HTMLElement,
        m: ChatMessage,
        fullMd: string,
        lute: LuteEngine,
        kind: "content" | "reasoning",
        streamOpen: boolean,
    ): Promise<void> {
        const {sealedHtmlParts, tailHtml} = await getStreamingAssistantMdParts(m, fullMd, lute, kind);
        const n = sealedHtmlParts.length;

        const dom = getAgentMdStreamDom(host);

        let sealedRemoved = false;
        for (const idx of [...dom.sealedRoots.keys()]) {
            if (idx >= n) {
                const roots = dom.sealedRoots.get(idx)!;
                for (const el of roots) {
                    el.remove();
                }
                dom.sealedRoots.delete(idx);
                sealedRemoved = true;
            }
        }
        if (sealedRemoved) {
            tailSyncStateByHost.delete(host);
        }

        for (let i = 0; i < n; i++) {
            const html = sealedHtmlParts[i];
            if (dom.sealedRoots.has(i)) {
                continue;
            }
            const roots = insertSealedHtmlAsDirectChildren(host, dom, i, html);
            if (roots.length > 0) {
                postRenderMarkdownRootsInTypographyHost(roots, host);
            }
        }

        syncTailDirectChildren(host, dom, tailHtml, n);

        if (!streamOpen) {
            postRenderMarkdownRootsInTypographyHost(dom.tailRoots, host);
        }
    }

    async function patchAssistantRow(row: HTMLElement, m: ChatMessage, lute: LuteEngine): Promise<void> {
        const reasoningRaw = m.reasoning_content != null && m.reasoning_content !== "" ?
            String(m.reasoning_content) :
            "";
        const toolsSig = m.tool_calls?.map((t) => `${t.function.name}(${t.function.arguments})`).join("\n") ?? "";
        const contentRaw = m.content ?? "";
        const streamOpen = abortCtl !== null;
        const prev = (row as unknown as Record<string, LastAssistantPatch | undefined>)[lastAssistantPatchKey];
        if (
            prev &&
            prev.content === contentRaw &&
            prev.reasoning === reasoningRaw &&
            prev.toolsSig === toolsSig &&
            prev.streamOpen === streamOpen
        ) {
            return;
        }
        (row as unknown as Record<string, LastAssistantPatch>)[lastAssistantPatchKey] = {
            content: contentRaw,
            reasoning: reasoningRaw,
            toolsSig,
            streamOpen,
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
            agentMdStreamDomByHost.delete(reasoningHost);
        } else {
            reasoningHost.className =
                "plugin-agent-msg__reasoning-host plugin-agent-msg__reasoning b3-typography b3-typography--default";
            // 正文一旦出现输出，将推理通道仍留在 tail 的 Markdown 一次性封存（幂等），避免 tail 每帧随 RAF 重绘
            if (contentRaw.length > 0) {
                await finalizeStreamingMdRemainder(m, reasoningRaw, lute, "reasoning");
            }
            await syncStreamingMdHost(reasoningHost, m, reasoningRaw, lute, "reasoning", streamOpen);
        }

        bodyEl.className = "plugin-agent-msg__body b3-typography b3-typography--default";
        await syncStreamingMdHost(bodyEl, m, contentRaw, lute, "content", streamOpen);

        if (toolsSig) {
            toolsEl.hidden = false;
            toolsEl.textContent = toolsSig;
        } else {
            toolsEl.hidden = true;
            toolsEl.textContent = "";
        }
    }

    async function buildMessageRow(m: ChatMessage, lute: LuteEngine): Promise<HTMLElement> {
        if (m.role === "user") {
            return buildUserRow(m);
        }
        if (m.role === "tool") {
            return buildToolRow(m);
        }
        if (m.role === "assistant") {
            const row = buildAssistantRow();
            const btnCopyMd = row.querySelector("[data-copy-md]") as HTMLButtonElement | null;
            if (btnCopyMd) {
                btnCopyMd.addEventListener("click", () => {
                    const md = m.content ?? "";
                    void navigator.clipboard.writeText(md).then(
                        () => showMessage(i18n.agentCopiedMd),
                        () => showMessage(i18n.agentCopyFailed),
                    );
                });
            }
            await patchAssistantRow(row, m, lute);
            return row;
        }
        const fallback = document.createElement("div");
        fallback.className = "plugin-agent-msg";
        fallback.textContent = m.role;
        return fallback;
    }

    async function patchMessageRow(row: HTMLElement, m: ChatMessage, lute: LuteEngine): Promise<void> {
        if (m.role === "user") {
            patchUserRow(row, m);
        } else if (m.role === "tool") {
            patchToolRow(row, m);
        } else if (m.role === "assistant") {
            await patchAssistantRow(row, m, lute);
        }
    }

    async function renderMessages(): Promise<void> {
        const seq = ++renderMessagesSeq;
        if (!chatMessages.length) {
            renderEmptyMessagesPlaceholder();
            elMessages.scrollTop = 0;
            return;
        }

        elMessages.querySelector("[data-agent-placeholder]")?.remove();

        const lute = getMd2BlockDomLute();

        while (elMessages.lastElementChild && elMessages.children.length > chatMessages.length) {
            elMessages.removeChild(elMessages.lastElementChild);
        }

        for (let i = 0; i < chatMessages.length; i++) {
            const m = chatMessages[i];
            const slot = elMessages.children[i] as HTMLElement | undefined;
            let row = rowByMessage.get(m);

            if (row && slot === row) {
                await patchMessageRow(row, m, lute);
                continue;
            }

            if (row && slot !== row) {
                elMessages.insertBefore(row, slot ?? null);
                await patchMessageRow(row, m, lute);
                continue;
            }

            row = await buildMessageRow(m, lute);
            rowByMessage.set(m, row);
            if (slot) {
                elMessages.replaceChild(row, slot);
            } else {
                elMessages.appendChild(row);
            }
        }

        if (seq !== renderMessagesSeq) {
            return;
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
    void renderMessages();

    dockElement.querySelector('[data-action="add-doc"]')?.addEventListener("click", () => {
        const eds = getAllEditor();
        if (!eds.length) {
            showMessage(i18n.agentOpenDocFirst);
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
        void renderMessages();
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
            showMessage(i18n.agentNeedApiKey);
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
                showMessage(`${i18n.agentError}: ${msg}`);
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
            void renderMessages();
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
