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

export interface AgentStoredSettings {
    baseUrl: string;
    apiKey: string;
    model: string;
    /** 是否注册 SQL 工具（仍每次 confirm） */
    allowSqlTool: boolean;
}

export interface AgentStoredWorkset {
    /** 文档根块 ID 列表（显式工作集） */
    rootIds: string[];
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCallLite {
    id: string;
    name: string;
    arguments: string;
}

export interface ChatMessage {
    role: ChatRole;
    content: string | null;
    name?: string;
    /**
     * DeepSeek 思考模式：带 tool_calls 时必须在后续轮次原样回传，否则会报 invalid_request_error。
     * 见 https://api-docs.deepseek.com/guides/thinking_mode
     */
    reasoning_content?: string | null;
    tool_calls?: Array<{
        id: string;
        type: "function";
        function: {name: string; arguments: string;};
    }>;
    tool_call_id?: string;
}
