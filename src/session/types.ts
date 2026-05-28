import type {ChatMessage} from "../agent/types";
import type {AgentMode} from "../agent/modes";
import type {TokenUsageRecord} from "../core/tokenUsage";

/** Composer 未发送草稿（TipTap 文档 JSON，含块引用芯片） */
export type ComposerDraft = Record<string, unknown>;

export interface ChatSession {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messages: ChatMessage[];
    tokenUsage: TokenUsageRecord;
    /** 最近一次 API 请求的 prompt_tokens，对应当前上下文体积 */
    lastContextTokens?: number;
    mode: AgentMode;
    pinned: boolean;
    customInstructions: string;
    /** 当前会话 Composer 输入草稿，随 sessions.json 持久化 */
    composerDraft?: ComposerDraft;
}

export interface SessionsPersisted {
    activeId: string;
    sessions: ChatSession[];
}
