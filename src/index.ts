import {Plugin, showMessage, adaptHotkey, confirm} from "siyuan";
import "./index.scss";
import {mountAgentPanel} from "./ui/dock/panel";
import {destroyCachedLute} from "./render/lute";
import {normalizeSettings, STORAGE_KEY_SETTINGS} from "./settings/storage";
import {attachPluginSettingPanel} from "./settings/settingPanel";
import {STORAGE_KEY_SESSIONS} from "./core/constants";
import {normalizeSessions} from "./session/storage";
import {installConfirmVisibilityListener} from "./ui/notify/desktopNotify";
import {logger} from "./util";

const DOCK_TYPE = "agent_dock";

export default class Agent extends Plugin {
    private destroyDockPanel: (() => void) | null = null;
    /** 用于合并连续的 dock.init，避免布局抖动时重复挂载 */
    private dockInitGen = 0;

    showPluginMessage(text: string, timeout?: number, type?: "info" | "error", id?: string): void {
        showMessage(`[Agent] ${text}`, timeout, type, id);
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
    <div class="block__icons">
        <div class="block__logo">
            <svg class="block__logoicon"><use xlink:href="#iconAgent"></use></svg>Agent
        </div>
        <span class="fn__flex-1 fn__space"></span>
        <span data-type="min" class="block__icon ariaLabel" data-position="north" aria-label="Min ${
                    adaptHotkey("⌘W")
                }"><svg><use xlink:href="#iconMin"></use></svg></span>
    </div>
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
        installConfirmVisibilityListener();
        this.addIcons(`<symbol id="iconAgent" viewBox="0 0 32 32">
<path d="M16 4c-4.4 0-8 3.6-8 8 0 2.2 0.9 4.2 2.3 5.7L8 22l4.3-2.3c1.5 1.4 3.5 2.3 5.7 2.3 4.4 0 8-3.6 8-8s-3.6-8-8-8zm0 14c-3.3 0-6-2.7-6-6s2.7-6 6-6 6 2.7 6 6-2.7 6-6 6zm8 6h-2v2h2v4h2v-4h4v-2h-4v-2z"/>
</symbol>`);

        void this.refreshPluginDataFromStorage()
            .then(() => this.initPluginUi())
            .catch((e) => {
                logger.error("load plugin storage fail:", e);
                const detail = e instanceof Error ? e.message : String(e);
                this.showPluginMessage(`加载配置失败：${detail}`, 8000, "error");
            });
    }

    onDataChanged() {
        void this.refreshPluginDataFromStorage().catch((e) => {
            logger.error("onDataChanged:", e);
        });
    }

    onunload() {
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
