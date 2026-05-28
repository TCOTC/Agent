import {DEEPSEEK_DEFAULT_BASE_URL, RISK_AUTO_APPROVE_MAX} from "../core/constants";
import type {PersistedSettings, SendKeyMode} from "./types";

export const STORAGE_KEY_SETTINGS = "settings.json";

export const defaultSettings: PersistedSettings = {
    baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
    apiKey: "",
    model: "deepseek-v4-flash",
    thinkingEnabled: true,
    customInstructions: "",
    defaultMode: "agent",
    worksetNotebookIds: [],
    riskAutoApproveMax: RISK_AUTO_APPROVE_MAX,
    modelContextLimits: {},
    sendKeyMode: "enter",
};

const SEND_KEY_MODES = new Set<SendKeyMode>(["enter", "ctrlEnter"]);

type SettingsKey = keyof typeof defaultSettings;

const settingsKeys = Object.keys(defaultSettings) as SettingsKey[];

function coerceSettingValue(
    raw: unknown,
    defaultValue: PersistedSettings[SettingsKey],
): PersistedSettings[SettingsKey] {
    const kind = typeof defaultValue;
    if (Array.isArray(defaultValue)) {
        return Array.isArray(raw) ? (raw as PersistedSettings[SettingsKey]) : defaultValue;
    }
    if (typeof raw === kind) {
        if (kind === "number" && Number.isNaN(raw as number)) {
            return defaultValue;
        }
        return raw as PersistedSettings[SettingsKey];
    }
    return defaultValue;
}

function coerceModelContextLimits(raw: unknown): Record<string, number> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return {};
    }
    const out: Record<string, number> = {};
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
        const n = Number(v);
        if (id.trim() && Number.isFinite(n) && n > 0) {
            out[id.trim()] = Math.floor(n);
        }
    }
    return out;
}

export function normalizeSettings(raw: unknown): PersistedSettings {
    const settings = {...defaultSettings} as Record<SettingsKey, PersistedSettings[SettingsKey]>;
    if (!raw || typeof raw !== "object") {
        return settings as PersistedSettings;
    }
    const o = raw as Record<string, unknown>;
    for (const key of settingsKeys) {
        if (key === "modelContextLimits") {
            settings[key] = coerceModelContextLimits(o[key]);
            continue;
        }
        if (key === "sendKeyMode") {
            settings[key] = SEND_KEY_MODES.has(o[key] as SendKeyMode)
                ? (o[key] as SendKeyMode)
                : defaultSettings.sendKeyMode;
            continue;
        }
        settings[key] = coerceSettingValue(o[key], defaultSettings[key]);
    }
    return settings as PersistedSettings;
}
