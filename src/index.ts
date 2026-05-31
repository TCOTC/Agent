import {Plugin, showMessage, confirm, getActiveEditor} from "siyuan";
import "./index.scss";
import {mountAgentPanel} from "./ui/dock/panel";
import {destroyCachedLute} from "./render/lute";
import {normalizeSettings, STORAGE_KEY_SETTINGS} from "./settings/storage";
import {notifySettingsChange} from "./settings/settingsNotify";
import {attachPluginSettingPanel} from "./settings/settingPanel";
import type {PersistedSettings} from "./settings/types";
import {STORAGE_KEY_SESSIONS} from "./core/constants";
import {normalizeSessions} from "./session/storage";
import {installConfirmVisibilityListener} from "./ui/notify/desktopNotify";
import {buildAgentIconSymbols} from "./icons/agentIcons";
import {logger} from "./util";

const DOCK_TYPE = "agent_dock";

export default class Agent extends Plugin {
    private destroyDockPanel: (() => void) | null = null;
    /** 用于合并连续的 dock.init，避免布局抖动时重复挂载 */
    private dockInitGen = 0;

    showPluginMessage(text: string, timeout?: number, type?: "info" | "error", id?: string): void {
        showMessage(`[Agent] ${text}`, timeout, type, id);
    }

    /** 写入内存并持久化设置；本地保存后立即通知 UI（不必等同步触发的 onDataChanged） */
    async persistPluginSettings(next: PersistedSettings): Promise<void> {
        const s = normalizeSettings(next);
        this.data[STORAGE_KEY_SETTINGS] = s;
        await this.saveData(STORAGE_KEY_SETTINGS, s);
        notifySettingsChange(s);
    }

    private async refreshPluginDataFromStorage(): Promise<void> {
        await this.loadData(STORAGE_KEY_SETTINGS);
        this.data[STORAGE_KEY_SETTINGS] = normalizeSettings(this.data[STORAGE_KEY_SETTINGS]);
        await this.loadData(STORAGE_KEY_SESSIONS);
        this.data[STORAGE_KEY_SESSIONS] = normalizeSessions(this.data[STORAGE_KEY_SESSIONS]);
    }

    private initPluginUi(): void {
        this.addDock({
            config: {
                position: "RightBottom",
                size: {width: 560, height: 560},
                icon: "iconAgent",
                title: "Agent",
                hotkey: "⌥⌘A",
            },
            data: {},
            type: DOCK_TYPE,
            destroy: () => {
                this.dockInitGen++;
                this.destroyDockPanel?.();
                this.destroyDockPanel = null;
            },
            init: (dock) => {
                const gen = ++this.dockInitGen;
                dock.element.innerHTML = `<div class="fn__flex-1 fn__flex-column">
    <div class="fn__flex-1 fn__flex-column agent-dock-wrap"></div>
</div>`;
                const wrap = dock.element.querySelector(".agent-dock-wrap") as HTMLElement | null;
                if (!wrap) {
                    return;
                }
                window.setTimeout(() => {
                    if (gen !== this.dockInitGen) {
                        return;
                    }
                    this.destroyDockPanel?.();
                    this.destroyDockPanel = mountAgentPanel(this, wrap);
                }, 0);
            },
        });

        attachPluginSettingPanel(this);
    }

    onload() {
        // 供控制台手动测试：getActiveEditor() / getActiveEditor(false)
        window.getActiveEditor = getActiveEditor;
        installConfirmVisibilityListener();
        this.addIcons(buildAgentIconSymbols());

        void this.refreshPluginDataFromStorage()
            .then(() => this.initPluginUi())
            .catch((e) => {
                logger.error("load plugin storage fail:", e);
                const detail = e instanceof Error ? e.message : String(e);
                this.showPluginMessage(`加载配置失败：${detail}`, 8000, "error");
            });
    }

    onDataChanged() {
        void this.refreshPluginDataFromStorage()
            .then(() => {
                notifySettingsChange(normalizeSettings(this.data[STORAGE_KEY_SETTINGS]));
            })
            .catch((e) => {
                logger.error("onDataChanged:", e);
            });
    }

    onunload() {
        delete window.getActiveEditor;
        this.dockInitGen++;
        this.destroyDockPanel?.();
        this.destroyDockPanel = null;
        destroyCachedLute();
    }

    uninstall() {
        confirm(
            "卸载 Agent",
            "是否删除插件本地数据（设置、会话、日志）？",
            () => {
                void this.removeData(STORAGE_KEY_SETTINGS);
                void this.removeData(STORAGE_KEY_SESSIONS);
                void this.removeData("activity.jsonl");
                void this.removeData("token-stats.json");
            },
            () => {},
        );
    }
}
