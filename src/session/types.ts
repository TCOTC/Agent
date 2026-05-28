import type {ChatMessage} from "../agent/types";
import type {AgentMode} from "../agent/modes";
import type {TokenUsageRecord} from "../core/tokenUsage";

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
}

export interface SessionsPersisted {
    activeId: string;
    sessions: ChatSession[];
}
