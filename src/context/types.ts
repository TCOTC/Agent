export type ContextAttachmentKind = "document" | "block" | "notebook" | "selection";

export interface ContextAttachment {
    id: string;
    kind: ContextAttachmentKind;
    label: string;
    preview?: string;
    addedAt: string;
}

export interface ContextState {
    attachments: ContextAttachment[];
    includeEditorContext: boolean;
}

export function createEmptyContext(): ContextState {
    return {attachments: [], includeEditorContext: true};
}

export function addAttachment(
    state: ContextState,
    item: Omit<ContextAttachment, "addedAt">,
): ContextState {
    if (state.attachments.some((a) => a.id === item.id && a.kind === item.kind)) {
        return state;
    }
    return {
        ...state,
        attachments: [...state.attachments, {...item, addedAt: new Date().toISOString()}],
    };
}

export function removeAttachment(state: ContextState, id: string): ContextState {
    return {...state, attachments: state.attachments.filter((a) => a.id !== id)};
}

export function formatAttachmentsForPrompt(state: ContextState): ContextAttachment[] {
    return state.attachments;
}
