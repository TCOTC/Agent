import type {ChatMessage} from "../../agent/types";

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
        if (name === "siyuan_open_document" || name === "siyuan_focus_block") {
            return o.ok ? `已打开块 ${String(o.id ?? "")}` : text;
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
        return JSON.stringify(o, null, 2);
    } catch {
        return text;
    }
}

export function renderAssistantToolCalls(host: HTMLElement, m: ChatMessage): void {
    host.replaceChildren();
    if (!m.tool_calls?.length) {
        host.hidden = true;
        return;
    }
    host.hidden = false;

    for (const tc of m.tool_calls) {
        const status = m._toolStatus?.[tc.id] ?? "running";
        const hint = m._toolHint?.[tc.id];
        const result = m._toolResults?.[tc.id];

        const card = document.createElement("details");
        card.className = "agent-tool-card";
        if (status === "running") {
            card.open = true;
        }

        const icon =
            status === "running" ? '<span class="agent-spinner"></span>' :
                status === "ok" ? "✓" :
                "✗";
        card.innerHTML = `<summary>${icon} <span class="agent-tool-card__name">${escapeHtml(tc.function.name)}</span></summary>`;

        const body = document.createElement("div");
        body.className = "agent-tool-card__body";

        if (status === "running") {
            const wait = document.createElement("p");
            wait.className = "agent-tool-card__hint";
            wait.textContent = hint ?? "执行中…";
            body.appendChild(wait);
        }

        const argsBlock = document.createElement("div");
        argsBlock.className = "agent-tool-card__section";
        argsBlock.innerHTML = `<div class="agent-tool-card__label">参数</div>`;
        const argsPre = document.createElement("pre");
        argsPre.textContent = formatArgs(tc.function.arguments ?? "{}");
        argsBlock.appendChild(argsPre);
        body.appendChild(argsBlock);

        if (result) {
            const resultBlock = document.createElement("div");
            resultBlock.className = "agent-tool-card__section";
            resultBlock.innerHTML = `<div class="agent-tool-card__label">结果</div>`;
            const resultPre = document.createElement("pre");
            resultPre.textContent = formatToolResultPreview(tc.function.name, result);
            resultBlock.appendChild(resultPre);
            body.appendChild(resultBlock);
        }

        card.appendChild(body);
        host.appendChild(card);
    }
}
