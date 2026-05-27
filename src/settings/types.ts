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
}
