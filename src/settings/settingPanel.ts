import {Setting} from "siyuan";
import type Agent from "../index";
import {defaultSettings, normalizeSettings, STORAGE_KEY_SETTINGS} from "./storage";

/** 使用思源 `Setting` 组装插件设置面板表单项，并挂到 `plugin.setting`。 */
export function attachPluginSettingPanel(plugin: Agent): void {
    const elBaseUrl = document.createElement("textarea");
    const elApiKey = document.createElement("input");
    const elModel = document.createElement("input");

    plugin.setting = new Setting({
        confirmCallback: () => {
            const s = normalizeSettings({
                baseUrl: elBaseUrl.value,
                apiKey: elApiKey.value,
                model: elModel.value,
            });
            plugin.saveData(STORAGE_KEY_SETTINGS, s).catch((e) => {
                const detail = e instanceof Error ? e.message : String(e);
                plugin.showPluginMessage(`[${plugin.name}] save settings fail: ${detail}`);
            });
            plugin.data[STORAGE_KEY_SETTINGS] = s;
        },
    });

    elBaseUrl.className = "b3-text-field fn__block";
    elBaseUrl.placeholder = "https://api.openai.com/v1";
    plugin.setting.addItem({
        title: plugin.i18n.settingBaseUrl,
        description: plugin.i18n.settingBaseUrlDesc,
        createActionElement: () => {
            elBaseUrl.value = (plugin.data[STORAGE_KEY_SETTINGS] as typeof defaultSettings).baseUrl;
            return elBaseUrl;
        },
    });
    elApiKey.type = "password";
    elApiKey.className = "b3-text-field fn__block";
    plugin.setting.addItem({
        title: plugin.i18n.settingApiKey,
        description: plugin.i18n.settingApiKeyDesc,
        createActionElement: () => {
            elApiKey.value = (plugin.data[STORAGE_KEY_SETTINGS] as typeof defaultSettings).apiKey;
            return elApiKey;
        },
    });
    elModel.className = "b3-text-field fn__block";
    plugin.setting.addItem({
        title: plugin.i18n.settingModel,
        description: plugin.i18n.settingModelDesc,
        createActionElement: () => {
            elModel.value = (plugin.data[STORAGE_KEY_SETTINGS] as typeof defaultSettings).model;
            return elModel;
        },
    });
}
