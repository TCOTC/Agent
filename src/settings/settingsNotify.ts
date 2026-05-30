import type {PersistedSettings} from "./types";

/** 设置写入内存后的订阅（用于对话 UI 同步风险阈值等） */
export type SettingsChangeListener = (settings: PersistedSettings) => void;

const listeners = new Set<SettingsChangeListener>();

export function subscribeSettingsChange(listener: SettingsChangeListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function notifySettingsChange(settings: PersistedSettings): void {
    for (const listener of listeners) {
        listener(settings);
    }
}
