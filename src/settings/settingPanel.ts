import {Setting} from "siyuan";
import type Agent from "../index";
import {AGENT_MODES} from "../agent/modes";
import {listDeepSeekModels} from "../agent/deepseekClient";
import {createFetchSyncKernelExecutor} from "../agent/kernelExecutor";
import {defaultSettings, normalizeSettings, STORAGE_KEY_SETTINGS} from "./storage";

export function attachPluginSettingPanel(plugin: Agent): void {
    const elApiKey = document.createElement("input");
    const elModel = document.createElement("select");
    const elThinking = document.createElement("input");
    const elInstructions = document.createElement("textarea");
    const elMode = document.createElement("select");
    const elWorkset = document.createElement("textarea");
    const elRisk = document.createElement("input");
    elThinking.type = "checkbox";
    elRisk.type = "number";

    const refreshModels = async () => {
        const s = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
        elModel.innerHTML = "";
        if (!s.apiKey) {
            elModel.innerHTML = `<option value="${s.model}">${s.model}</option>`;
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
        } catch {
            elModel.innerHTML = `<option>${s.model}</option>`;
        }
    };

    const refreshNotebooks = async () => {
        const kernel = createFetchSyncKernelExecutor();
        const r = await kernel.post("/api/notebook/lsNotebooks", {});
        if (r.code !== 0) {
            return;
        }
        const data = r.data as {notebooks?: {id: string; name: string}[]};
        const list = data.notebooks ?? [];
        elWorkset.placeholder = list.map((n) => `${n.name}\t${n.id}`).join("\n") +
            "\n\n每行一个笔记本 ID；留空表示不限制工作集。";
    };

    plugin.setting = new Setting({
        confirmCallback: () => {
            const worksetLines = elWorkset.value.split("\n").map((l) => l.trim()).filter(Boolean);
            const ids = worksetLines.map((l) => {
                const parts = l.split(/\s+/);
                return parts[parts.length - 1];
            });
            const s = normalizeSettings({
                baseUrl: defaultSettings.baseUrl,
                apiKey: elApiKey.value.trim(),
                model: elModel.value || defaultSettings.model,
                thinkingEnabled: elThinking.checked,
                customInstructions: elInstructions.value,
                defaultMode: elMode.value,
                worksetNotebookIds: ids,
                riskAutoApproveMax: Number(elRisk.value) || defaultSettings.riskAutoApproveMax,
            });
            void plugin.saveData(STORAGE_KEY_SETTINGS, s);
            plugin.data[STORAGE_KEY_SETTINGS] = s;
        },
    });

    elApiKey.type = "password";
    elApiKey.className = "b3-text-field fn__block";
    plugin.setting.addItem({
        title: "DeepSeek API Key",
        description: "https://platform.deepseek.com 申请，仅存本地。",
        createActionElement: () => {
            elApiKey.value = (plugin.data[STORAGE_KEY_SETTINGS] as typeof defaultSettings).apiKey;
            elApiKey.addEventListener("change", () => void refreshModels());
            return elApiKey;
        },
    });

    elModel.className = "b3-select fn__block";
    plugin.setting.addItem({
        title: "默认模型",
        description: "GET /models 动态拉取。",
        createActionElement: () => {
            void refreshModels();
            return elModel;
        },
    });

    plugin.setting.addItem({
        title: "思考模式",
        description: "DeepSeek reasoning_content。",
        createActionElement: () => {
            elThinking.checked = (plugin.data[STORAGE_KEY_SETTINGS] as typeof defaultSettings).thinkingEnabled;
            return elThinking;
        },
    });

    elInstructions.className = "b3-text-field fn__block";
    elInstructions.rows = 4;
    plugin.setting.addItem({
        title: "全局自定义指令",
        description: "追加到每次 Agent 系统提示。",
        createActionElement: () => {
            elInstructions.value = (plugin.data[STORAGE_KEY_SETTINGS] as typeof defaultSettings).customInstructions;
            return elInstructions;
        },
    });

    elMode.className = "b3-select fn__block";
    elMode.innerHTML = AGENT_MODES.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
    plugin.setting.addItem({
        title: "默认模式",
        description: "新对话的初始模式。",
        createActionElement: () => {
            elMode.value = (plugin.data[STORAGE_KEY_SETTINGS] as typeof defaultSettings).defaultMode;
            return elMode;
        },
    });

    elWorkset.className = "b3-text-field fn__block";
    elWorkset.rows = 4;
    plugin.setting.addItem({
        title: "工作集（笔记本 ID）",
        description: "限制 Agent 可操作的笔记本；下方占位符列出当前笔记本。",
        createActionElement: () => {
            const s = plugin.data[STORAGE_KEY_SETTINGS] as typeof defaultSettings;
            elWorkset.value = s.worksetNotebookIds.join("\n");
            void refreshNotebooks();
            return elWorkset;
        },
    });

    elRisk.className = "b3-text-field fn__block";
    plugin.setting.addItem({
        title: "自动放行风险分上限",
        description: "0–100，低于等于此分的写操作可自动执行（默认 35）。",
        createActionElement: () => {
            elRisk.value = String((plugin.data[STORAGE_KEY_SETTINGS] as typeof defaultSettings).riskAutoApproveMax);
            return elRisk;
        },
    });
}
