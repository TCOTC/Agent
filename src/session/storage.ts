import type {AgentMode} from "../agent/modes";
import {emptyUsage} from "../core/tokenUsage";
import type {ChatMessage} from "../agent/types";
import type {ChatSession, SessionsPersisted} from "./types";

export function createSession(title = "新对话", mode: AgentMode = "agent"): ChatSession {
    const now = new Date().toISOString();
    return {
        id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title,
        createdAt: now,
        updatedAt: now,
        messages: [],
        tokenUsage: emptyUsage(),
        mode,
        pinned: false,
        customInstructions: "",
        contextAttachments: [],
        includeEditorContext: true,
    };
}

export function normalizeSessions(raw: unknown): SessionsPersisted {
    if (!raw || typeof raw !== "object") {
        const s = createSession();
        return {activeId: s.id, sessions: [s]};
    }
    const o = raw as SessionsPersisted;
    if (!Array.isArray(o.sessions) || o.sessions.length === 0) {
        const s = createSession();
        return {activeId: s.id, sessions: [s]};
    }
    const sessions = o.sessions.map((s) => ({
        ...createSession(s.title, s.mode ?? "agent"),
        ...s,
        mode: s.mode ?? "agent",
        pinned: s.pinned ?? false,
        customInstructions: s.customInstructions ?? "",
        contextAttachments: s.contextAttachments ?? [],
        includeEditorContext: s.includeEditorContext ?? true,
        tokenUsage: s.tokenUsage ?? emptyUsage(),
        messages: Array.isArray(s.messages) ? s.messages : [],
    }));
    const activeId = o.activeId && sessions.some((x) => x.id === o.activeId)
        ? o.activeId
        : sessions[0].id;
    return {activeId, sessions};
}

export function deriveSessionTitle(messages: ChatMessage[]): string {
    const first = messages.find((m) => m.role === "user" && m.content);
    if (!first?.content) {
        return "新对话";
    }
    const t = first.content.trim().replace(/\s+/g, " ");
    return t.length > 28 ? `${t.slice(0, 28)}…` : t;
}

export function sortSessions(sessions: ChatSession[]): ChatSession[] {
    return [...sessions].sort((a, b) => {
        if (a.pinned !== b.pinned) {
            return a.pinned ? -1 : 1;
        }
        return b.updatedAt.localeCompare(a.updatedAt);
    });
}

export function filterSessions(sessions: ChatSession[], query: string): ChatSession[] {
    const q = query.trim().toLowerCase();
    if (!q) {
        return sessions;
    }
    return sessions.filter((s) => {
        if (s.title.toLowerCase().includes(q)) {
            return true;
        }
        return s.messages.some((m) => m.content?.toLowerCase().includes(q));
    });
}
