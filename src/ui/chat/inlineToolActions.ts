import type {ChatMessage, ToolConfirmRequest} from "../../agent/types";

export interface ToolDiffPreviewRequest {
    toolCallId: string;
    html: string;
    title: string;
}

type ConfirmResolver = (approved: boolean) => void;

const PENDING_SEP = "\x00";

const pendingConfirmResolvers = new Map<string, ConfirmResolver>();
const pendingDiffResolvers = new Map<string, ConfirmResolver>();

export type InlineToolActionHandlers = {
    onConfirm: (sessionId: string, toolCallId: string, approved: boolean) => void;
    onDiff: (sessionId: string, toolCallId: string, approved: boolean) => void;
};

let handlers: InlineToolActionHandlers | null = null;

export function pendingActionKey(sessionId: string, toolCallId: string): string {
    return `${sessionId}${PENDING_SEP}${toolCallId}`;
}

function parsePendingActionKey(key: string): {sessionId: string; toolCallId: string} {
    const sep = key.indexOf(PENDING_SEP);
    if (sep < 0) {
        return {sessionId: "", toolCallId: key};
    }
    return {sessionId: key.slice(0, sep), toolCallId: key.slice(sep + 1)};
}

/** 从消息列表容器读取当前渲染的会话 id */
export function readSessionIdFromMessagesEl(el: Element | null | undefined): string | undefined {
    const host = el?.closest("[data-messages]") as HTMLElement | null;
    const id = host?.dataset.sessionId?.trim();
    return id || undefined;
}

export function bindInlineToolActionHandlers(h: InlineToolActionHandlers | null): void {
    handlers = h;
}

export function findLatestAssistantMessage(messages: ChatMessage[]): ChatMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "assistant") {
            return messages[i];
        }
    }
    return undefined;
}

function settlePending(map: Map<string, ConfirmResolver>, key: string, approved: boolean): void {
    const resolve = map.get(key);
    if (resolve) {
        map.delete(key);
        resolve(approved);
    }
}

/** 停止 / 重新生成时解除等待中的确认与 diff，避免 Agent 一直卡住 */
export function cancelPendingInlineActions(sessionId?: string): void {
    const prefix = sessionId ? `${sessionId}${PENDING_SEP}` : undefined;
    for (const key of [...pendingConfirmResolvers.keys()]) {
        if (!prefix || key.startsWith(prefix)) {
            const {sessionId: sid, toolCallId} = parsePendingActionKey(key);
            resolveInlineToolConfirm(sid, toolCallId, false);
        }
    }
    for (const key of [...pendingDiffResolvers.keys()]) {
        if (!prefix || key.startsWith(prefix)) {
            const {sessionId: sid, toolCallId} = parsePendingActionKey(key);
            resolveInlineToolDiff(sid, toolCallId, false);
        }
    }
}

/** 注册等待中的 Promise（状态由 sdk / 调用方写入消息） */
export function createInlineToolConfirm(
    sessionId: string,
    onRefresh: () => void,
    getAbortSignal?: () => AbortSignal | undefined,
    /** 不依赖 DOM：确认一进入 pending 就提醒（含系统通知） */
    onRequired?: (req: ToolConfirmRequest) => void,
): (req: ToolConfirmRequest) => Promise<boolean> {
    return (req) =>
        new Promise((resolve) => {
            const signal = getAbortSignal?.();
            if (signal?.aborted) {
                resolve(false);
                return;
            }
            const key = pendingActionKey(sessionId, req.toolCallId);
            const onAbort = () => {
                if (pendingConfirmResolvers.has(key)) {
                    resolveInlineToolConfirm(sessionId, req.toolCallId, false);
                }
            };
            signal?.addEventListener("abort", onAbort, {once: true});
            pendingConfirmResolvers.set(key, (approved) => {
                signal?.removeEventListener("abort", onAbort);
                resolve(approved);
            });
            onRequired?.(req);
            onRefresh();
        });
}

export function createInlineDiffPreview(
    sessionId: string,
    onRefresh: () => void,
    attachDiff: (toolCallId: string, html: string, title: string) => void,
    getAbortSignal?: () => AbortSignal | undefined,
): (html: string, title: string, toolCallId: string) => Promise<boolean> {
    return (html, title, toolCallId) => {
        attachDiff(toolCallId, html, title);
        return new Promise((resolve) => {
            const signal = getAbortSignal?.();
            if (signal?.aborted) {
                resolve(false);
                return;
            }
            const key = pendingActionKey(sessionId, toolCallId);
            const onAbort = () => {
                if (pendingDiffResolvers.has(key)) {
                    resolveInlineToolDiff(sessionId, toolCallId, false);
                }
            };
            signal?.addEventListener("abort", onAbort, {once: true});
            pendingDiffResolvers.set(key, (approved) => {
                signal?.removeEventListener("abort", onAbort);
                resolve(approved);
            });
            onRefresh();
        });
    };
}

export function resolveInlineToolConfirm(sessionId: string, toolCallId: string, approved: boolean): void {
    handlers?.onConfirm(sessionId, toolCallId, approved);
    settlePending(pendingConfirmResolvers, pendingActionKey(sessionId, toolCallId), approved);
}

export function resolveInlineToolDiff(sessionId: string, toolCallId: string, approved: boolean): void {
    handlers?.onDiff(sessionId, toolCallId, approved);
    settlePending(pendingDiffResolvers, pendingActionKey(sessionId, toolCallId), approved);
}

export function hasPendingInlineActions(sessionId?: string): boolean {
    if (!sessionId) {
        return pendingConfirmResolvers.size > 0 || pendingDiffResolvers.size > 0;
    }
    const prefix = `${sessionId}${PENDING_SEP}`;
    for (const key of pendingConfirmResolvers.keys()) {
        if (key.startsWith(prefix)) {
            return true;
        }
    }
    for (const key of pendingDiffResolvers.keys()) {
        if (key.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}
