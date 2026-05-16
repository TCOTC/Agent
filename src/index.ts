import {
    Plugin,
    showMessage,
    adaptHotkey,
    confirm,
} from "siyuan";
import "./index.scss";
import {mountDockPanel} from "./dock";
import {destroyCachedLute} from "./render/lute";
import {normalizeSettings, STORAGE_KEY_SETTINGS} from "./settings/storage";
import {attachPluginSettingPanel} from "./settings/settingPanel";
import type {PluginI18n} from "./pluginI18n";
import {logger} from "./util";

const DOCK_TYPE = "agent_dock";

export default class Agent extends Plugin {
    declare i18n: PluginI18n;

    private destroyDockPanel: (() => void) | null = null;

    showPluginMessage(text: string, timeout?: number, type?: "info" | "error", id?: string): void {
        showMessage(this.i18n.messagePrefix + text, timeout, type, id);
    }

    /**
     * 从内核 `loadData` 拉取本插件持久化键并写入 `this.data`，再经归一化供 Dock / 设置面板使用。
     */
    private async refreshPluginDataFromStorage(): Promise<void> {
        await this.loadData(STORAGE_KEY_SETTINGS);
        this.data[STORAGE_KEY_SETTINGS] = normalizeSettings(this.data[STORAGE_KEY_SETTINGS]);
    }

    private initPluginUi(): void {
        this.addDock({
            config: {
                position: "RightBottom",
                size: {width: 320, height: 400},
                icon: "iconSaving",
                title: this.i18n.dockTitle,
                hotkey: "⌥⌘W",
            },
            data: {},
            type: DOCK_TYPE,
            destroy: () => {
                this.destroyDockPanel?.();
                this.destroyDockPanel = null;
            },
            init: (dock) => {
                dock.element.innerHTML = `<div class="fn__flex-1 fn__flex-column">
    <div class="block__icons">
        <div class="block__logo">
            <svg class="block__logoicon"><use xlink:href="#iconSaving"></use></svg>${this.i18n.dockTitle}
        </div>
        <span class="fn__flex-1 fn__space"></span>
        <span data-type="min" class="block__icon ariaLabel" data-position="north" aria-label="Min ${
                    adaptHotkey("⌘W")
                }"><svg><use xlink:href="#iconMin"></use></svg></span>
    </div>
    <div class="fn__flex-1 fn__flex-column jcag-dock-wrap"></div>
</div>`;
                const wrap = dock.element.querySelector(".jcag-dock-wrap");
                if (wrap) {
                    this.destroyDockPanel?.();
                    this.destroyDockPanel = mountDockPanel(this, wrap as HTMLElement);
                }
            },
        });

        attachPluginSettingPanel(this);
    }

    onload() {
        this.addIcons(`<symbol id="iconSaving" viewBox="0 0 32 32">
<path d="M20 13.333c0-0.733 0.6-1.333 1.333-1.333s1.333 0.6 1.333 1.333c0 0.733-0.6 1.333-1.333 1.333s-1.333-0.6-1.333-1.333zM10.667 12h6.667v-2.667h-6.667v2.667zM29.333 10v9.293l-3.76 1.253-2.24 7.453h-7.333v-2.667h-2.667v2.667h-7.333c0 0-3.333-11.28-3.333-15.333s3.28-7.333 7.333-7.333h6.667c1.213-1.613 3.147-2.667 5.333-2.667 1.107 0 2 0.893 2 2 0 0.28-0.053 0.533-0.16 0.773-0.187 0.453-0.347 0.973-0.427 1.533l3.027 3.027h2.893zM26.667 12.667h-1.333l-4.667-4.667c0-0.867 0.12-1.72 0.347-2.547-1.293 0.333-2.347 1.293-2.787 2.547h-8.227c-2.573 0-4.667 2.093-4.667 4.667 0 2.507 1.627 8.867 2.68 12.667h2.653v-2.667h8v2.667h2.68l2.067-6.867 3.253-1.093v-4.707z"></path>
</symbol>`);

        void this.refreshPluginDataFromStorage()
            .then(() => this.initPluginUi())
            .catch((e) => {
                logger.error("load plugin storage fail:", e);
                const detail = e instanceof Error ? e.message : String(e);
                this.showPluginMessage(`${this.i18n.loadStorageFail} ${detail}`, 8000, "error");
            });
    }

    /**
     * 插件 data 目录同步变更后由内核调用。
     * 不重载整个插件：复用 `refreshPluginDataFromStorage` 写入 `this.data`；Dock 发送时再读 `this.data`。
     * 不调用 super，以避免基类卸载并重载插件（参见思源 Plugin.onDataChanged 默认实现）。
     */
    onDataChanged() {
        void this.refreshPluginDataFromStorage().catch((e) => {
            logger.error("onDataChanged: refresh plugin storage fail:", e);
        });
    }

    onunload() {
        this.destroyDockPanel?.();
        this.destroyDockPanel = null;
        destroyCachedLute();
    }

    uninstall() {
        confirm(
            this.i18n.uninstallDataConfirmTitle,
            this.i18n.uninstallDataConfirmText,
            () => {
                this.removeData(STORAGE_KEY_SETTINGS).catch(() => {});
            },
            () => {},
        );
    }
}
