import {toolsToDeepSeekFormat} from "../tools/registry";
import type {ChatMessage, DeepSeekConfig, ToolDefinition} from "./types";

export type AgentLlmFailure =
    | {kind: "aborted"}
    | {kind: "no_response_body"}
    | {kind: "invalid_response"}
    | {kind: "http_error"; status: number; bodySnippet: string}
    | {kind: "network_error"; message: string};

export type DeepSeekChatOutcome =
    | {ok: true; result: ChatCompletionResult}
    | {ok: false; failure: AgentLlmFailure};

export interface ChatCompletionResult {
    message: {
        role: string;
        content: string | null;
        reasoning_content?: string | null;
        tool_calls?: import("./types").OpenAiToolCallChunk[];
    };
    finish_reason?: string;
    usage?: Record<string, unknown>;
}

export interface ChatCompletionStreamSnapshot {
    content: string;
    reasoning_content?: string | null;
    tool_calls?: ChatCompletionResult["message"]["tool_calls"];
}

interface StreamAccum {
    content: string;
    reasoning: string;
    toolParts: Map<number, import("./types").OpenAiToolStreamAccumPart>;
    finishReason?: string;
}

export interface DeepSeekModelInfo {
    id: string;
    object?: string;
    owned_by?: string;
}

function joinUrl(base: string, path: string): string {
    const b = base.replace(/\/+$/, "");
    const p = path.replace(/^\/+/, "");
    return `${b}/${p}`;
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
    if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]") {
        return;
    }
    if (!trimmed.startsWith("data: ")) {
        return;
    }
    try {
        const obj = JSON.parse(trimmed.slice(6)) as unknown;
        if (obj && typeof obj === "object") {
            await onEvent(obj as Record<string, unknown>);
        }
    } catch {
        /* ignore partial JSON */
    }
}

function appendReasoningIfPresent(m: ChatMessage, o: Record<string, unknown>): void {
    if (m.reasoning_content !== undefined) {
        o.reasoning_content = m.reasoning_content;
    }
}

function sanitizeForApi(m: ChatMessage): Record<string, unknown> {
    if (m.role === "tool") {
        return {role: "tool", content: m.content ?? "", tool_call_id: m.tool_call_id ?? ""};
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
        const o: Record<string, unknown> = {role: "assistant", tool_calls: m.tool_calls};
        if (m.content != null && m.content !== "") {
            o.content = m.content;
        }
        appendReasoningIfPresent(m, o);
        return o;
    }
    if (m.role === "assistant") {
        const o: Record<string, unknown> = {role: "assistant", content: m.content ?? ""};
        appendReasoningIfPresent(m, o);
        return o;
    }
    return {role: m.role, content: m.content ?? ""};
}

function buildRequestBody(cfg: DeepSeekConfig, messages: ChatMessage[]): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: cfg.model,
        messages: messages.map(sanitizeForApi),
        stream: true,
    };
    const toolDefs: ToolDefinition[] = cfg.tools ?? [];
    if (toolDefs.length) {
        body.tools = toolsToDeepSeekFormat(toolDefs);
        body.tool_choice = "auto";
    }
    const thinking = cfg.thinkingEnabled !== false;
    if (thinking) {
        body.thinking = {type: "enabled"};
        body.reasoning_effort = cfg.reasoningEffort ?? "high";
    } else {
        body.thinking = {type: "disabled"};
    }
    return body;
}

/** 列出 DeepSeek 可用模型 */
export async function listDeepSeekModels(cfg: Pick<DeepSeekConfig, "baseUrl" | "apiKey">): Promise<
    DeepSeekModelInfo[]
> {
    const url = joinUrl(cfg.baseUrl, "models");
    const res = await fetch(url, {
        headers: {Authorization: `Bearer ${cfg.apiKey}`},
    });
    if (!res.ok) {
        const t = await res.text();
        throw new Error(`list models HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const json = (await res.json()) as {data?: DeepSeekModelInfo[]};
    return Array.isArray(json.data) ? json.data : [];
}

export async function deepseekChatCompletion(
    cfg: DeepSeekConfig,
    messages: ChatMessage[],
    signal: AbortSignal,
    onStreamDelta?: (snapshot: ChatCompletionStreamSnapshot) => void,
): Promise<DeepSeekChatOutcome> {
    const url = joinUrl(cfg.baseUrl, "chat/completions");
    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify(buildRequestBody(cfg, messages)),
            signal,
        });
    } catch (e) {
        if (signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
            return {ok: false, failure: {kind: "aborted"}};
        }
        return {
            ok: false,
            failure: {kind: "network_error", message: e instanceof Error ? e.message : String(e)},
        };
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
    const accum: StreamAccum = {content: "", reasoning: "", toolParts: new Map()};
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
        if (delta && typeof delta === "object") {
            applyStreamDelta(accum, delta as Record<string, unknown>);
            onStreamDelta?.(snapshotFromAccum(accum));
        }
    });
    if (sse === "aborted") {
        return {ok: false, failure: {kind: "aborted"}};
    }
    const message = accumToMessage(accum);
    const hasPayload = Boolean(
        message.tool_calls?.length ||
            (message.content && message.content.length > 0) ||
            (message.reasoning_content && message.reasoning_content.length > 0),
    );
    if (!hasPayload) {
        return {ok: false, failure: {kind: "invalid_response"}};
    }
    return {ok: true, result: {message, finish_reason: accum.finishReason, usage}};
}
