import type {ToolDefinition, ToolRisk} from "../agent/types";

export interface RiskAssessment {
    score: number;
    reasons: string[];
    mustConfirm: boolean;
    autoApprove: boolean;
}

function estimateWritePayloadChars(tool: ToolDefinition, args: Record<string, unknown>): number {
    if (tool.name.startsWith("batch_")) {
        let n = 0;
        for (const key of ["updates", "inserts", "appends"] as const) {
            const arr = args[key];
            if (!Array.isArray(arr)) {
                continue;
            }
            for (const item of arr) {
                if (item && typeof item === "object") {
                    const o = item as Record<string, unknown>;
                    n += String(o.markdown ?? "").length;
                }
            }
        }
        if (Array.isArray(args.ids)) {
            n += args.ids.length * 32;
        }
        return n;
    }
    return String(args.markdown ?? args.kramdown ?? args.new_markdown ?? args.data ?? "").length;
}

const RISK_BASE: Record<ToolRisk, number> = {
    read: 8,
    ui: 5,
    write: 42,
    delete: 78,
    sql: 65,
};

export function assessToolRisk(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    autoApproveMax = 35,
): RiskAssessment {
    const reasons: string[] = [];
    let score = RISK_BASE[tool.risk] ?? 40;

    if (tool.risk === "write" || tool.risk === "delete") {
        const len = estimateWritePayloadChars(tool, args);
        if (len > 8000) {
            score += 18;
            reasons.push("变更内容较长");
        } else if (len > 2000) {
            score += 8;
            reasons.push("变更内容中等");
        }
    }

    if (tool.name === "edit_document") {
        score += 25;
        reasons.push("整篇文档替换");
    }

    if (tool.risk === "delete") {
        reasons.push(tool.name.startsWith("batch_") ? "批量删除块" : "删除块操作");
    }

    if (tool.name.startsWith("batch_update")) {
        reasons.push("批量更新块");
    }

    if (tool.name === "sql_query") {
        const stmt = String(args.stmt ?? "").trim().toUpperCase();
        if (!/^(SELECT|WITH|EXPLAIN|VALUES)\b/.test(stmt)) {
            score = 95;
            reasons.push("非只读 SQL");
        }
    }

    score = Math.min(100, Math.max(0, score));
    // 仅按用户「自动放行风险分上限」判定；alwaysConfirm（默认 false，预留按工具始终确认）
    const mustConfirm = Boolean(tool.alwaysConfirm) || score > autoApproveMax;
    const autoApprove = !mustConfirm;

    return {score, reasons, mustConfirm, autoApprove};
}

export function formatRiskSummary(a: RiskAssessment): string {
    const parts = [`风险分 ${a.score}`];
    if (a.reasons.length) {
        parts.push(a.reasons.join("；"));
    }
    return parts.join(" — ");
}
