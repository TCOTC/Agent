export interface TokenUsageRecord {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens?: number;
    reasoningTokens?: number;
}

export interface TokenStatsPersisted {
    lifetime: TokenUsageRecord;
    sessions: Record<string, TokenUsageRecord>;
    lastUpdated: string;
}

export function emptyUsage(): TokenUsageRecord {
    return {promptTokens: 0, completionTokens: 0, totalTokens: 0};
}

export function parseDeepSeekUsage(raw: Record<string, unknown> | undefined): TokenUsageRecord | undefined {
    if (!raw) {
        return undefined;
    }
    const prompt = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0);
    const completion = Number(raw.completion_tokens ?? raw.output_tokens ?? 0);
    const total = Number(raw.total_tokens ?? prompt + completion);
    const cached = raw.prompt_cache_hit_tokens ?? raw.cached_tokens;
    const reasoning = raw.reasoning_tokens ?? raw.completion_tokens_details;
    const u: TokenUsageRecord = {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total,
    };
    if (typeof cached === "number") {
        u.cachedPromptTokens = cached;
    }
    if (typeof reasoning === "number") {
        u.reasoningTokens = reasoning;
    } else if (reasoning && typeof reasoning === "object") {
        const r = (reasoning as Record<string, unknown>).reasoning_tokens;
        if (typeof r === "number") {
            u.reasoningTokens = r;
        }
    }
    return u;
}

export function mergeUsage(a: TokenUsageRecord, b: TokenUsageRecord): TokenUsageRecord {
    return {
        promptTokens: a.promptTokens + b.promptTokens,
        completionTokens: a.completionTokens + b.completionTokens,
        totalTokens: a.totalTokens + b.totalTokens,
        cachedPromptTokens: (a.cachedPromptTokens ?? 0) + (b.cachedPromptTokens ?? 0) || undefined,
        reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) || undefined,
    };
}

/** DeepSeek 公开规格中的上下文窗口（API 不返回） */
export const BUILTIN_MODEL_CONTEXT_LIMITS: Readonly<Record<string, number>> = {
    "deepseek-v4-flash": 1_000_000,
    "deepseek-v4-pro": 1_000_000,
};

const FALLBACK_CONTEXT_LIMIT = 64_000;

function normalizeModelId(model: string): string {
    return model.trim().toLowerCase();
}

/** 内置表中的上下文上限；未知模型返回 undefined */
export function getBuiltinModelContextLimit(model: string): number | undefined {
    const m = normalizeModelId(model);
    const exact = BUILTIN_MODEL_CONTEXT_LIMITS[m];
    if (exact !== undefined) {
        return exact;
    }
    if (m.includes("v4-flash")) {
        return BUILTIN_MODEL_CONTEXT_LIMITS["deepseek-v4-flash"];
    }
    if (m.includes("v4-pro")) {
        return BUILTIN_MODEL_CONTEXT_LIMITS["deepseek-v4-pro"];
    }
    return undefined;
}

/** 设置中针对某模型的覆盖值（大小写不敏感匹配 model id） */
export function getModelContextLimitOverride(
    model: string,
    overrides?: Record<string, number>,
): number | undefined {
    return lookupContextOverride(model, overrides);
}

function lookupContextOverride(
    model: string,
    overrides?: Record<string, number>,
): number | undefined {
    if (!overrides) {
        return undefined;
    }
    const m = normalizeModelId(model);
    for (const [id, tokens] of Object.entries(overrides)) {
        if (id.trim().toLowerCase() === m) {
            const n = Number(tokens);
            if (Number.isFinite(n) && n > 0) {
                return Math.floor(n);
            }
        }
    }
    return undefined;
}

/** 模型上下文窗口上限（DeepSeek API 不返回该值） */
export function getModelContextLimit(
    model: string,
    overrides?: Record<string, number>,
): number {
    const custom = lookupContextOverride(model, overrides);
    if (custom !== undefined) {
        return custom;
    }
    return getBuiltinModelContextLimit(model) ?? FALLBACK_CONTEXT_LIMIT;
}

export function formatTokenBrief(u: TokenUsageRecord): string {
    let s = `输入 ${u.promptTokens} · 输出 ${u.completionTokens}`;
    if (u.reasoningTokens) {
        s += ` · 思考 ${u.reasoningTokens}`;
    }
    if (u.cachedPromptTokens) {
        s += ` · 缓存 ${u.cachedPromptTokens}`;
    }
    return s;
}
