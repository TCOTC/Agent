import {DEEPSEEK_DEFAULT_BASE_URL} from "../core/constants";
import type {PersistedSettings} from "./types";

export const STORAGE_KEY_SETTINGS = "settings.json";

export const defaultSettings: PersistedSettings = {
    baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
    apiKey: "",
    model: "deepseek-v4-flash",
    thinkingEnabled: true,
};

type SettingsKey = keyof typeof defaultSettings;

const settingsKeys = Object.keys(defaultSettings) as SettingsKey[];

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
