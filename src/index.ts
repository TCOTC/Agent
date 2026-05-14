import {
    Plugin,
    showMessage,
    Setting,
    getFrontend,
    adaptHotkey,
} from "siyuan";
import "./index.scss";
import {mountAgentDock} from "./agent/chatDock";
import {
    defaultAgentSettings,
    normalizeSettings,
    STORAGE_AGENT_SETTINGS,
    STORAGE_AGENT_WORKSET,
} from "./agent/storage";

const DOCK_TYPE = "dock_tab";

export default class Agent extends Plugin {
    private isMobile: boolean;

    onload() {
        this.data[STORAGE_AGENT_SETTINGS] = {...defaultAgentSettings};

        const frontEnd = getFrontend();
        this.isMobile = frontEnd === "mobile" || frontEnd === "browser-mobile";

        this.addIcons(`<symbol id="iconSaving" viewBox="0 0 32 32">
<path d="M20 13.333c0-0.733 0.6-1.333 1.333-1.333s1.333 0.6 1.333 1.333c0 0.733-0.6 1.333-1.333 1.333s-1.333-0.6-1.333-1.333zM10.667 12h6.667v-2.667h-6.667v2.667zM29.333 10v9.293l-3.76 1.253-2.24 7.453h-7.333v-2.667h-2.667v2.667h-7.333c0 0-3.333-11.28-3.333-15.333s3.28-7.333 7.333-7.333h6.667c1.213-1.613 3.147-2.667 5.333-2.667 1.107 0 2 0.893 2 2 0 0.28-0.053 0.533-0.16 0.773-0.187 0.453-0.347 0.973-0.427 1.533l3.027 3.027h2.893zM26.667 12.667h-1.333l-4.667-4.667c0-0.867 0.12-1.72 0.347-2.547-1.293 0.333-2.347 1.293-2.787 2.547h-8.227c-2.573 0-4.667 2.093-4.667 4.667 0 2.507 1.627 8.867 2.68 12.667h2.653v-2.667h8v2.667h2.68l2.067-6.867 3.253-1.093v-4.707z"></path>
</symbol>`);

        this.addDock({
            config: {
                position: "RightBottom",
                size: {width: 320, height: 400},
                icon: "iconSaving",
                title: this.i18n.agentDockTitle,
                hotkey: "⌥⌘W",
            },
            data: {},
            type: DOCK_TYPE,
            init: (dock) => {
                if (this.isMobile) {
                    dock.element.innerHTML = `<div class="fn__flex-1 fn__flex-column">
    <div class="toolbar toolbar--border toolbar--dark">
    <svg class="toolbar__icon"><use xlink:href="#iconSaving"></use></svg>
        <div class="toolbar__text">${this.i18n.agentDockTitle}</div>
    </div>
    <div class="fn__flex-1 fn__flex-column plugin-agent-dock-wrap"></div>
</div>`;
                    const wrap = dock.element.querySelector(".plugin-agent-dock-wrap");
                    if (wrap) {
                        mountAgentDock(this, wrap as HTMLElement);
                    }
                } else {
                    dock.element.innerHTML = `<div class="fn__flex-1 fn__flex-column">
    <div class="block__icons">
        <div class="block__logo">
            <svg class="block__logoicon"><use xlink:href="#iconSaving"></use></svg>${this.i18n.agentDockTitle}
        </div>
        <span class="fn__flex-1 fn__space"></span>
        <span data-type="min" class="block__icon ariaLabel" data-position="north" aria-label="Min ${
                        adaptHotkey("⌘W")
                    }"><svg><use xlink:href="#iconMin"></use></svg></span>
    </div>
    <div class="fn__flex-1 fn__flex-column plugin-agent-dock-wrap"></div>
</div>`;
                    const wrap = dock.element.querySelector(".plugin-agent-dock-wrap");
                    if (wrap) {
                        mountAgentDock(this, wrap as HTMLElement);
                    }
                }
            },
        });

        const agentBaseUrlEl = document.createElement("textarea");
        const agentApiKeyEl = document.createElement("input");
        const agentModelEl = document.createElement("input");
        const agentAllowSqlEl = document.createElement("input");

        this.setting = new Setting({
            confirmCallback: () => {
                const s = normalizeSettings({
                    baseUrl: agentBaseUrlEl.value,
                    apiKey: agentApiKeyEl.value,
                    model: agentModelEl.value,
                    allowSqlTool: agentAllowSqlEl.checked,
                });
                this.saveData(STORAGE_AGENT_SETTINGS, s).catch((e) => {
                    showMessage(`[${this.name}] save agent settings fail: `, e);
                });
                this.data[STORAGE_AGENT_SETTINGS] = s;
            },
        });

        agentBaseUrlEl.className = "b3-text-field fn__block";
        agentBaseUrlEl.placeholder = "https://api.openai.com/v1";
        this.setting.addItem({
            title: this.i18n.agentSettingBaseUrl,
            description: this.i18n.agentSettingBaseUrlDesc,
            createActionElement: () => {
                agentBaseUrlEl.value = (this.data[STORAGE_AGENT_SETTINGS] as typeof defaultAgentSettings).baseUrl;
                return agentBaseUrlEl;
            },
        });
        agentApiKeyEl.type = "password";
        agentApiKeyEl.className = "b3-text-field fn__block";
        this.setting.addItem({
            title: this.i18n.agentSettingApiKey,
            description: this.i18n.agentSettingApiKeyDesc,
            createActionElement: () => {
                agentApiKeyEl.value = (this.data[STORAGE_AGENT_SETTINGS] as typeof defaultAgentSettings).apiKey;
                return agentApiKeyEl;
            },
        });
        agentModelEl.className = "b3-text-field fn__block";
        agentModelEl.placeholder = "gpt-4o-mini";
        this.setting.addItem({
            title: this.i18n.agentSettingModel,
            description: this.i18n.agentSettingModelDesc,
            createActionElement: () => {
                agentModelEl.value = (this.data[STORAGE_AGENT_SETTINGS] as typeof defaultAgentSettings).model;
                return agentModelEl;
            },
        });
        agentAllowSqlEl.type = "checkbox";
        agentAllowSqlEl.className = "b3-switch fn__flex-center";
        this.setting.addItem({
            title: this.i18n.agentSettingAllowSql,
            description: this.i18n.agentSettingAllowSqlDesc,
            createActionElement: () => {
                const wrap = document.createElement("div");
                wrap.className = "fn__flex fn__flex-center";
                agentAllowSqlEl.checked = Boolean(
                    (this.data[STORAGE_AGENT_SETTINGS] as typeof defaultAgentSettings).allowSqlTool,
                );
                wrap.appendChild(agentAllowSqlEl);
                return wrap;
            },
        });
    }

    onLayoutReady() {
        this.loadData(STORAGE_AGENT_SETTINGS)
            .then((d) => {
                this.data[STORAGE_AGENT_SETTINGS] = normalizeSettings(d);
            })
            .catch((e) => {
                console.log(`[${this.name}] load agent settings fail: `, e);
            });
    }

    onunload() {}

    uninstall() {
        this.removeData(STORAGE_AGENT_SETTINGS).catch(() => {});
        this.removeData(STORAGE_AGENT_WORKSET).catch(() => {});
    }
}
