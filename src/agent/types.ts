/**
 * Tool 名称与运行时类型。
 */

export type ToolSource = "builtin" | "mcp" | "plugin-extension";

export type ToolRisk = "read" | "ui" | "write" | "delete" | "sql";

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    risk: ToolRisk;
    alwaysConfirm?: boolean;
    source: ToolSource;
}

export const TOOL_NAMES = [
    "siyuan_get_block_info",
    "siyuan_read_markdown",
    "siyuan_read_kramdown",
    "siyuan_search_blocks",
    "siyuan_list_child_blocks",
    "siyuan_get_doc_outline",
    "siyuan_get_backlinks",
    "siyuan_get_block_attributes",
    "siyuan_get_recent_docs",
    "siyuan_list_notebooks",
    "siyuan_list_documents",
    "siyuan_open_document",
    "siyuan_focus_block",
    "siyuan_append_markdown",
    "siyuan_insert_markdown",
    "siyuan_update_markdown",
    "siyuan_edit_block_kramdown",
    "siyuan_move_block",
    "siyuan_set_block_attributes",
    "siyuan_create_document",
    "siyuan_rename_document",
    "siyuan_edit_document",
    "siyuan_delete_block",
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
    | {kind: "tool_confirm_result"; name: string; approved: boolean}
    | {kind: "pending_edit"; docId: string; adds: number; removes: number};

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
    thinkingEnabled?: boolean;
    reasoningEffort?: "high" | "max";
    /** 若提供则仅发送这些 tools */
    tools?: ToolDefinition[];
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
    role: ChatRole;
    content: string | null;
    reasoning_content?: string | null;
    tool_calls?: OpenAiToolCallChunk[];
    tool_call_id?: string;
    /** UI：工具执行状态 */
    _toolStatus?: Record<string, "running" | "ok" | "fail">;
    /** UI：工具返回文本（按 tool_call id） */
    _toolResults?: Record<string, string>;
    /** UI：长时间等待时的提示（如 diff 确认） */
    _toolHint?: Record<string, string>;
}

export type OpenAICompatibleConfig = DeepSeekConfig;
