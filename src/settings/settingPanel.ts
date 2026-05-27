import {Setting} from "siyuan";
import type Agent from "../index";
import {listDeepSeekModels} from "../agent/deepseekClient";
import {defaultSettings, normalizeSettings, STORAGE_KEY_SETTINGS} from "./storage";

/** 插件设置：DeepSeek API Key、模型列表（来自 API）、思考模式 */
export function attachPluginSettingPanel(plugin: Agent): void {
    const elApiKey = document.createElement("input");
    const elModel = document.createElement("select");
    const elThinking = document.createElement("input");
    elThinking.type = "checkbox";

    const refreshModels = async () => {
        const s = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
        elModel.innerHTML = "";
        if (!s.apiKey) {
            const opt = document.createElement("option");
            opt.value = s.model;
            opt.textContent = s.model;
            elModel.appendChild(opt);
            return;
        }
        try {
            const models = await listDeepSeekModels(s);
            for (const m of models) {
                const opt = document.createElement("option");
                opt.value = m.id;
                opt.textContent = m.id;
                if (m.id === s.model) {
                    opt.selected = true;
                }
                elModel.appendChild(opt);
            }
        } catch (e) {
            const opt = document.createElement("option");
            opt.value = s.model;
            opt.textContent = `${s.model}（拉取模型列表失败）`;
            elModel.appendChild(opt);
        }
    };

    plugin.setting = new Setting({
        confirmCallback: () => {
            const s = normalizeSettings({
                baseUrl: defaultSettings.baseUrl,
                apiKey: elApiKey.value.trim(),
                model: elModel.value || defaultSettings.model,
                thinkingEnabled: elThinking.checked,
            });
            void plugin.saveData(STORAGE_KEY_SETTINGS, s);
            plugin.data[STORAGE_KEY_SETTINGS] = s;
        },
    });

    elApiKey.type = "password";
    elApiKey.className = "b3-text-field fn__block";
    plugin.setting.addItem({
        title: "DeepSeek API Key",
        description: "在 https://platform.deepseek.com 申请。仅保存在本地插件 data 目录。",
        createActionElement: () => {
            elApiKey.value = (plugin.data[STORAGE_KEY_SETTINGS] as typeof defaultSettings).apiKey;
            elApiKey.addEventListener("change", () => void refreshModels());
            return elApiKey;
        },
    });

    elModel.className = "b3-select fn__block";
    plugin.setting.addItem({
        title: "模型",
        description: "通过 DeepSeek GET /models 拉取；侧栏也可临时切换。",
        createActionElement: () => {
            void refreshModels();
            return elModel;
        },
    });

    plugin.setting.addItem({
        title: "思考模式",
        description: "启用后模型先输出 reasoning_content 再回答，适合复杂任务。",
        createActionElement: () => {
            elThinking.checked = (plugin.data[STORAGE_KEY_SETTINGS] as typeof defaultSettings).thinkingEnabled;
            return elThinking;
        },
    });
}
