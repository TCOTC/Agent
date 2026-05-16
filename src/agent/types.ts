/**
 * 方案 A：进程内 Agent 的类型与 ToolExecutor 抽象。
 * Tool 元数据预留 source 字段，便于未来合并 MCP（方案 E）。
 */

export type ToolSource = "builtin" | "mcp" | "plugin-extension";

/** 风险等级：读 / 写 / SQL（高危） */
export type ToolRisk = "read" | "write" | "sql";

export interface ToolDefinition {
    name: string;
    description: string;
    /** OpenAI tools 参数的 JSON Schema */
    parameters: Record<string, unknown>;
    risk: ToolRisk;
    /** 写操作前是否弹出思源 confirm */
    needsWriteConfirm: boolean;
    source: ToolSource;
}

export const BUILTIN_TOOL_NAMES = [
    "siyuan_get_block_info",
    "siyuan_read_doc",
    "siyuan_search_blocks",
    "siyuan_append_markdown",
    "siyuan_update_markdown",
    "siyuan_sql_query",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export function isBuiltinToolName(name: string): name is BuiltinToolName {
    return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}

/** 内置工具一条定义（`name` 为 {@link BuiltinToolName}） */
export interface BuiltinToolDefinition extends Omit<ToolDefinition, "name" | "source"> {
    name: BuiltinToolName;
    source: "builtin";
}

/** OpenAI `chat.completions` 中 `message.tool_calls[].function`（`name` 未必是 {@link BuiltinToolName}） */
export interface OpenAiToolFunctionPayload {
    name: string;
    arguments: string;
}

/** 单条 `tool_call`（assistant message 与流式快照共用） */
export interface OpenAiToolCallChunk {
    id: string;
    type: "function";
    function: OpenAiToolFunctionPayload;
}

/** 流式 delta 按 `index` 合并时的累积结构 */
export type OpenAiToolStreamAccumPart = {id: string;} & OpenAiToolFunctionPayload;

/** 与 UI 解耦的审计事件，供 Activity 面板演进 */
export type AuditEvent =
    | {
        kind: "llm_request";
        model: string;
        messageCount: number;
        toolCount: number;
    }
    | {
        kind: "llm_response";
        durationMs: number;
        finishReason?: string;
        usage?: Record<string, unknown>;
    }
    | {
        kind: "tool_call";
        toolCallId: string;
        name: string;
        argsPreview: string;
    }
    | {
        kind: "tool_result";
        toolCallId: string;
        name: string;
        ok: boolean;
        durationMs: number;
        error?: string;
    }
    | {
        kind: "tool_blocked";
        name: string;
        reason: string;
    }
    | {
        kind: "user_message";
        preview: string;
    };

/** 内核 HTTP 抽象：未来可换为 MCP / 本机 Server（方案 B/C） */
export interface KernelExecutor {
    post(url: string, body?: Record<string, unknown>): Promise<{
        code: number;
        msg: string;
        data: unknown;
    }>;
}

export interface OpenAICompatibleConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
    role: ChatRole;
    content: string | null;
    name?: string;
    /**
     * DeepSeek 思考模式：带 tool_calls 时必须在后续轮次原样回传，否则会报 invalid_request_error。
     * 见 https://api-docs.deepseek.com/guides/thinking_mode
     */
    reasoning_content?: string | null;
    tool_calls?: OpenAiToolCallChunk[];
    tool_call_id?: string;
}
