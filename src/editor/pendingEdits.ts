import {computeLineDiff, diffSummary, type DiffLine} from "./diffEngine";

export interface PendingDocumentEdit {
    id: string;
    docId: string;
    docTitle?: string;
    oldMarkdown: string;
    newMarkdown: string;
    diff: DiffLine[];
    summary: {adds: number; removes: number; sames: number};
    createdAt: string;
}

const pending = new Map<string, PendingDocumentEdit>();

export function createPendingEdit(
    docId: string,
    oldMarkdown: string,
    newMarkdown: string,
    docTitle?: string,
): PendingDocumentEdit {
    const diff = computeLineDiff(oldMarkdown, newMarkdown);
    const edit: PendingDocumentEdit = {
        id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        docId,
        docTitle,
        oldMarkdown,
        newMarkdown,
        diff,
        summary: diffSummary(diff),
        createdAt: new Date().toISOString(),
    };
    pending.set(edit.id, edit);
    return edit;
}

export function getPendingEdit(id: string): PendingDocumentEdit | undefined {
    return pending.get(id);
}

export function consumePendingEdit(id: string): PendingDocumentEdit | undefined {
    const e = pending.get(id);
    if (e) {
        pending.delete(id);
    }
    return e;
}

export function listPendingEdits(): PendingDocumentEdit[] {
    return [...pending.values()];
}
