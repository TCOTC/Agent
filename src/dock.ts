import type Agent from "./index";
import {runAgentLoop} from "./agent/agentLoop";
import {
    STORAGE_KEY_SETTINGS,
} from "./settings/storage";
import type {
    AuditEvent,
    ChatMessage,
} from "./agent/types";
import type {PersistedSettings} from "./settings/types";
import {
    finalizeStreamingMdRemainder,
    forgetStreamMdCache,
    getStreamingAssistantMdParts,
} from "./render/streamMdRender";
import {renderProtyleBlock} from "./render/protyleBlockRender";
import {getLuteResult, type LuteEngine} from "./render/lute";

function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

const lastAssistantPatchKey = "__assistantRowPatch" as const;

type LastAssistantPatch = {
    content: string;
    reasoning: string;
    toolsSig: string;
    /** 与 `abortCtl !== null` 对齐；流式从 true→false 时需再跑一轮以补尾部后处理 */
    streamOpen: boolean;
};

/**
 * 在 Dock 面板挂载方案 A 的聊天 UI。
 * @returns 幂等 destroy：中止进行中的请求、取消待执行的流式 RAF，并阻止后续 DOM 更新。
 */
export function mountDockPanel(plugin: Agent, dockElement: HTMLElement): () => void {
    const {i18n} = plugin;

    dockElement.innerHTML = `<div class="jcag-dock fn__flex-column">
  <div class="jcag-dock__toolbar fn__flex">
    <button type="button" class="b3-button b3-button--outline" data-action="clear-chat">${
        esc(i18n.clearChat)
    }</button>
  </div>
  <details class="jcag-dock__audit">
    <summary>${esc(i18n.runLog)}</summary>
    <pre class="jcag-dock__audit-pre" data-audit></pre>
  </details>
  <div class="jcag-dock__messages fn__flex-1" data-messages></div>
  <div class="jcag-dock__input-row fn__flex">
    <textarea class="b3-text-field fn__flex-1" rows="3" data-input placeholder="${
        esc(i18n.inputPlaceholder)
    }"></textarea>
    <div class="jcag-dock__send-col fn__flex-column">
      <button type="button" class="b3-button b3-button--text" data-send>${esc(i18n.send)}</button>
      <button type="button" class="b3-button b3-button--cancel" data-stop disabled>${
        esc(i18n.stop)
    }</button>
    </div>
  </div>
</div>`;

    const elAudit = dockElement.querySelector("[data-audit]") as HTMLElement;
    const elMessages = dockElement.querySelector("[data-messages]") as HTMLElement;
    const elInput = dockElement.querySelector("[data-input]") as HTMLTextAreaElement;
    const btnSend = dockElement.querySelector("[data-send]") as HTMLButtonElement;
    const btnStop = dockElement.querySelector("[data-stop]") as HTMLButtonElement;

    const chatMessages: ChatMessage[] = [];
    /** 每条内存中的消息对应一行 DOM，流式时只更新该行子节点 */
    const rowByMessage = new WeakMap<ChatMessage, HTMLElement>();
    let abortCtl: AbortController | null = null;
    let streamRenderRaf = 0;
    /** destroy 后置为 true，并与 `renderMessagesSeq` 递增共同掐断异步渲染链 */
    let dockDestroyed = false;
    /** 避免异步 `renderMessages` 交叠时旧帧覆盖新内容 */
    let renderMessagesSeq = 0;

    /** 流式尾部：避免同一 `tailHtml` + 封存块数未变时反复置换尾部节点 */
    const tailSyncStateByBlocksRoot = new WeakMap<HTMLElement, {tailHtml: string; sealedN: number}>();

    /** 与 `blocksRoot` 子树同步：已封存块顶层节点按序号、当前尾部顶层节点 */
    type StreamingMdDom = {
        sealedBlocks: Map<number, Element[]>;
        tailBlocks: Element[];
    };
    const streamingMdDomByBlocksRoot = new WeakMap<HTMLElement, StreamingMdDom>();

    function getStreamingMdDomForRoot(blocksRoot: HTMLElement): StreamingMdDom {
        let d = streamingMdDomByBlocksRoot.get(blocksRoot);
        if (!d) {
            d = {sealedBlocks: new Map(), tailBlocks: []};
            streamingMdDomByBlocksRoot.set(blocksRoot, d);
        }
        return d;
    }

    /** 将 HTML 字符串解析为 `template.content` 片段及其中的顶层 `Element`（供封存插入与尾部同步共用） */
    function htmlToTopLevelElements(html: string): {fragment: DocumentFragment; blocks: Element[]} {
        const tpl = document.createElement("template");
        const trimmed = html.trim();
        if (!trimmed) {
            return {fragment: tpl.content, blocks: []};
        }
        tpl.innerHTML = trimmed;
        const blocks: Element[] = [];
        for (const node of Array.from(tpl.content.childNodes)) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                blocks.push(node as Element);
            }
        }
        return {fragment: tpl.content, blocks};
    }

    /** 第一个「封存序号 ≥ sealedIndex」的块的第一个节点，否则为尾部首节点 */
    function firstBoundaryAtOrAfterSealed(dom: StreamingMdDom, sealedIndex: number): Element | null {
        for (let j = sealedIndex; j < 4096; j++) {
            const blocks = dom.sealedBlocks.get(j);
            if (blocks?.length) {
                return blocks[0]!;
            }
        }
        return dom.tailBlocks[0] ?? null;
    }

    /** 插入封存 HTML，返回本次插入的顶层元素（仅 `Element`） */
    function insertSealedHtmlAsDirectChildren(
        blocksRoot: HTMLElement,
        dom: StreamingMdDom,
        sealedIndex: number,
        html: string,
    ): Element[] {
        const {fragment, blocks} = htmlToTopLevelElements(html);
        if (blocks.length === 0) {
            dom.sealedBlocks.set(sealedIndex, []);
            return [];
        }
        const ref = firstBoundaryAtOrAfterSealed(dom, sealedIndex);
        if (ref) {
            blocksRoot.insertBefore(fragment, ref);
        } else {
            blocksRoot.append(fragment);
        }
        dom.sealedBlocks.set(sealedIndex, blocks);
        return blocks;
    }

    function syncTailDirectChildren(blocksRoot: HTMLElement, dom: StreamingMdDom, tailHtml: string, sealedN: number): void {
        const prev = tailSyncStateByBlocksRoot.get(blocksRoot);
        if (prev && prev.tailHtml === tailHtml && prev.sealedN === sealedN) {
            return;
        }
        for (const el of dom.tailBlocks) {
            el.remove();
        }
        const {fragment, blocks} = htmlToTopLevelElements(tailHtml);
        dom.tailBlocks = blocks;
        if (blocks.length > 0) {
            blocksRoot.append(fragment);
        }
        tailSyncStateByBlocksRoot.set(blocksRoot, {tailHtml, sealedN});
    }

    const scheduleStreamRender = () => {
        if (dockDestroyed) {
            return;
        }
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
        if (dockDestroyed) {
            return;
        }
        let line: string;
        switch (e.kind) {
            case "user_message":
                line = `[user] ${e.preview}`;
                break;
            case "llm_request":
                line = `[llm→] model=${e.model} msgs=${e.messageCount}`;
                break;
            case "llm_response":
                line = `[llm←] ${e.durationMs}ms reason=${e.finishReason ?? "-"}`;
                break;
            case "tool_call":
                line = `[tool] ${e.name}(${e.argsPreview})`;
                break;
            case "tool_result":
                line = `[tool] ${e.name} ${e.ok ? "ok" : "fail"} ${e.durationMs}ms${e.error ? " " + e.error : ""}`;
                break;
            case "tool_blocked":
                line = `[blocked] ${e.name}: ${e.reason}`;
                break;
        }
        auditLines.push(`${new Date().toLocaleTimeString()} ${line}`);
        if (auditLines.length > 200) {
            auditLines.splice(0, auditLines.length - 200);
        }
        elAudit.textContent = auditLines.join("\n");
    };

    /** 一次助手运行失败：弹窗并写入审计（与工具 `tool_blocked` 共用展示形态） */
    const notifyDockRunError = (reason: string) => {
        if (dockDestroyed) {
            return;
        }
        plugin.showPluginMessage(`${i18n.error}: ${reason}`);
        pushAudit({kind: "tool_blocked", name: "assistant", reason});
    };

    /** 消息区仅展示一行占位文案（无消息、Lute 不可用等） */
    function renderMessagesPlaceholder(text: string): void {
        elMessages.replaceChildren();
        const div = document.createElement("div");
        div.className = "b3-label__text";
        div.dataset.jcagPlaceholder = "1";
        div.textContent = text;
        elMessages.appendChild(div);
    }

    /** User / Tool 行：单栏 `pre` 文本，结构一致 */
    function buildSimplePreMessageRow(
        variant: "user" | "tool",
        roleLine: string,
        preText: string,
        preMaxLen?: number,
    ): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = `jcag-msg jcag-msg--${variant}`;
        const role = document.createElement("div");
        role.className = "jcag-msg__role";
        role.textContent = roleLine;
        const pre = document.createElement("pre");
        pre.textContent = preMaxLen ? preText.slice(0, preMaxLen) : preText;
        wrap.append(role, pre);
        return wrap;
    }

    function patchSimplePreMessageRow(row: HTMLElement, preText: string, preMaxLen?: number): void {
        const pre = row.querySelector("pre");
        if (pre) {
            pre.textContent = preMaxLen ? preText.slice(0, preMaxLen) : preText;
        }
    }

    function buildAssistantRow(): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "jcag-msg jcag-msg--assistant";
        const role = document.createElement("div");
        role.className = "jcag-msg__role";
        role.textContent = "Assistant";
        const reasoningHost = document.createElement("div");
        reasoningHost.className = "jcag-msg__reasoning-host";
        const body = document.createElement("div");
        body.dataset.part = "body";
        const tools = document.createElement("pre");
        tools.className = "jcag-msg__tools";
        tools.hidden = true;
        tools.dataset.part = "tools";
        const footer = document.createElement("div");
        footer.className = "jcag-msg__footer";
        footer.dataset.part = "footer";
        const btnCopyMd = document.createElement("button");
        btnCopyMd.type = "button";
        btnCopyMd.className = "b3-button b3-button--text";
        btnCopyMd.dataset.copyMd = "1";
        btnCopyMd.textContent = i18n.copy;
        footer.appendChild(btnCopyMd);
        wrap.append(role, reasoningHost, body, tools, footer);
        return wrap;
    }

    /**
     * 已封存的顶层块：将 HTML 解析为 `blocksRoot` 的多个直接子节点；封存与尾部的顶层 `Element` 由 `streamingMdDomByBlocksRoot` 记录。
     */
    async function syncStreamingMdHost(
        blocksRoot: HTMLElement,
        m: ChatMessage,
        fullMd: string,
        lute: LuteEngine,
        kind: "content" | "reasoning",
        streamOpen: boolean,
    ): Promise<void> {
        if (dockDestroyed) {
            return;
        }
        const {sealedHtmlParts, tailHtml} = await getStreamingAssistantMdParts(m, fullMd, lute, kind);
        if (dockDestroyed) {
            return;
        }
        const n = sealedHtmlParts.length;

        const dom = getStreamingMdDomForRoot(blocksRoot);

        let sealedRemoved = false;
        for (const idx of [...dom.sealedBlocks.keys()]) {
            if (idx >= n) {
                const blocks = dom.sealedBlocks.get(idx)!;
                for (const el of blocks) {
                    el.remove();
                }
                dom.sealedBlocks.delete(idx);
                sealedRemoved = true;
            }
        }
        if (sealedRemoved) {
            tailSyncStateByBlocksRoot.delete(blocksRoot);
        }

        for (let i = 0; i < n; i++) {
            const html = sealedHtmlParts[i];
            if (dom.sealedBlocks.has(i)) {
                continue;
            }
            const blocks = insertSealedHtmlAsDirectChildren(blocksRoot, dom, i, html);
            renderProtyleBlock(blocks, blocksRoot);
        }

        syncTailDirectChildren(blocksRoot, dom, tailHtml, n);

        if (!streamOpen) {
            renderProtyleBlock(dom.tailBlocks, blocksRoot);
        }
    }

    async function patchAssistantRow(row: HTMLElement, m: ChatMessage, lute: LuteEngine): Promise<void> {
        if (dockDestroyed) {
            return;
        }
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

        const reasoningHost = row.querySelector(".jcag-msg__reasoning-host") as HTMLElement | null;
        const bodyEl = row.querySelector("[data-part=\"body\"]") as HTMLElement | null;
        const toolsEl = row.querySelector("[data-part=\"tools\"]") as HTMLPreElement | null;
        if (!reasoningHost || !bodyEl || !toolsEl) {
            return;
        }

        if (!reasoningRaw) {
            reasoningHost.replaceChildren();
            reasoningHost.className = "jcag-msg__reasoning-host";
            streamingMdDomByBlocksRoot.delete(reasoningHost);
        } else {
            reasoningHost.className =
                "jcag-msg__reasoning-host jcag-msg__reasoning b3-typography b3-typography--default";
            // 正文一旦出现输出，将推理通道仍留在 tail 的 Markdown 一次性封存（幂等），避免 tail 每帧随 RAF 重绘
            if (contentRaw.length > 0) {
                await finalizeStreamingMdRemainder(m, reasoningRaw, lute, "reasoning");
                if (dockDestroyed) {
                    return;
                }
            }
            await syncStreamingMdHost(reasoningHost, m, reasoningRaw, lute, "reasoning", streamOpen);
            if (dockDestroyed) {
                return;
            }
        }

        bodyEl.className = "jcag-msg__body b3-typography b3-typography--default";
        await syncStreamingMdHost(bodyEl, m, contentRaw, lute, "content", streamOpen);
        if (dockDestroyed) {
            return;
        }

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
            return buildSimplePreMessageRow("user", "User", m.content ?? "");
        }
        if (m.role === "tool") {
            return buildSimplePreMessageRow("tool", `Tool ${m.tool_call_id ?? ""}`, m.content ?? "", 4000);
        }
        if (m.role === "assistant") {
            const row = buildAssistantRow();
            const btnCopyMd = row.querySelector("[data-copy-md]") as HTMLButtonElement | null;
            if (btnCopyMd) {
                btnCopyMd.addEventListener("click", () => {
                    const md = m.content ?? "";
                    void navigator.clipboard.writeText(md).then(
                        () => plugin.showPluginMessage(i18n.copied),
                        () => plugin.showPluginMessage(i18n.copyFailed),
                    );
                });
            }
            await patchAssistantRow(row, m, lute);
            return row;
        }
        const fallback = document.createElement("div");
        fallback.className = "jcag-msg";
        fallback.textContent = m.role;
        return fallback;
    }

    async function patchMessageRow(row: HTMLElement, m: ChatMessage, lute: LuteEngine): Promise<void> {
        if (m.role === "user") {
            patchSimplePreMessageRow(row, m.content ?? "");
        } else if (m.role === "tool") {
            patchSimplePreMessageRow(row, m.content ?? "", 4000);
        } else if (m.role === "assistant") {
            await patchAssistantRow(row, m, lute);
        }
    }

    async function renderMessages(): Promise<void> {
        if (dockDestroyed) {
            return;
        }
        const seq = ++renderMessagesSeq;
        if (!chatMessages.length) {
            renderMessagesPlaceholder(i18n.noMessages);
            elMessages.scrollTop = 0;
            return;
        }

        elMessages.querySelector("[data-jcag-placeholder]")?.remove();

        const luteRes = getLuteResult();
        if (luteRes.ok === false) {
            renderMessagesPlaceholder(luteRes.message);
            elMessages.scrollTop = elMessages.scrollHeight;
            return;
        }
        const lute = luteRes.lute;

        while (elMessages.lastElementChild && elMessages.children.length > chatMessages.length) {
            elMessages.removeChild(elMessages.lastElementChild);
        }

        for (let i = 0; i < chatMessages.length; i++) {
            if (dockDestroyed || seq !== renderMessagesSeq) {
                return;
            }
            const m = chatMessages[i];
            const slot = elMessages.children[i] as HTMLElement | undefined;
            let row = rowByMessage.get(m);

            if (row && slot === row) {
                await patchMessageRow(row, m, lute);
                if (dockDestroyed || seq !== renderMessagesSeq) {
                    return;
                }
                continue;
            }

            if (row && slot !== row) {
                elMessages.insertBefore(row, slot ?? null);
                await patchMessageRow(row, m, lute);
                if (dockDestroyed || seq !== renderMessagesSeq) {
                    return;
                }
                continue;
            }

            row = await buildMessageRow(m, lute);
            if (dockDestroyed || seq !== renderMessagesSeq) {
                return;
            }
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

    void renderMessages();

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
        const settings = plugin.data[STORAGE_KEY_SETTINGS] as PersistedSettings;
        if (!settings.apiKey) {
            plugin.showPluginMessage(i18n.needApiKey);
            return;
        }
        elInput.value = "";
        abortCtl?.abort();
        abortCtl = new AbortController();
        btnSend.disabled = true;
        btnStop.disabled = false;

        try {
            const outcome = await runAgentLoop({
                llm: {
                    baseUrl: settings.baseUrl,
                    apiKey: settings.apiKey,
                    model: settings.model,
                },
                messages: chatMessages,
                userText: text,
                signal: abortCtl.signal,
                onAudit: pushAudit,
                onStreamDelta: scheduleStreamRender,
            });
            if (outcome.kind === "stopped") {
                const r = outcome.reason;
                let detail: string | undefined;
                switch (r.kind) {
                    case "aborted":
                        break;
                    case "no_response_body":
                        detail = "响应无正文，请检查网络或服务端。";
                        break;
                    case "invalid_openai_response":
                        detail = "模型返回为空，请重试或更换模型。";
                        break;
                    case "http_error":
                        detail = `HTTP ${r.status}: ${r.bodySnippet}`;
                        break;
                    case "network_error":
                        detail = r.message;
                        break;
                }
                if (detail) {
                    notifyDockRunError(detail);
                }
            } else if (outcome.kind === "unexpected_error") {
                notifyDockRunError(outcome.message);
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

    return () => {
        if (dockDestroyed) {
            return;
        }
        dockDestroyed = true;
        renderMessagesSeq++;
        abortCtl?.abort();
        if (streamRenderRaf) {
            cancelAnimationFrame(streamRenderRaf);
            streamRenderRaf = 0;
        }
    };
}
