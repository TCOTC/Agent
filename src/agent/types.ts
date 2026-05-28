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
    "get_block_info",
    "read_markdown",
    "read_kramdown",
    "search_blocks",
    "list_child_blocks",
    "get_doc_outline",
    "get_backlinks",
    "get_block_attributes",
    "get_recent_docs",
    "list_notebooks",
    "list_documents",
    "open_document",
    "focus_block",
    "append_markdown",
    "batch_append_markdown",
    "insert_markdown",
    "batch_insert_markdown",
    "update_markdown",
    "batch_update_markdown",
    "edit_block_kramdown",
    "move_block",
    "set_block_attributes",
    "create_document",
    "rename_document",
    "delete_document",
    "edit_document",
    "delete_block",
    "batch_delete_blocks",
    "sql_query",
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

export type ToolConfirmState = "pending" | "approved" | "rejected";

export interface ToolConfirmInfo {
    status: ToolConfirmState;
    riskSummary: string;
    detail: string;
}

export interface ToolDiffPreviewInfo {
    html: string;
    title: string;
    status: ToolConfirmState;
}

/** 会话内工具风险确认请求 */
export interface ToolConfirmRequest {
    toolCallId: string;
    toolName: string;
    title: string;
    riskSummary: string;
    detail: string;
}

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
    /** UI：会话内风险确认 */
    _toolConfirm?: Record<string, ToolConfirmInfo>;
    /** UI：会话内文档 diff 预览确认 */
    _toolDiff?: Record<string, ToolDiffPreviewInfo>;
    /** UI：LLM 仍在流式输出本条 assistant（含 tool call JSON 生成） */
    _streaming?: boolean;
    /** UI：Markdown 通道仍在流式输出（thinking / text delta，不含 tool call JSON） */
    _mdStreaming?: boolean;
    /** 本轮 LLM 响应的 usage（DeepSeek SSE 末包），用于上下文环统计 */
    _llmUsage?: Record<string, unknown>;
}

export type OpenAICompatibleConfig = DeepSeekConfig;
