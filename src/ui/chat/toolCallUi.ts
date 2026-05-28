import type {ChatMessage, OpenAiToolCallChunk} from "../../agent/types";
import {scrollDiffToFirstChange} from "../../editor/diffEngine";
import {readSessionIdFromMessagesEl, resolveInlineToolDiff} from "./inlineToolActions";
import {compactKernelResponseText} from "../../tools/truncate";
import {buildToolCallStreamPreview} from "./toolCallStreamPreview";

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function formatArgs(args: string): string {
    const raw = args?.trim() || "{}";
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
}

function formatToolResultPreview(name: string, text: string): string {
    try {
        const o = JSON.parse(text) as Record<string, unknown>;
        if (name === "open_document") {
            const hl = o.highlight ? "（已高亮）" : "";
            return o.ok ? `已打开 ${String(o.id ?? "")}${hl}` : text;
        }
        if (name === "focus_block") {
            return o.ok ? `已聚焦到块 ${String(o.id ?? "")}` : text;
        }
        if (name === "edit_document") {
            if (o.reason === "user_rejected") {
                return "用户已在预览中拒绝更改";
            }
            if (o.reason === "no_changes") {
                return "文档无变更";
            }
            if (o.applied) {
                const s = o.summary as {adds?: number; removes?: number} | undefined;
                return `已应用更改（+${s?.adds ?? 0} / -${s?.removes ?? 0} 行）`;
            }
        }
        if (name === "create_document") {
            if (o.code === 0 || o.ok) {
                return `已创建文档 ${String(o.path ?? o.id ?? "")}`;
            }
        }
        if (name === "delete_document") {
            if (o.code === 0 || o.ok) {
                const refNote = o.hadRefs ? "（该文档曾被引用）" : "";
                return `已从笔记本删除文档${refNote}`;
            }
        }
        return compactKernelResponseText(o);
    } catch {
        return text;
    }
}

/** 该 tool call 的参数 JSON 是否仍在流式生成中 */
function isToolCallArgsComposing(
    tc: OpenAiToolCallChunk,
    llmStreaming: boolean,
    m: ChatMessage,
): boolean {
    if (!llmStreaming) {
        return false;
    }
    if (m._toolStatus?.[tc.id]) {
        return false;
    }
    const preview = buildToolCallStreamPreview(tc.function.name, tc.function.arguments ?? "");
    return !preview.parseComplete;
}

function isLongFieldLabel(label: string, value: string): boolean {
    return (
        label.includes("Markdown") ||
        label.includes("正文") ||
        label.includes("批量") ||
        label === "SQL" ||
        value.length > 200 ||
        value.includes("\n")
    );
}

const STREAMING_PRE_THROTTLE_MS = 80;
const STREAMING_PRE_MIN_CHARS = 180;
const STREAMING_FIELD_PREVIEW_CHARS = 12_000;

const lastPrePatchAt = new WeakMap<HTMLPreElement, number>();

/** 流式阶段长文本降频刷新，减轻主线程压力 */
function patchPreText(pre: HTMLPreElement, next: string, streaming = false): void {
    const prev = pre.textContent ?? "";
    if (prev === next) {
        return;
    }
    if (streaming && next.length >= STREAMING_PRE_MIN_CHARS) {
        const now = performance.now();
        const last = lastPrePatchAt.get(pre) ?? 0;
        if (now - last < STREAMING_PRE_THROTTLE_MS) {
            return;
        }
        lastPrePatchAt.set(pre, now);
    }
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 28;
    const scrollTop = pre.scrollTop;
    pre.textContent = next;
    if (atBottom) {
        pre.scrollTop = pre.scrollHeight;
    } else {
        pre.scrollTop = scrollTop;
    }
}

function previewStreamingFieldValue(value: string, streaming: boolean): string {
    if (!streaming || value.length <= STREAMING_FIELD_PREVIEW_CHARS) {
        return value;
    }
    return `${value.slice(0, STREAMING_FIELD_PREVIEW_CHARS)}\n…（共 ${value.length.toLocaleString()} 字符）`;
}

function isGenericProgressHint(text: string): boolean {
    return text === "执行中…" || text === "等待执行…";
}

function patchSummaryStatus(
    summary: HTMLElement,
    composing: boolean,
    status: string | undefined,
): void {
    let iconEl = summary.querySelector(".agent-tool-card__icon") as HTMLElement | null;
    if (!iconEl) {
        iconEl = summary.querySelector(".agent-spinner") as HTMLElement | null;
        if (iconEl) {
            iconEl.classList.add("agent-tool-card__icon");
        }
    }
    if (!iconEl) {
        iconEl = document.createElement("span");
        iconEl.className = "agent-tool-card__icon agent-spinner";
        summary.insertBefore(iconEl, summary.firstChild);
    }
    const spinning = composing || status === "running" || !status;
    if (spinning) {
        if (!iconEl.classList.contains("agent-spinner")) {
            iconEl.className = "agent-tool-card__icon agent-spinner";
            iconEl.textContent = "";
        }
    } else if (status === "ok") {
        iconEl.className = "agent-tool-card__icon";
        if (iconEl.textContent !== "✓") {
            iconEl.textContent = "✓";
        }
    } else {
        iconEl.className = "agent-tool-card__icon";
        if (iconEl.textContent !== "✗") {
            iconEl.textContent = "✗";
        }
    }

    let nameEl = summary.querySelector(".agent-tool-card__name") as HTMLElement | null;
    if (!nameEl) {
        nameEl = document.createElement("span");
        nameEl.className = "agent-tool-card__name";
        summary.appendChild(nameEl);
    }
}

function patchStatusHint(body: HTMLElement, text: string | null): void {
    const existing = body.querySelector(".agent-tool-card__hint--status") as HTMLParagraphElement | null;
    if (!text) {
        existing?.remove();
        return;
    }
    if (existing) {
        if (existing.textContent !== text) {
            existing.textContent = text;
        }
        return;
    }
    const wait = document.createElement("p");
    wait.className = "agent-tool-card__hint agent-tool-card__hint--status";
    wait.textContent = text;
    body.prepend(wait);
}

function ensureCardBody(card: HTMLDetailsElement): HTMLElement {
    let body = card.querySelector(".agent-tool-card__body") as HTMLElement | null;
    if (!body) {
        body = document.createElement("div");
        body.className = "agent-tool-card__body";
        card.appendChild(body);
    }
    return body;
}

function ensureFieldsSection(body: HTMLElement, labelText: string): HTMLElement {
    let section = body.querySelector(".agent-tool-card__section--fields") as HTMLElement | null;
    if (!section) {
        section = document.createElement("div");
        section.className = "agent-tool-card__section agent-tool-card__section--fields";
        section.innerHTML = "<div class=\"agent-tool-card__label\"></div>";
        const list = document.createElement("dl");
        list.className = "agent-tool-card__fields";
        section.appendChild(list);
        body.appendChild(section);
    }
    const label = section.querySelector(".agent-tool-card__label")!;
    label.textContent = labelText;
    return section;
}

function patchPreviewFields(
    body: HTMLElement,
    toolName: string,
    argsJson: string,
    composing: boolean,
): void {
    const preview = buildToolCallStreamPreview(toolName, argsJson);
    body.querySelector(".agent-tool-card__hint")?.remove();
    const labelText = "参数";

    if (preview.fields.length === 0) {
        body.querySelector(".agent-tool-card__section--fields")?.remove();
        const showRaw = !composing || argsJson.trim().length > 0;
        if (showRaw) {
            let fallback = body.querySelector(".agent-tool-card__section--raw") as HTMLElement | null;
            if (!fallback) {
                fallback = document.createElement("div");
                fallback.className = "agent-tool-card__section agent-tool-card__section--raw";
                fallback.innerHTML = "<div class=\"agent-tool-card__label\">参数</div>";
                const pre = document.createElement("pre");
                fallback.appendChild(pre);
                body.appendChild(fallback);
            }
            const label = fallback.querySelector(".agent-tool-card__label")!;
            label.textContent = "参数";
            const display = composing ? argsJson.trim() || "{}" : formatArgs(argsJson);
            patchPreText(fallback.querySelector("pre")!, display, composing);
        } else {
            body.querySelector(".agent-tool-card__section--raw")?.remove();
        }
        return;
    }

    body.querySelector(".agent-tool-card__section--raw")?.remove();
    const section = ensureFieldsSection(body, labelText);
    const list = section.querySelector(".agent-tool-card__fields")!;

    const fieldKey = (label: string) => label.replace(/\s*·\s*$/, "").split("（")[0]!.trim();
    const existing = new Map<string, {dt: HTMLElement; dd: HTMLElement}>();
    for (const dt of list.querySelectorAll("dt")) {
        const dd = dt.nextElementSibling as HTMLElement | null;
        const key = dt.getAttribute("data-field-key");
        if (dd && key) {
            existing.set(key, {dt, dd});
        }
    }

    const usedKeys = new Set<string>();
    for (const f of preview.fields) {
        const key = fieldKey(f.label);
        const countSuffix = f.value.length > 200 ? `（${f.value.length} 字符）` : "";
        const dtLabel = `${f.label}${countSuffix}`;

        let row = existing.get(key);
        if (!row) {
            const dt = document.createElement("dt");
            dt.setAttribute("data-field-key", key);
            dt.textContent = dtLabel;
            const dd = document.createElement("dd");
            list.appendChild(dt);
            list.appendChild(dd);
            row = {dt, dd};
        } else {
            row.dt.textContent = dtLabel;
        }
        usedKeys.add(key);

        if (isLongFieldLabel(f.label, f.value)) {
            let pre = row.dd.querySelector(".agent-tool-card__field-pre") as HTMLPreElement | null;
            if (!pre) {
                row.dd.replaceChildren();
                pre = document.createElement("pre");
                pre.className = "agent-tool-card__field-pre";
                row.dd.appendChild(pre);
            }
            const display = previewStreamingFieldValue(f.value, !!f.streaming);
            patchPreText(pre, display, !!f.streaming);
        } else {
            const display = previewStreamingFieldValue(f.value, !!f.streaming);
            if (row.dd.textContent !== display) {
                row.dd.textContent = display;
            }
        }
    }

    for (const [key, row] of existing) {
        if (!usedKeys.has(key)) {
            row.dt.remove();
            row.dd.remove();
        }
    }
}

function patchDiffBlock(
    body: HTMLElement,
    sessionId: string,
    toolCallId: string,
    diff: NonNullable<ChatMessage["_toolDiff"]>[string],
): void {
    let block = body.querySelector(".agent-tool-card__diff") as HTMLElement | null;
    if (diff.status !== "pending") {
        block?.remove();
        return;
    }
    if (!block) {
        block = document.createElement("div");
        block.className = "agent-tool-card__diff";
        block.innerHTML = `
<div class="agent-tool-card__diff-head"></div>
<div class="agent-tool-card__diff-body agent-diff"></div>
<div class="agent-tool-card__confirm-actions fn__flex">
  <span class="fn__flex-1 agent-tool-card__diff-hint">灰 = 删除，绿 = 新增；未改行默认折叠</span>
  <button type="button" class="b3-button b3-button--cancel" data-reject>拒绝</button>
  <button type="button" class="b3-button b3-button--text" data-approve>应用</button>
</div>`;
        const approve = block.querySelector("[data-approve]") as HTMLButtonElement;
        const reject = block.querySelector("[data-reject]") as HTMLButtonElement;
        approve.addEventListener("click", () => resolveInlineToolDiff(sessionId, toolCallId, true));
        reject.addEventListener("click", () => resolveInlineToolDiff(sessionId, toolCallId, false));
        body.appendChild(block);
    }
    const head = block.querySelector(".agent-tool-card__diff-head")!;
    if (head.textContent !== diff.title) {
        head.textContent = diff.title;
    }
    const bodyEl = block.querySelector(".agent-tool-card__diff-body")!;
    const htmlChanged = bodyEl.innerHTML !== diff.html;
    if (htmlChanged) {
        bodyEl.innerHTML = diff.html;
        bodyEl.removeAttribute("data-diff-scrolled");
    }
    if (!bodyEl.hasAttribute("data-diff-scrolled")) {
        bodyEl.setAttribute("data-diff-scrolled", "1");
        requestAnimationFrame(() => {
            requestAnimationFrame(() => scrollDiffToFirstChange(bodyEl));
        });
    }
}

function patchResultBlock(body: HTMLElement, toolName: string, result: string | undefined): void {
    if (!result) {
        body.querySelector(".agent-tool-card__section--result")?.remove();
        return;
    }
    let block = body.querySelector(".agent-tool-card__section--result") as HTMLElement | null;
    if (!block) {
        block = document.createElement("div");
        block.className = "agent-tool-card__section agent-tool-card__section--result";
        block.innerHTML = "<div class=\"agent-tool-card__label\">结果</div>";
        const pre = document.createElement("pre");
        block.appendChild(pre);
        body.appendChild(block);
    }
    patchPreText(block.querySelector("pre")!, formatToolResultPreview(toolName, result));
}

function patchToolCard(
    card: HTMLDetailsElement,
    tc: OpenAiToolCallChunk,
    m: ChatMessage,
    composing: boolean,
    sessionId: string,
): void {
    const status = m._toolStatus?.[tc.id];
    const hint = m._toolHint?.[tc.id];
    const result = m._toolResults?.[tc.id];
    const confirm = m._toolConfirm?.[tc.id];
    const diff = m._toolDiff?.[tc.id];
    const argsJson = tc.function.arguments ?? "";
    const awaitingDiff = diff?.status === "pending";

    const summary = card.querySelector("summary");
    if (summary) {
        patchSummaryStatus(summary, composing, status);
        const nameEl = summary.querySelector(".agent-tool-card__name") as HTMLElement | null;
        if (nameEl && nameEl.textContent !== tc.function.name) {
            nameEl.textContent = tc.function.name;
        }
    }

    const body = ensureCardBody(card);

    if (confirm?.status === "pending") {
        if (summary) {
            patchSummaryStatus(summary, false, "running");
        }
        patchStatusHint(body, "等待下方「待确认」区域");
    } else if (diff?.status === "pending") {
        if (summary) {
            patchSummaryStatus(summary, false, "running");
        }
        patchStatusHint(body, "请查看下方 diff 并选择是否应用");
    } else if (confirm?.status === "rejected") {
        patchStatusHint(body, "已拒绝执行");
    } else if (hint && !isGenericProgressHint(hint)) {
        patchStatusHint(body, hint);
    } else {
        patchStatusHint(body, null);
    }

    patchPreviewFields(body, tc.function.name, argsJson, composing && !awaitingDiff);

    body.querySelector(".agent-tool-card__confirm")?.remove();

    if (diff) {
        patchDiffBlock(body, sessionId, tc.id, diff);
    } else {
        body.querySelector(".agent-tool-card__diff")?.remove();
    }

    patchResultBlock(body, tc.function.name, result);
}

function createToolCard(toolName: string, toolCallId: string): HTMLDetailsElement {
    const card = document.createElement("details");
    card.className = "agent-tool-card";
    card.dataset.toolCallId = toolCallId;
    card.innerHTML =
        `<summary><span class="agent-tool-card__icon agent-spinner"></span> <span class="agent-tool-card__name">${escapeHtml(toolName)}</span></summary>`;
    return card;
}

export interface RenderToolCallsOptions {
    /** 所属会话 id（缺省时从 data-messages 读取） */
    sessionId?: string;
    /** LLM 仍在流式输出 assistant（含 tool call JSON 生成阶段） */
    llmStreaming?: boolean;
}

/** 增量更新工具卡片 DOM，避免 replaceChildren 导致正文区连带重绘与滚动丢失 */
export function renderAssistantToolCalls(
    host: HTMLElement,
    m: ChatMessage,
    options: RenderToolCallsOptions = {},
): void {
    if (!m.tool_calls?.length) {
        host.replaceChildren();
        host.hidden = true;
        return;
    }
    host.hidden = false;

    const sessionId = options.sessionId ?? readSessionIdFromMessagesEl(host);
    if (!sessionId) {
        return;
    }

    const llmStreaming = options.llmStreaming === true;
    const seen = new Set<string>();

    for (const tc of m.tool_calls) {
        const id = tc.id || `${tc.function.name}:${seen.size}`;
        seen.add(id);
        let card = host.querySelector(`[data-tool-call-id="${CSS.escape(id)}"]`) as HTMLDetailsElement | null;
        if (!card) {
            card = createToolCard(tc.function.name, id);
            host.appendChild(card);
        }
        patchToolCard(card, tc, m, isToolCallArgsComposing(tc, llmStreaming, m), sessionId);
    }

    for (const old of host.querySelectorAll(".agent-tool-card")) {
        const id = (old as HTMLElement).dataset.toolCallId;
        if (id && !seen.has(id)) {
            old.remove();
        }
    }
}
