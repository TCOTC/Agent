import {
    getBuiltinToolDefinitions,
    toolsToOpenAIFormat,
} from "./builtinTools";
import type {
    ChatMessage,
    OpenAICompatibleConfig,
    OpenAiToolCallChunk,
    OpenAiToolStreamAccumPart,
} from "./types";

/** 临时：每次流式 delta 回调后休眠（毫秒），便于观察 UI；设为 0 关闭 */
const STREAM_DELTA_DEBUG_THROTTLE_MS = 0;

/**
 * 临时调试：为 true 时请求不带 tools；`agentLoop.ts` 同步不注入系统提示。
 * 改这一处即可。
 */
export const LLM_DEBUG_PLAIN_CHAT = false;

/** 休眠或在中止时提前结束（不抛错，由外层读循环根据 `signal` 收尾） */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) {
        return Promise.resolve();
    }
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const t = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            resolve();
        };
        signal.addEventListener("abort", onAbort, {once: true});
    });
}

/** 单次 chat/completions（流式）的可预期失败，不作为异常向上抛 */
export type AgentLlmFailure =
    | {kind: "aborted"}
    | {kind: "no_response_body"}
    | {kind: "invalid_openai_response"}
    | {kind: "http_error"; status: number; bodySnippet: string}
    | {kind: "network_error"; message: string};

export type OpenAIChatCompletionOutcome =
    | {ok: true; result: ChatCompletionResult}
    | {ok: false; failure: AgentLlmFailure};

export interface ChatCompletionResult {
    message: {
        role: string;
        content: string | null;
        /** DeepSeek thinking mode，需写回下一轮 messages */
        reasoning_content?: string | null;
        tool_calls?: OpenAiToolCallChunk[];
    };
    finish_reason?: string;
    usage?: Record<string, unknown>;
}

/** 流式过程中供 UI 展示的增量快照（与最终 message 结构对齐） */
export interface ChatCompletionStreamSnapshot {
    content: string;
    reasoning_content?: string | null;
    tool_calls?: ChatCompletionResult["message"]["tool_calls"];
}

interface StreamAccum {
    content: string;
    reasoning: string;
    /** 按 OpenAI stream 的 index 合并分片 */
    toolParts: Map<number, OpenAiToolStreamAccumPart>;
    finishReason?: string;
}

function snapshotFromAccum(a: StreamAccum): ChatCompletionStreamSnapshot {
    const tool_calls = a.toolParts.size ?
        [...a.toolParts.keys()].sort((x, y) => x - y).map((idx) => {
            const p = a.toolParts.get(idx)!;
            return {
                id: p.id,
                type: "function" as const,
                function: {name: p.name, arguments: p.arguments},
            };
        }) :
        undefined;
    const snap: ChatCompletionStreamSnapshot = {content: a.content};
    if (a.reasoning !== "") {
        snap.reasoning_content = a.reasoning;
    }
    if (tool_calls?.length) {
        snap.tool_calls = tool_calls;
    }
    return snap;
}

function accumToMessage(a: StreamAccum): ChatCompletionResult["message"] {
    const snap = snapshotFromAccum(a);
    return {
        role: "assistant",
        content: snap.content || null,
        reasoning_content: snap.reasoning_content,
        tool_calls: snap.tool_calls,
    };
}

function applyStreamDelta(a: StreamAccum, delta: Record<string, unknown>): void {
    const content = delta.content;
    if (typeof content === "string" && content.length) {
        a.content += content;
    }
    const rc = delta.reasoning_content;
    if (typeof rc === "string" && rc.length) {
        a.reasoning += rc;
    }
    const tcs = delta.tool_calls;
    if (!Array.isArray(tcs)) {
        return;
    }
    for (const raw of tcs) {
        if (!raw || typeof raw !== "object") {
            continue;
        }
        const tc = raw as Record<string, unknown>;
        const index = typeof tc.index === "number" ? tc.index : 0;
        let part = a.toolParts.get(index);
        if (!part) {
            part = {id: "", name: "", arguments: ""};
            a.toolParts.set(index, part);
        }
        if (typeof tc.id === "string" && tc.id) {
            part.id = tc.id;
        }
        const fn = tc.function;
        if (fn && typeof fn === "object") {
            const f = fn as Record<string, unknown>;
            if (typeof f.name === "string" && f.name) {
                part.name = f.name;
            }
            if (typeof f.arguments === "string" && f.arguments) {
                part.arguments += f.arguments;
            }
        }
    }
}

async function readChatCompletionSse(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    onEvent: (obj: Record<string, unknown>) => void | Promise<void>,
): Promise<"ok" | "aborted"> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let carry = "";
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (signal.aborted) {
                await reader.cancel();
                return "aborted";
            }
            if (done) {
                break;
            }
            carry += decoder.decode(value, {stream: true});
            let nl: number;
            while ((nl = carry.indexOf("\n")) >= 0) {
                const line = carry.slice(0, nl);
                carry = carry.slice(nl + 1);
                await parseSseLine(line, onEvent);
            }
        }
        await parseSseLine(carry, onEvent);
    } finally {
        reader.releaseLock();
    }
    return "ok";
}

async function parseSseLine(
    line: string,
    onEvent: (obj: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed || trimmed.startsWith(":")) {
        return;
    }
    if (trimmed === "data: [DONE]") {
        return;
    }
    if (!trimmed.startsWith("data: ")) {
        return;
    }
    const jsonStr = trimmed.slice(6);
    let obj: unknown;
    try {
        obj = JSON.parse(jsonStr) as unknown;
    } catch {
        return;
    }
    if (obj && typeof obj === "object") {
        await onEvent(obj as Record<string, unknown>);
    }
}

function joinUrl(base: string, path: string): string {
    const b = base.replace(/\/+$/, "");
    const p = path.replace(/^\/+/, "");
    return `${b}/${p}`;
}

function appendReasoningIfPresent(
    m: ChatMessage,
    o: Record<string, unknown>,
): void {
    if (m.reasoning_content !== undefined) {
        o.reasoning_content = m.reasoning_content;
    }
}

function sanitizeForApi(m: ChatMessage): Record<string, unknown> {
    if (m.role === "tool") {
        return {
            role: "tool",
            content: m.content ?? "",
            tool_call_id: m.tool_call_id ?? "",
        };
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
        const o: Record<string, unknown> = {
            role: "assistant",
            tool_calls: m.tool_calls,
        };
        if (m.content != null && m.content !== "") {
            o.content = m.content;
        }
        appendReasoningIfPresent(m, o);
        return o;
    }
    if (m.role === "assistant") {
        const o: Record<string, unknown> = {
            role: "assistant",
            content: m.content ?? "",
        };
        appendReasoningIfPresent(m, o);
        return o;
    }
    return {role: m.role, content: m.content ?? ""};
}

export async function openAIChatCompletion(
    cfg: OpenAICompatibleConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
    onStreamDelta?: (snapshot: ChatCompletionStreamSnapshot) => void,
): Promise<OpenAIChatCompletionOutcome> {
    const url = joinUrl(cfg.baseUrl, "chat/completions");
    const body: Record<string, unknown> = {
        model: cfg.model,
        messages: messages.map(sanitizeForApi),
        temperature: 0.2,
        stream: true,
    };
    if (!LLM_DEBUG_PLAIN_CHAT) {
        body.tools = toolsToOpenAIFormat(getBuiltinToolDefinitions());
        body.tool_choice = "auto";
    }
    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify(body),
            signal,
        });
    } catch (e) {
        if (signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
            return {ok: false, failure: {kind: "aborted"}};
        }
        const message = e instanceof Error ? e.message : String(e);
        return {ok: false, failure: {kind: "network_error", message}};
    }
    if (!res.ok) {
        const t = await res.text();
        return {
            ok: false,
            failure: {kind: "http_error", status: res.status, bodySnippet: t.slice(0, 500)},
        };
    }
    const streamBody = res.body;
    if (!streamBody) {
        return {ok: false, failure: {kind: "no_response_body"}};
    }
    const accum: StreamAccum = {
        content: "",
        reasoning: "",
        toolParts: new Map(),
    };
    let usage: Record<string, unknown> | undefined;

    const sse = await readChatCompletionSse(streamBody, signal, async (obj) => {
        const u = obj.usage;
        if (u && typeof u === "object") {
            usage = u as Record<string, unknown>;
        }
        const choices = obj.choices;
        if (!Array.isArray(choices) || choices.length === 0) {
            return;
        }
        const ch0 = choices[0] as Record<string, unknown>;
        const fr = ch0.finish_reason;
        if (typeof fr === "string" && fr) {
            accum.finishReason = fr;
        }
        const delta = ch0.delta;
        if (!delta || typeof delta !== "object") {
            return;
        }
        applyStreamDelta(accum, delta as Record<string, unknown>);
        onStreamDelta?.(snapshotFromAccum(accum));
        if (onStreamDelta && STREAM_DELTA_DEBUG_THROTTLE_MS > 0) {
            await sleepAbortable(STREAM_DELTA_DEBUG_THROTTLE_MS, signal);
        }
    });
    if (sse === "aborted") {
        return {ok: false, failure: {kind: "aborted"}};
    }

    const message = accumToMessage(accum);
    const hasTools = Boolean(message.tool_calls?.length);
    const hasText = Boolean(
        (message.content && message.content.length > 0) ||
            (message.reasoning_content && message.reasoning_content.length > 0),
    );
    if (!hasTools && !hasText) {
        return {ok: false, failure: {kind: "invalid_openai_response"}};
    }
    return {
        ok: true,
        result: {
            message,
            finish_reason: accum.finishReason,
            usage,
        },
    };
}
