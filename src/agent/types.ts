/**
 * Agent 运行时类型：Tool 元数据、消息、审计、内核抽象。
 */

export type ToolSource = "builtin" | "mcp" | "plugin-extension";

/** 风险等级 */
export type ToolRisk = "read" | "ui" | "write" | "delete" | "sql";

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    risk: ToolRisk;
    /** 无论风险分均须用户确认 */
    alwaysConfirm?: boolean;
    source: ToolSource;
}

export const TOOL_NAMES = [
    "siyuan_get_block_info",
    "siyuan_read_markdown",
    "siyuan_read_kramdown",
    "siyuan_search_blocks",
    "siyuan_list_child_blocks",
    "siyuan_open_document",
    "siyuan_focus_block",
    "siyuan_append_markdown",
    "siyuan_update_markdown",
    "siyuan_edit_block_kramdown",
    "siyuan_delete_block",
    "siyuan_move_block",
    "siyuan_insert_markdown",
    "siyuan_sql_query",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(name: string): name is ToolName {
    return (TOOL_NAMES as readonly string[]).includes(name);
}

export interface OpenAiToolFunctionPayload {
    name: string;
    arguments: string;
}

export interface OpenAiToolCallChunk {
    id: string;
    type: "function";
    function: OpenAiToolFunctionPayload;
}

export type OpenAiToolStreamAccumPart = {id: string;} & OpenAiToolFunctionPayload;

export type AuditEvent =
    | {kind: "user_message"; preview: string}
    | {kind: "llm_request"; model: string; messageCount: number; toolCount: number}
    | {
        kind: "llm_response";
        durationMs: number;
        finishReason?: string;
        usage?: Record<string, unknown>;
    }
    | {kind: "tool_call"; toolCallId: string; name: string; argsPreview: string}
    | {
        kind: "tool_result";
        toolCallId: string;
        name: string;
        ok: boolean;
        durationMs: number;
        error?: string;
        riskScore?: number;
        autoApproved?: boolean;
    }
    | {kind: "tool_blocked"; name: string; reason: string}
    | {kind: "tool_confirm_required"; name: string; detail: string; riskScore: number}
    | {kind: "tool_confirm_result"; name: string; approved: boolean};

export interface KernelExecutor {
    post(url: string, body?: Record<string, unknown>): Promise<{
        code: number;
        msg: string;
        data: unknown;
    }>;
}

export interface DeepSeekConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    /** 思考模式 */
    thinkingEnabled?: boolean;
    reasoningEffort?: "high" | "max";
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
    role: ChatRole;
    content: string | null;
    reasoning_content?: string | null;
    tool_calls?: OpenAiToolCallChunk[];
    tool_call_id?: string;
}

/** @deprecated 兼容旧名 */
export type OpenAICompatibleConfig = DeepSeekConfig;
