import type {
    AgentStoredSettings,
    AgentStoredWorkset,
} from "./types";

export const STORAGE_AGENT_SETTINGS = "agent-settings";
export const STORAGE_AGENT_WORKSET = "agent-workset";

export const defaultAgentSettings: AgentStoredSettings = {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    allowSqlTool: false,
};

export const defaultWorkset: AgentStoredWorkset = {
    rootIds: [],
};

export function normalizeSettings(raw: unknown): AgentStoredSettings {
    if (!raw || typeof raw !== "object") {
        return {...defaultAgentSettings};
    }
    const o = raw as Record<string, unknown>;
    return {
        baseUrl: typeof o.baseUrl === "string" && o.baseUrl ? o.baseUrl : defaultAgentSettings.baseUrl,
        apiKey: typeof o.apiKey === "string" ? o.apiKey : "",
        model: typeof o.model === "string" && o.model ? o.model : defaultAgentSettings.model,
        allowSqlTool: Boolean(o.allowSqlTool),
    };
}

export function normalizeWorkset(raw: unknown): AgentStoredWorkset {
    if (!raw || typeof raw !== "object") {
        return {rootIds: [...defaultWorkset.rootIds]};
    }
    const ids = (raw as {rootIds?: unknown;}).rootIds;
    if (!Array.isArray(ids)) {
        return {rootIds: []};
    }
    return {
        rootIds: ids.filter((x): x is string => typeof x === "string" && x.length > 0),
    };
}
