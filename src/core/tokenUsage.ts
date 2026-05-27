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
