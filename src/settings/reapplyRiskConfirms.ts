import type {ChatMessage} from "../agent/types";
import {getToolByName} from "../tools/registry";
import {assessToolRisk} from "../tools/riskPolicy";
import {resolveInlineToolConfirm, hasPendingInlineActions} from "../ui/chat/inlineToolActions";

/** 风险阈值升高后，对仍挂起的确认尝试自动放行 */
export function reapplyPendingRiskConfirms(
    sessions: {sessions: {id: string; messages: ChatMessage[]}[]},
    riskAutoApproveMax: number,
): boolean {
    if (!hasPendingInlineActions()) {
        return false;
    }
    let changed = false;
    for (const sess of sessions.sessions) {
        for (const m of sess.messages) {
            if (m.role !== "assistant" || !m._toolConfirm) {
                continue;
            }
            for (const [toolCallId, info] of Object.entries(m._toolConfirm)) {
                if (info.status !== "pending") {
                    continue;
                }
                const tc = m.tool_calls?.find((t) => t.id === toolCallId);
                if (!tc) {
                    continue;
                }
                const def = getToolByName(tc.function.name);
                if (!def) {
                    continue;
                }
                let args: Record<string, unknown> = {};
                try {
                    args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
                } catch {
                    /* 参数未流式完整时无法重算，保留待确认 */
                }
                const risk = assessToolRisk(def, args, riskAutoApproveMax);
                if (risk.autoApprove) {
                    resolveInlineToolConfirm(sess.id, toolCallId, true);
                    changed = true;
                }
            }
        }
    }
    return changed;
}
