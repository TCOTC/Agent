import type {ChatMessage} from "../agent/types";
import type {AgentMode} from "../agent/modes";
import type {ContextAttachment} from "../context/types";
import type {TokenUsageRecord} from "../core/tokenUsage";

export interface ChatSession {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messages: ChatMessage[];
    tokenUsage: TokenUsageRecord;
    mode: AgentMode;
    pinned: boolean;
    customInstructions: string;
    contextAttachments: ContextAttachment[];
    includeEditorContext: boolean;
}

export interface SessionsPersisted {
    activeId: string;
    sessions: ChatSession[];
}
