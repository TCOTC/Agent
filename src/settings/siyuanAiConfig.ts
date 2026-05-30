import {postKernelJson} from "../kernelPostJson";

/** 插件设置面板维护的嵌入字段（与内核 JSON 键名一致） */
export interface SiyuanEmbeddingFields {
    embeddingModel: string;
    embeddingBaseURL: string;
    embeddingAPIKey: string;
}

/** 内核 `conf.AI.openAI`：从 getConf 原样透传，不枚举全部字段以免与思源版本脱节 */
export type SiyuanOpenAIPayload = Record<string, unknown>;

type HostWindow = Window & {
    siyuan?: {config?: {ai?: {openAI?: SiyuanOpenAIPayload}}};
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceEmbeddingString(v: unknown): string {
    return typeof v === "string" ? v : "";
}

/** 从 openAI 配置块提取嵌入三项（供 UI 展示） */
export function pickEmbeddingFields(openAI: SiyuanOpenAIPayload): SiyuanEmbeddingFields {
    return {
        embeddingModel: coerceEmbeddingString(openAI.embeddingModel),
        embeddingBaseURL: coerceEmbeddingString(openAI.embeddingBaseURL),
        embeddingAPIKey: coerceEmbeddingString(openAI.embeddingAPIKey),
    };
}

function readHostOpenAIPayload(): SiyuanOpenAIPayload | null {
    const openAI = (window as HostWindow).siyuan?.config?.ai?.openAI;
    return isPlainObject(openAI) ? {...openAI} : null;
}

/** 读取思源全局 openAI 配置块（优先 getConf，回退内存 config） */
export async function fetchSiyuanOpenAIPayload(): Promise<SiyuanOpenAIPayload | null> {
    const res = await postKernelJson<{ai?: {openAI?: unknown}}>("/api/system/getConf", {});
    if (res.code === 0 && isPlainObject(res.data?.ai?.openAI)) {
        return {...res.data.ai.openAI};
    }
    return readHostOpenAIPayload();
}

export async function fetchSiyuanEmbeddingFields(): Promise<SiyuanEmbeddingFields | null> {
    const openAI = await fetchSiyuanOpenAIPayload();
    return openAI ? pickEmbeddingFields(openAI) : null;
}

function syncHostOpenAIPayload(openAI: SiyuanOpenAIPayload): void {
    const host = window as HostWindow;
    if (!host.siyuan?.config?.ai) {
        return;
    }
    host.siyuan.config.ai.openAI = openAI;
}

/** 仅更新嵌入相关三项：在现有 openAI 对象上合并后整包 setAI */
export async function saveSiyuanEmbeddingConfig(
    embedding: SiyuanEmbeddingFields,
): Promise<{ok: boolean; msg: string}> {
    const current = await fetchSiyuanOpenAIPayload();
    if (!current) {
        return {ok: false, msg: "无法读取思源 AI 配置"};
    }
    const openAI: SiyuanOpenAIPayload = {
        ...current,
        embeddingModel: embedding.embeddingModel.trim(),
        embeddingBaseURL: embedding.embeddingBaseURL.trim(),
        embeddingAPIKey: embedding.embeddingAPIKey.trim(),
    };
    const res = await postKernelJson<{openAI?: unknown}>("/api/setting/setAI", {openAI});
    if (res.code !== 0) {
        return {ok: false, msg: res.msg || "保存嵌入配置失败"};
    }
    const saved = res.data?.openAI;
    syncHostOpenAIPayload(isPlainObject(saved) ? {...saved} : openAI);
    return {ok: true, msg: ""};
}
