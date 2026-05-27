import type {ChatMessage} from "../agent/types";
import {emptyUsage} from "../core/tokenUsage";
import type {ChatSession, SessionsPersisted} from "./types";

export function createSession(title = "新对话"): ChatSession {
    const now = new Date().toISOString();
    return {
        id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title,
        createdAt: now,
        updatedAt: now,
        messages: [],
        tokenUsage: emptyUsage(),
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
    const activeId = o.activeId && o.sessions.some((x) => x.id === o.activeId)
        ? o.activeId
        : o.sessions[0].id;
    return {activeId, sessions: o.sessions};
}

export function deriveSessionTitle(messages: ChatMessage[]): string {
    const first = messages.find((m) => m.role === "user" && m.content);
    if (!first?.content) {
        return "新对话";
    }
    const t = first.content.trim().replace(/\s+/g, " ");
    return t.length > 24 ? `${t.slice(0, 24)}…` : t;
}
