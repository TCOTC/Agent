import {
    getBuiltinToolDefinitions,
    toolsToOpenAIFormat,
} from "./builtinTools";
import type {
    ChatMessage,
    OpenAICompatibleConfig,
} from "./types";

export interface ChatCompletionResult {
    message: {
        role: string;
        content: string | null;
        /** DeepSeek thinking mode，需写回下一轮 messages */
        reasoning_content?: string | null;
        tool_calls?: Array<{
            id: string;
            type: "function";
            function: {name: string; arguments: string;};
        }>;
    };
    finish_reason?: string;
    usage?: Record<string, unknown>;
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
    allowSqlTool: boolean,
    signal: AbortSignal,
): Promise<ChatCompletionResult> {
    const tools = toolsToOpenAIFormat(getBuiltinToolDefinitions(allowSqlTool));
    const url = joinUrl(cfg.baseUrl, "chat/completions");
    const body = {
        model: cfg.model,
        messages: messages.map(sanitizeForApi),
        tools,
        tool_choice: "auto",
        temperature: 0.2,
    };
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const t = await res.text();
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
        choices?: Array<{
            finish_reason?: string;
            message?: ChatCompletionResult["message"];
        }>;
        usage?: Record<string, unknown>;
    };
    const choice = json.choices?.[0];
    if (!choice?.message) {
        throw new Error("invalid_openai_response");
    }
    return {
        message: choice.message,
        finish_reason: choice.finish_reason,
        usage: json.usage,
    };
}
