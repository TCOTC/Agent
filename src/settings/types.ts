/** 输入框发送快捷键模式 */
export type SendKeyMode = "enter" | "ctrlEnter";

/** 写入 settings.json 的插件配置 */
export interface PersistedSettings {
    baseUrl: string;
    apiKey: string;
    model: string;
    thinkingEnabled: boolean;
    /** 全局自定义系统指令 */
    customInstructions: string;
    /** 默认 Agent 模式 */
    defaultMode: import("../agent/modes").AgentMode;
    /** 工作集：限制的笔记本 ID，空表示不限制 */
    worksetNotebookIds: string[];
    /** 自动放行风险分上限 */
    riskAutoApproveMax: number;
    /** 按模型 ID 覆盖上下文窗口上限（tokens） */
    modelContextLimits: Record<string, number>;
    /** 发送快捷键：回车 发送 或 Ctrl+回车 发送 */
    sendKeyMode: SendKeyMode;
}
