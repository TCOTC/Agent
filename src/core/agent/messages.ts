import type {ChatMessage} from "../../agent/types";
import type {AgentMessage, AssistantAgentMessage, ToolResultAgentMessage, UserAgentMessage} from "./types";

export function userMessage(content: string): UserAgentMessage {
    return {role: "user", content, timestamp: Date.now()};
}

export function assistantMessage(partial: Partial<AssistantAgentMessage> = {}): AssistantAgentMessage {
    return {
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        ...partial,
    };
}

export function toolResultMessage(
    toolCallId: string,
    toolName: string,
    content: string,
    isError = false,
): ToolResultAgentMessage {
    return {
        role: "toolResult",
        toolCallId,
        toolName,
        content,
        isError,
        timestamp: Date.now(),
    };
}

/** AgentMessage[] → DeepSeek API 消息（system 由 context 单独注入） */
export function convertToLlm(messages: AgentMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const m of messages) {
        if (m.role === "user") {
            out.push({role: "user", content: m.content});
        } else if (m.role === "assistant") {
            const a: ChatMessage = {
                role: "assistant",
                content: m.content ?? "",
            };
            if (m.reasoning_content !== undefined) {
                a.reasoning_content = m.reasoning_content;
            }
            if (m.tool_calls?.length) {
                a.tool_calls = m.tool_calls;
            }
            out.push(a);
        } else if (m.role === "toolResult") {
            out.push({
                role: "tool",
                tool_call_id: m.toolCallId,
                content: m.content,
            });
        }
    }
    return out;
}

/** 会话持久化格式 → AgentMessage */
export function chatToAgent(messages: ChatMessage[]): AgentMessage[] {
    const out: AgentMessage[] = [];
    for (const m of messages) {
        if (m.role === "user") {
            out.push({role: "user", content: m.content ?? "", timestamp: Date.now()});
        } else if (m.role === "assistant") {
            out.push({...m, role: "assistant", timestamp: Date.now()});
        } else if (m.role === "tool") {
            out.push({
                role: "toolResult",
                toolCallId: m.tool_call_id ?? "",
                toolName: "",
                content: m.content ?? "",
                timestamp: Date.now(),
            });
        }
    }
    return out;
}

/** 就地更新 ChatMessage，保持对象引用稳定（供 UI WeakMap / 流式 DOM 缓存） */
export function patchChatFromAgent(target: ChatMessage, source: AgentMessage): void {
    if (source.role === "user") {
        target.role = "user";
        target.content = source.content;
        delete target.reasoning_content;
        delete target.tool_calls;
        delete target.tool_call_id;
        delete target._toolStatus;
        delete target._toolResults;
        delete target._toolHint;
        delete target._toolConfirm;
        delete target._toolDiff;
        delete target._streaming;
        return;
    }

    if (source.role === "assistant") {
        target.role = "assistant";
        const nextContent = source.content ?? "";
        const prevContent = target.content ?? "";
        const sourceAsst = source as AssistantAgentMessage;
        const preserveEmptyOnAbort =
            sourceAsst.stopReason === "aborted" &&
            nextContent === "" &&
            prevContent !== "";
        const preserveEmptyDuringTools =
            nextContent === "" && prevContent !== "" && source.tool_calls?.length && target._streaming;
        const ignoreStreamingShrink =
            target._streaming &&
            prevContent !== "" &&
            nextContent !== "" &&
            nextContent.length < prevContent.length &&
            prevContent.startsWith(nextContent);
        if (preserveEmptyOnAbort || preserveEmptyDuringTools || ignoreStreamingShrink) {
            /* 保留已有正文，避免封存 prefix 失效引发 cacheReset 与 md2html 风暴 */
        } else {
            target.content = nextContent;
        }
        if (source.reasoning_content !== undefined) {
            const nextReasoning = source.reasoning_content;
            const prevReasoning = target.reasoning_content ?? "";
            const preserveReasoningOnAbort =
                sourceAsst.stopReason === "aborted" &&
                nextReasoning === "" &&
                prevReasoning !== "";
            const ignoreReasoningShrink =
                target._streaming &&
                prevReasoning !== "" &&
                nextReasoning.length < prevReasoning.length &&
                prevReasoning.startsWith(nextReasoning);
            if (!preserveReasoningOnAbort && !ignoreReasoningShrink) {
                target.reasoning_content = nextReasoning;
            }
        } else {
            delete target.reasoning_content;
        }
        if (source.tool_calls?.length) {
            target.tool_calls = source.tool_calls;
        } else {
            delete target.tool_calls;
        }
        delete target.tool_call_id;
        if (source._toolStatus) {
            target._toolStatus = source._toolStatus;
        } else {
            delete target._toolStatus;
        }
        if (source._toolResults) {
            target._toolResults = source._toolResults;
        } else {
            delete target._toolResults;
        }
        if (source._toolHint) {
            target._toolHint = source._toolHint;
        } else {
            delete target._toolHint;
        }
        if (source._toolConfirm) {
            target._toolConfirm = source._toolConfirm;
        } else {
            delete target._toolConfirm;
        }
        if (source._toolDiff) {
            target._toolDiff = source._toolDiff;
        } else {
            delete target._toolDiff;
        }
        return;
    }

    if (source.role === "toolResult") {
        target.role = "tool";
        target.tool_call_id = source.toolCallId;
        target.content = source.content;
        delete target.reasoning_content;
        delete target.tool_calls;
        delete target._toolStatus;
        delete target._toolResults;
        delete target._toolHint;
        delete target._toolConfirm;
        delete target._toolDiff;
    }
}

/** 新建 ChatMessage（仅在新消息首次出现时使用） */
export function createChatFromAgent(source: AgentMessage): ChatMessage {
    if (source.role === "user") {
        return {role: "user", content: source.content};
    }
    if (source.role === "assistant") {
        const m: ChatMessage = {role: "assistant", content: source.content ?? ""};
        patchChatFromAgent(m, source);
        return m;
    }
    return {
        role: "tool",
        tool_call_id: source.toolCallId,
        content: source.content,
    };
}

/** AgentMessage → 会话持久化格式（每次新建对象，仅用于持久化快照） */
export function agentToChat(messages: AgentMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const m of messages) {
        if (m.role === "user") {
            out.push({role: "user", content: m.content});
        } else if (m.role === "assistant") {
            const {timestamp: _ts, stopReason: _sr, errorMessage: _em, ...rest} = m;
            out.push(rest);
        } else if (m.role === "toolResult") {
            out.push({
                role: "tool",
                tool_call_id: m.toolCallId,
                content: m.content,
            });
        }
    }
    return out;
}
