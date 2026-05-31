import type {AgentMode} from "../agent/modes";
import type {ChatMessage} from "../agent/types";
import {composerDocToPlainText, legacyUserContentToComposerDoc} from "../ui/composer/blockMentionText";
import {emptyUsage} from "../core/tokenUsage";
import type {ChatSession, SessionsPersisted} from "./types";
import type {JSONContent} from "@tiptap/core";

export function createSession(
    title = "新对话",
    mode: AgentMode = "agent",
    model?: string,
): ChatSession {
    const now = new Date().toISOString();
    const trimmedModel = model?.trim();
    return {
        id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title,
        createdAt: now,
        updatedAt: now,
        messages: [],
        tokenUsage: emptyUsage(),
        mode,
        model: trimmedModel || undefined,
        pinned: false,
        customInstructions: "",
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
        model: typeof s.model === "string" && s.model.trim() ? s.model.trim() : undefined,
        pinned: s.pinned ?? false,
        customInstructions: s.customInstructions ?? "",
        tokenUsage: s.tokenUsage ?? emptyUsage(),
        lastContextTokens: typeof s.lastContextTokens === "number" ? s.lastContextTokens : undefined,
        messages: Array.isArray(s.messages) ? s.messages : [],
        composerDraft:
            s.composerDraft && typeof s.composerDraft === "object" && s.composerDraft.type === "doc"
                ? s.composerDraft
                : undefined,
    }));
    const activeId = o.activeId && sessions.some((x) => x.id === o.activeId)
        ? o.activeId
        : sessions[0].id;
    return {activeId, sessions};
}

function userMessagePlainText(m: ChatMessage): string {
    const doc = m.composerDoc as JSONContent | undefined;
    if (doc?.type === "doc") {
        const t = composerDocToPlainText(doc);
        if (t) {
            return t;
        }
    }
    if (m.content) {
        const legacyDoc = legacyUserContentToComposerDoc(m.content);
        return composerDocToPlainText(legacyDoc) || m.content;
    }
    return "";
}

export function deriveSessionTitle(messages: ChatMessage[]): string {
    const first = messages.find((m) => m.role === "user" && (m.content || m.composerDoc));
    if (!first) {
        return "新对话";
    }
    const t = userMessagePlainText(first).trim().replace(/\s+/g, " ");
    if (!t) {
        return "新对话";
    }
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
