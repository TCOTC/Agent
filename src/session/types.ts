import type {ChatMessage} from "../agent/types";
import type {TokenUsageRecord} from "../core/tokenUsage";

export interface ChatSession {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messages: ChatMessage[];
    tokenUsage: TokenUsageRecord;
}

export interface SessionsPersisted {
    activeId: string;
    sessions: ChatSession[];
}
