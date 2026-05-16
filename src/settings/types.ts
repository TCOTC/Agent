/** 写入 `settings.json` 的插件持久化配置（不限于 Agent 运行时）。 */
export interface PersistedSettings {
    baseUrl: string;
    apiKey: string;
    model: string;
}
