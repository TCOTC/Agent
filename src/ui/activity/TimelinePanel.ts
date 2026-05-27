import type {AuditEvent} from "../../agent/types";
import {serializeAuditLine} from "../../core/activityLog";

const ICON: Record<string, string> = {
    user_message: "👤",
    llm_request: "🤖",
    llm_response: "✓",
    tool_call: "🔧",
    tool_result: "📋",
    tool_blocked: "⛔",
    tool_confirm_required: "❓",
    tool_confirm_result: "✅",
    pending_edit: "📝",
};

export function formatTimelineEntry(e: AuditEvent, ts?: string): string {
    const time = ts ? new Date(ts).toLocaleTimeString() : new Date().toLocaleTimeString();
    let text = "";
    switch (e.kind) {
        case "user_message":
            text = e.preview;
            break;
        case "llm_request":
            text = `请求 ${e.model} · ${e.messageCount} 消息 · ${e.toolCount} 工具`;
            break;
        case "llm_response":
            text = `响应 ${e.durationMs}ms · ${e.finishReason ?? "-"}`;
            break;
        case "tool_call":
            text = `${e.name}(${e.argsPreview.slice(0, 80)})`;
            break;
        case "tool_result":
            text = `${e.name} ${e.ok ? "成功" : "失败"} ${e.durationMs}ms`;
            break;
        case "pending_edit":
            text = `文档编辑预览 ${e.docId} +${e.adds}/-${e.removes}`;
            break;
        default:
            text = JSON.stringify(e);
    }
    return `${time} ${ICON[e.kind] ?? "·"} ${text}`;
}

export function mountTimelinePanel(container: HTMLElement, lines: string[]): void {
    container.innerHTML = "";
    if (!lines.length) {
        container.innerHTML = `<div class="agent-timeline__empty">暂无运行记录</div>`;
        return;
    }
    const pre = document.createElement("pre");
    pre.className = "agent-timeline__log";
    pre.textContent = lines.join("\n");
    container.appendChild(pre);
}

export function parseJsonlLines(raw: string): string[] {
    return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            try {
                const o = JSON.parse(line) as {ts?: string; event?: AuditEvent};
                if (o.event) {
                    return formatTimelineEntry(o.event, o.ts);
                }
            } catch {
                /* keep raw */
            }
            return line;
        });
}

export {serializeAuditLine};
