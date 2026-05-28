import type {
    ChatMessage,
    DeepSeekConfig,
    OpenAiToolCallChunk,
    ToolDefinition,
} from "../../agent/types";

/** 与 pi 对齐的思考级别（DeepSeek 仅使用 off / high） */
export type ThinkingLevel = "off" | "high" | "max";

export type ToolExecutionMode = "sequential" | "parallel";
export type QueueMode = "all" | "one-at-a-time";

export type UserAgentMessage = {
    role: "user";
    content: string;
    timestamp: number;
};

export type AssistantAgentMessage = ChatMessage & {
    role: "assistant";
    timestamp: number;
    stopReason?: "stop" | "tool_calls" | "error" | "aborted";
    errorMessage?: string;
};

export type ToolResultAgentMessage = {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: string;
    isError?: boolean;
    timestamp: number;
};

/** Agent 层消息：与 LLM / UI 解耦 */
export type AgentMessage = UserAgentMessage | AssistantAgentMessage | ToolResultAgentMessage;

export type AgentToolCall = {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
};

export interface AgentToolResult<TDetails = unknown> {
    content: Array<{type: "text"; text: string}>;
    details: TDetails;
    terminate?: boolean;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (partial: AgentToolResult<TDetails>) => void;

export interface AgentTool<TParams = Record<string, unknown>, TDetails = unknown> {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    executionMode?: ToolExecutionMode;
    execute: (
        toolCallId: string,
        params: TParams,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<TDetails>,
    ) => Promise<AgentToolResult<TDetails>>;
}

export interface BeforeToolCallResult {
    block?: boolean;
    reason?: string;
}

export interface AfterToolCallResult {
    content?: Array<{type: "text"; text: string}>;
    details?: unknown;
    isError?: boolean;
    terminate?: boolean;
}

export interface BeforeToolCallContext {
    assistantMessage: AssistantAgentMessage;
    toolCall: AgentToolCall;
    args: unknown;
    context: AgentContext;
}

export interface AfterToolCallContext {
    assistantMessage: AssistantAgentMessage;
    toolCall: AgentToolCall;
    args: unknown;
    result: AgentToolResult;
    isError: boolean;
    context: AgentContext;
}

export interface AgentContext {
    systemPrompt: string;
    messages: AgentMessage[];
    tools?: AgentTool[];
}

export interface DeepSeekStreamContext {
    systemPrompt: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
}

export type AssistantMessageEvent =
    | {type: "start"; partial: AssistantAgentMessage}
    | {type: "text_start"; partial: AssistantAgentMessage}
    | {type: "text_delta"; partial: AssistantAgentMessage; delta: string}
    | {type: "text_end"; partial: AssistantAgentMessage}
    | {type: "thinking_start"; partial: AssistantAgentMessage}
    | {type: "thinking_delta"; partial: AssistantAgentMessage; delta: string}
    | {type: "thinking_end"; partial: AssistantAgentMessage}
    | {type: "toolcall_start"; partial: AssistantAgentMessage}
    | {type: "toolcall_delta"; partial: AssistantAgentMessage}
    | {type: "toolcall_end"; partial: AssistantAgentMessage}
    | {type: "done"; partial: AssistantAgentMessage}
    | {type: "error"; partial: AssistantAgentMessage; errorMessage: string};

export type AgentEvent =
    | {type: "agent_start"}
    | {type: "agent_end"; messages: AgentMessage[]}
    | {type: "turn_start"}
    | {type: "turn_end"; message: AgentMessage; toolResults: ToolResultAgentMessage[]}
    | {type: "message_start"; message: AgentMessage}
    | {type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent}
    | {type: "message_end"; message: AgentMessage}
    | {
        type: "tool_execution_start";
        toolCallId: string;
        toolName: string;
        args: unknown;
    }
    | {
        type: "tool_execution_update";
        toolCallId: string;
        toolName: string;
        args: unknown;
        partialResult: AgentToolResult;
    }
    | {
        type: "tool_execution_end";
        toolCallId: string;
        toolName: string;
        result: AgentToolResult;
        isError: boolean;
    };

export interface AgentLoopConfig {
    llm: DeepSeekConfig;
    thinkingLevel: ThinkingLevel;
    streamFn: StreamFn;
    convertToLlm: (messages: AgentMessage[]) => ChatMessage[] | Promise<ChatMessage[]>;
    transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
    beforeToolCall?: (
        context: BeforeToolCallContext,
        signal?: AbortSignal,
    ) => Promise<BeforeToolCallResult | undefined>;
    afterToolCall?: (
        context: AfterToolCallContext,
        signal?: AbortSignal,
    ) => Promise<AfterToolCallResult | undefined>;
    getSteeringMessages?: () => Promise<AgentMessage[]>;
    getFollowUpMessages?: () => Promise<AgentMessage[]>;
    toolExecution?: ToolExecutionMode;
}

export interface AgentState {
    systemPrompt: string;
    llm: DeepSeekConfig;
    thinkingLevel: ThinkingLevel;
    tools: AgentTool[];
    messages: AgentMessage[];
    isStreaming: boolean;
    streamingMessage?: AgentMessage;
    pendingToolCalls: ReadonlySet<string>;
    errorMessage?: string;
}

export type StreamFn = (
    config: DeepSeekConfig,
    context: DeepSeekStreamContext,
    signal?: AbortSignal,
) => AssistantMessageEventStream;

/** 流式 LLM 响应：async iterable + result() */
export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
    result(): Promise<AssistantAgentMessage>;
}

export function extractToolCalls(msg: AssistantAgentMessage): AgentToolCall[] {
    if (!msg.tool_calls?.length) {
        return [];
    }
    return msg.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: parseToolArgs(tc.function.arguments),
    }));
}

function parseToolArgs(raw: string): Record<string, unknown> {
    try {
        const v = JSON.parse(raw || "{}");
        return typeof v === "object" && v && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export function openAiToolCallsFromAgent(calls: AgentToolCall[]): OpenAiToolCallChunk[] {
    return calls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
        },
    }));
}
