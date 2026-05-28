/** Agent 运行模式 */
export type AgentMode = "ask" | "agent";

export interface AgentModeMeta {
    id: AgentMode;
    label: string;
    description: string;
    /** 是否向模型暴露 tools */
    enableTools: boolean;
    /** 允许的工具风险等级；ask 仅 read/ui */
    allowedRisks: import("../agent/types").ToolRisk[];
}

export const AGENT_MODES: AgentModeMeta[] = [
    {
        id: "ask",
        label: "问答",
        description: "只读探索，不修改笔记",
        enableTools: true,
        allowedRisks: ["read", "ui"],
    },
    {
        id: "agent",
        label: "智能体",
        description: "完整工具链，自动执行低风险写入",
        enableTools: true,
        allowedRisks: ["read", "ui", "write", "delete", "sql"],
    },
];

export function getModeMeta(mode: AgentMode): AgentModeMeta {
    return AGENT_MODES.find((m) => m.id === mode) ?? AGENT_MODES[1];
}
