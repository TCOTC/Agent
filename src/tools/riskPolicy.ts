import type {ToolDefinition, ToolRisk} from "../agent/types";

export interface RiskAssessment {
    /** 0–100，越高越需要人工确认 */
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

/** 根据工具元数据与调用参数估算风险分，驱动自动确认策略 */
export function assessToolRisk(
    tool: ToolDefinition,
    args: Record<string, unknown>,
): RiskAssessment {
    const reasons: string[] = [];
    let score = RISK_BASE[tool.risk] ?? 40;

    if (tool.risk === "write" || tool.risk === "delete") {
        const len = String(args.markdown ?? args.kramdown ?? args.data ?? "").length;
        if (len > 8000) {
            score += 18;
            reasons.push("变更内容较长");
        } else if (len > 2000) {
            score += 8;
            reasons.push("变更内容中等");
        }
        const ids = args.ids;
        if (Array.isArray(ids) && ids.length > 3) {
            score += 22;
            reasons.push(`批量影响 ${ids.length} 个块`);
        }
    }

    if (tool.risk === "delete") {
        const id = String(args.id ?? "");
        if (!id) {
            score += 10;
        }
        reasons.push("删除块操作");
    }

    if (tool.name === "siyuan_sql_query") {
        const stmt = String(args.stmt ?? "").trim().toUpperCase();
        if (!/^(SELECT|WITH|EXPLAIN|VALUES)\b/.test(stmt)) {
            score = 95;
            reasons.push("非只读 SQL 语句");
        }
    }

    if (tool.name === "siyuan_read_kramdown" || tool.name === "siyuan_edit_block_kramdown") {
        score = Math.max(score - 15, RISK_BASE.read);
    }

    score = Math.min(100, Math.max(0, score));

    const mustConfirm =
        tool.alwaysConfirm ||
        tool.risk === "delete" ||
        score >= 72;
    const autoApprove = !mustConfirm && score <= 35;

    return {score, reasons, mustConfirm, autoApprove};
}

export function formatRiskSummary(a: RiskAssessment): string {
    const parts = [`风险分 ${a.score}`];
    if (a.reasons.length) {
        parts.push(a.reasons.join("；"));
    }
    return parts.join(" — ");
}
