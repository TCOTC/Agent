import type {ToolDefinition, ToolRisk} from "../agent/types";

export interface RiskAssessment {
    score: number;
    reasons: string[];
    mustConfirm: boolean;
    autoApprove: boolean;
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
        const len = String(
            args.markdown ?? args.kramdown ?? args.new_markdown ?? args.data ?? "",
        ).length;
        if (len > 8000) {
            score += 18;
            reasons.push("变更内容较长");
        } else if (len > 2000) {
            score += 8;
            reasons.push("变更内容中等");
        }
    }

    if (tool.name === "siyuan_edit_document") {
        score += 25;
        reasons.push("整篇文档替换");
    }

    if (tool.risk === "delete") {
        reasons.push("删除块操作");
    }

    if (tool.name === "siyuan_sql_query") {
        const stmt = String(args.stmt ?? "").trim().toUpperCase();
        if (!/^(SELECT|WITH|EXPLAIN|VALUES)\b/.test(stmt)) {
            score = 95;
            reasons.push("非只读 SQL");
        }
    }

    score = Math.min(100, Math.max(0, score));
    const mustConfirm = tool.alwaysConfirm || tool.risk === "delete" || score >= 72;
    const autoApprove = !mustConfirm && score <= autoApproveMax;

    return {score, reasons, mustConfirm, autoApprove};
}

export function formatRiskSummary(a: RiskAssessment): string {
    const parts = [`风险分 ${a.score}`];
    if (a.reasons.length) {
        parts.push(a.reasons.join("；"));
    }
    return parts.join(" — ");
}
