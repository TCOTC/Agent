/** 写入 settings.json 的插件配置 */
export interface PersistedSettings {
    baseUrl: string;
    apiKey: string;
    model: string;
    /** 默认启用 DeepSeek 思考模式 */
    thinkingEnabled: boolean;
}
