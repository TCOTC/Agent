import type {PersistedSettings} from "./types";

export const STORAGE_KEY_SETTINGS = "settings.json";

export const defaultSettings: PersistedSettings = {
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-v4-flash",
};

type SettingsKey = keyof typeof defaultSettings;

const settingsKeys = Object.keys(defaultSettings) as SettingsKey[];

/** 优先采用 raw；typeof 与 defaultValue 不一致，或 number 为 NaN 时回退为 defaultValue */
function coerceSettingValue(
    raw: unknown,
    defaultValue: PersistedSettings[SettingsKey],
): PersistedSettings[SettingsKey] {
    const kind = typeof defaultValue;
    if (typeof raw === kind) {
        if (kind === "number" && Number.isNaN(raw as number)) {
            return defaultValue;
        }
        return raw as PersistedSettings[SettingsKey];
    }
    return defaultValue;
}

/** 仅在从存储读入或设置面板保存前调用；运行中 UI 应直接读 `plugin.data` 中已写入的结果。 */
export function normalizeSettings(raw: unknown): PersistedSettings {
    const settings = {...defaultSettings} as Record<SettingsKey, PersistedSettings[SettingsKey]>;
    if (!raw || typeof raw !== "object") {
        return settings as PersistedSettings;
    }
    const o = raw as Record<string, unknown>;
    for (const key of settingsKeys) {
        settings[key] = coerceSettingValue(o[key], defaultSettings[key]);
    }
    return settings as PersistedSettings;
}
