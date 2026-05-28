import type {ChatMessage, OpenAiToolCallChunk} from "../../agent/types";
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
        if (name === "siyuan_open_document") {
            const hl = o.highlight ? "（已高亮）" : "";
            return o.ok ? `已打开 ${String(o.id ?? "")}${hl}` : text;
        }
        if (name === "siyuan_focus_block") {
            return o.ok ? `已聚焦到块 ${String(o.id ?? "")}` : text;
        }
        if (name === "siyuan_edit_document") {
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
        if (name === "siyuan_create_document") {
            if (o.code === 0 || o.ok) {
                return `已创建文档 ${String(o.path ?? o.id ?? "")}`;
            }
        }
        return JSON.stringify(o, null, 2);
    } catch {
        return text;
    }
}

function hasToolExecutionStarted(m: ChatMessage): boolean {
    return m._toolStatus != null && Object.keys(m._toolStatus).length > 0;
}

function isLongFieldLabel(label: string): boolean {
    return label.includes("Markdown") || label.includes("正文") || label === "SQL";
}

/** 更新 pre 文本并尽量保留滚动位置；跟随尾部时自动滚到底 */
function patchPreText(pre: HTMLPreElement, next: string): void {
    const prev = pre.textContent ?? "";
    if (prev === next) {
        return;
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

function ensureCardBody(card: HTMLDetailsElement): HTMLElement {
    let body = card.querySelector(".agent-tool-card__body") as HTMLElement | null;
    if (!body) {
        body = document.createElement("div");
        body.className = "agent-tool-card__body";
        card.appendChild(body);
    }
    return body;
}

function ensureHint(body: HTMLElement): HTMLParagraphElement {
    let hint = body.querySelector(".agent-tool-card__hint") as HTMLParagraphElement | null;
    if (!hint) {
        hint = document.createElement("p");
        hint.className = "agent-tool-card__hint";
        body.prepend(hint);
    }
    return hint;
}

function ensureFieldsSection(body: HTMLElement, labelText: string): HTMLElement {
    let section = body.querySelector(".agent-tool-card__section--fields") as HTMLElement | null;
    if (!section) {
        section = document.createElement("div");
        section.className = "agent-tool-card__section agent-tool-card__section--fields";
        section.innerHTML = `<div class="agent-tool-card__label"></div>`;
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
    const labelText = composing ? "参数预览" : "参数";

    if (composing) {
        const hint = ensureHint(body);
        hint.hidden = false;
        hint.textContent = preview.parseComplete ? "参数已生成，等待执行…" : "正在流式生成参数…";
    } else {
        body.querySelector(".agent-tool-card__hint")?.remove();
    }

    if (preview.fields.length === 0) {
        body.querySelector(".agent-tool-card__section--fields")?.remove();
        if (!composing) {
            let fallback = body.querySelector(".agent-tool-card__section--raw") as HTMLElement | null;
            if (!fallback) {
                fallback = document.createElement("div");
                fallback.className = "agent-tool-card__section agent-tool-card__section--raw";
                fallback.innerHTML = `<div class="agent-tool-card__label">参数</div>`;
                const pre = document.createElement("pre");
                fallback.appendChild(pre);
                body.appendChild(fallback);
            }
            patchPreText(fallback.querySelector("pre")!, formatArgs(argsJson));
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
        const suffix = f.streaming ? " ·" : "";
        const countSuffix = f.value.length > 200 ? `（${f.value.length} 字符）` : "";
        const dtLabel = `${f.label}${countSuffix}${suffix}`;

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

        if (isLongFieldLabel(f.label)) {
            let pre = row.dd.querySelector(".agent-tool-card__field-pre") as HTMLPreElement | null;
            if (!pre) {
                row.dd.replaceChildren();
                pre = document.createElement("pre");
                pre.className = "agent-tool-card__field-pre";
                row.dd.appendChild(pre);
            }
            patchPreText(pre, f.value);
        } else if (row.dd.textContent !== f.value) {
            row.dd.textContent = f.value;
        }
    }

    for (const [key, row] of existing) {
        if (!usedKeys.has(key)) {
            row.dt.remove();
            row.dd.remove();
        }
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
        block.innerHTML = `<div class="agent-tool-card__label">结果</div>`;
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
): void {
    const status = m._toolStatus?.[tc.id];
    const hint = m._toolHint?.[tc.id];
    const result = m._toolResults?.[tc.id];
    const argsJson = tc.function.arguments ?? "";

    card.open = composing || status === "running" || !status;

    const summary = card.querySelector("summary");
    if (summary) {
        let icon: string;
        if (composing) {
            icon = '<span class="agent-spinner"></span>';
        } else if (status === "running" || !status) {
            icon = '<span class="agent-spinner"></span>';
        } else if (status === "ok") {
            icon = "✓";
        } else {
            icon = "✗";
        }
        summary.innerHTML =
            `${icon} <span class="agent-tool-card__name">${escapeHtml(tc.function.name)}</span>`;
    }

    const body = ensureCardBody(card);
    body.querySelectorAll(".agent-tool-card__hint--status").forEach((el) => el.remove());

    if (!composing) {
        if (status === "running") {
            const wait = document.createElement("p");
            wait.className = "agent-tool-card__hint agent-tool-card__hint--status";
            wait.textContent = hint ?? "执行中…";
            body.prepend(wait);
        } else if (!status) {
            const wait = document.createElement("p");
            wait.className = "agent-tool-card__hint agent-tool-card__hint--status";
            wait.textContent = hint ?? "等待执行…";
            body.prepend(wait);
        }
    }

    patchPreviewFields(body, tc.function.name, argsJson, composing);
    patchResultBlock(body, tc.function.name, result);
}

function createToolCard(toolName: string, toolCallId: string): HTMLDetailsElement {
    const card = document.createElement("details");
    card.className = "agent-tool-card";
    card.dataset.toolCallId = toolCallId;
    card.innerHTML =
        `<summary><span class="agent-spinner"></span> <span class="agent-tool-card__name">${escapeHtml(toolName)}</span></summary>`;
    return card;
}

export interface RenderToolCallsOptions {
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

    const composing = options.llmStreaming === true && !hasToolExecutionStarted(m);
    const seen = new Set<string>();

    for (const tc of m.tool_calls) {
        const id = tc.id || `${tc.function.name}:${seen.size}`;
        seen.add(id);
        let card = host.querySelector(`[data-tool-call-id="${CSS.escape(id)}"]`) as HTMLDetailsElement | null;
        if (!card) {
            card = createToolCard(tc.function.name, id);
            host.appendChild(card);
        }
        patchToolCard(card, tc, m, composing);
    }

    for (const old of host.querySelectorAll(".agent-tool-card")) {
        const id = (old as HTMLElement).dataset.toolCallId;
        if (id && !seen.has(id)) {
            old.remove();
        }
    }
}
