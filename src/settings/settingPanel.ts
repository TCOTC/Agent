import {Setting, showMessage} from "siyuan";
import type Agent from "../index";
import {AGENT_MODES} from "../agent/modes";
import {listDeepSeekModels} from "../agent/deepseekClient";
import {createFetchSyncKernelExecutor} from "../agent/kernelExecutor";
import {
    getBuiltinModelContextLimit,
    getModelContextLimit,
    getModelContextLimitOverride,
} from "../core/tokenUsage";
import {defaultSettings, normalizeSettings, STORAGE_KEY_SETTINGS} from "./storage";
import {SEND_KEY_MODE_OPTIONS} from "./sendKey";
import {
    fetchSiyuanEmbeddingFields,
    saveSiyuanEmbeddingConfig,
    type SiyuanEmbeddingFields,
} from "./siyuanAiConfig";

export function attachPluginSettingPanel(plugin: Agent): void {
    const elApiKey = document.createElement("input");
    const elModel = document.createElement("select");
    const elThinking = document.createElement("input");
    const elInstructions = document.createElement("textarea");
    const elMode = document.createElement("select");
    const elWorkset = document.createElement("textarea");
    const elRisk = document.createElement("input");
    const elContextLimit = document.createElement("input");
    const elSendKeyMode = document.createElement("select");
    const elEmbeddingModel = document.createElement("input");
    const elEmbeddingBaseURL = document.createElement("input");
    const elEmbeddingApiKey = document.createElement("input");
    elThinking.type = "checkbox";
    elRisk.type = "number";
    elContextLimit.type = "number";
    elContextLimit.min = "1";
    elContextLimit.step = "1";

    const syncContextLimitField = () => {
        const s = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
        const model = elModel.value || s.model;
        const builtin = getBuiltinModelContextLimit(model);
        const override = getModelContextLimitOverride(model, s.modelContextLimits);
        elContextLimit.value = override !== undefined ? String(override) : "";
        const effective = getModelContextLimit(model, s.modelContextLimits);
        const builtinHint = builtin !== undefined ? `内置默认 ${builtin.toLocaleString()}` : "无内置条目";
        elContextLimit.placeholder = builtin !== undefined
            ? String(builtin)
            : String(effective);
        elContextLimit.title = `当前生效：${effective.toLocaleString()} tokens（${builtinHint}）`;
    };

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
            syncContextLimitField();
        } catch {
            elModel.innerHTML = `<option>${s.model}</option>`;
            syncContextLimitField();
        }
    };

    const syncEmbeddingFields = (fields: SiyuanEmbeddingFields) => {
        elEmbeddingModel.value = fields.embeddingModel;
        elEmbeddingBaseURL.value = fields.embeddingBaseURL;
        elEmbeddingApiKey.value = fields.embeddingAPIKey;
    };

    const refreshEmbeddingConfig = async () => {
        const fields = await fetchSiyuanEmbeddingFields();
        if (fields) {
            syncEmbeddingFields(fields);
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
            const prev = normalizeSettings(plugin.data[STORAGE_KEY_SETTINGS]);
            const model = elModel.value || defaultSettings.model;
            const limits = {...prev.modelContextLimits};
            const rawLimit = elContextLimit.value.trim();
            const parsedLimit = Number(rawLimit);
            const builtin = getBuiltinModelContextLimit(model);
            if (!rawLimit || !Number.isFinite(parsedLimit) || parsedLimit <= 0) {
                delete limits[model];
            } else {
                const v = Math.floor(parsedLimit);
                if (builtin !== undefined && v === builtin) {
                    delete limits[model];
                } else {
                    limits[model] = v;
                }
            }
            const s = normalizeSettings({
                baseUrl: defaultSettings.baseUrl,
                apiKey: elApiKey.value.trim(),
                model,
                thinkingEnabled: elThinking.checked,
                customInstructions: elInstructions.value,
                defaultMode: elMode.value,
                worksetNotebookIds: ids,
                riskAutoApproveMax: Number(elRisk.value) || defaultSettings.riskAutoApproveMax,
                modelContextLimits: limits,
                sendKeyMode: elSendKeyMode.value,
            });
            void plugin.persistPluginSettings(s);
            void (async () => {
                const embedResult = await saveSiyuanEmbeddingConfig({
                    embeddingModel: elEmbeddingModel.value,
                    embeddingBaseURL: elEmbeddingBaseURL.value,
                    embeddingAPIKey: elEmbeddingApiKey.value,
                });
                if (!embedResult.ok) {
                    showMessage(`嵌入模型配置未保存：${embedResult.msg}`, 5000, "error");
                }
            })();
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
            elModel.addEventListener("change", () => syncContextLimitField());
            return elModel;
        },
    });

    elContextLimit.className = "b3-text-field fn__block";
    plugin.setting.addItem({
        title: "上下文容量（tokens）",
        description:
            "当前默认模型的上下文窗口上限。deepseek-v4-flash / deepseek-v4-pro 内置 1,000,000；留空使用内置或 64,000 兜底。",
        createActionElement: () => {
            syncContextLimitField();
            return elContextLimit;
        },
    });

    elEmbeddingModel.className = "b3-text-field fn__block";
    plugin.setting.addItem({
        title: "嵌入模型",
        description: "思源内核块向量索引所用模型名（如 text-embedding-3-small）。写入「设置 → 人工智能」。",
        createActionElement: () => {
            void refreshEmbeddingConfig();
            return elEmbeddingModel;
        },
    });

    elEmbeddingBaseURL.className = "b3-text-field fn__block";
    plugin.setting.addItem({
        title: "嵌入 API Base URL",
        description: "OpenAI 兼容嵌入接口地址；留空时由内核按环境变量或默认逻辑处理。",
        createActionElement: () => elEmbeddingBaseURL,
    });

    elEmbeddingApiKey.type = "password";
    elEmbeddingApiKey.className = "b3-text-field fn__block";
    plugin.setting.addItem({
        title: "嵌入 API Key",
        description: "可与对话 API Key 不同；留空时尝试 SIYUAN_OPENAI_EMBEDDING_API_KEY 环境变量。",
        createActionElement: () => elEmbeddingApiKey,
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

    elSendKeyMode.className = "b3-select fn__block";
    elSendKeyMode.innerHTML = SEND_KEY_MODE_OPTIONS.map((o) =>
        `<option value="${o.id}">${o.label}</option>`,
    ).join("");
    plugin.setting.addItem({
        title: "发送快捷键",
        description: SEND_KEY_MODE_OPTIONS.map((o) => o.description).join("；"),
        createActionElement: () => {
            const s = plugin.data[STORAGE_KEY_SETTINGS] as typeof defaultSettings;
            elSendKeyMode.value = s.sendKeyMode ?? defaultSettings.sendKeyMode;
            return elSendKeyMode;
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
        description: "0–100。风险分 ≤ 此值可自动执行，> 此值需确认（默认 35）。删除等高基础分操作在阈值较低时仍会要求确认。",
        createActionElement: () => {
            elRisk.value = String((plugin.data[STORAGE_KEY_SETTINGS] as typeof defaultSettings).riskAutoApproveMax);
            return elRisk;
        },
    });
}
