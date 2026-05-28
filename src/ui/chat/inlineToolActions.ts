import type {ChatMessage, ToolConfirmRequest} from "../../agent/types";

export interface ToolDiffPreviewRequest {
    toolCallId: string;
    html: string;
    title: string;
}

type ConfirmResolver = (approved: boolean) => void;

const pendingConfirmResolvers = new Map<string, ConfirmResolver>();
const pendingDiffResolvers = new Map<string, ConfirmResolver>();

export type InlineToolActionHandlers = {
    onConfirm: (toolCallId: string, approved: boolean) => void;
    onDiff: (toolCallId: string, approved: boolean) => void;
};

let handlers: InlineToolActionHandlers | null = null;

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

function settlePending(map: Map<string, ConfirmResolver>, toolCallId: string, approved: boolean): void {
    const resolve = map.get(toolCallId);
    if (resolve) {
        map.delete(toolCallId);
        resolve(approved);
    }
}

/** 停止 / 重新生成时解除等待中的确认与 diff，避免 Agent 一直卡住 */
export function cancelPendingInlineActions(): void {
    for (const toolCallId of [...pendingConfirmResolvers.keys()]) {
        resolveInlineToolConfirm(toolCallId, false);
    }
    for (const toolCallId of [...pendingDiffResolvers.keys()]) {
        resolveInlineToolDiff(toolCallId, false);
    }
}

/** 注册等待中的 Promise（状态由 sdk / 调用方写入消息） */
export function createInlineToolConfirm(
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
            const onAbort = () => {
                if (pendingConfirmResolvers.has(req.toolCallId)) {
                    resolveInlineToolConfirm(req.toolCallId, false);
                }
            };
            signal?.addEventListener("abort", onAbort, {once: true});
            pendingConfirmResolvers.set(req.toolCallId, (approved) => {
                signal?.removeEventListener("abort", onAbort);
                resolve(approved);
            });
            onRequired?.(req);
            onRefresh();
        });
}

export function createInlineDiffPreview(
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
            const onAbort = () => {
                if (pendingDiffResolvers.has(toolCallId)) {
                    resolveInlineToolDiff(toolCallId, false);
                }
            };
            signal?.addEventListener("abort", onAbort, {once: true});
            pendingDiffResolvers.set(toolCallId, (approved) => {
                signal?.removeEventListener("abort", onAbort);
                resolve(approved);
            });
            onRefresh();
        });
    };
}

export function resolveInlineToolConfirm(toolCallId: string, approved: boolean): void {
    handlers?.onConfirm(toolCallId, approved);
    settlePending(pendingConfirmResolvers, toolCallId, approved);
}

export function resolveInlineToolDiff(toolCallId: string, approved: boolean): void {
    handlers?.onDiff(toolCallId, approved);
    settlePending(pendingDiffResolvers, toolCallId, approved);
}

export function hasPendingInlineActions(): boolean {
    return pendingConfirmResolvers.size > 0 || pendingDiffResolvers.size > 0;
}
