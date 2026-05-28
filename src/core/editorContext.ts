import {Constants, getActiveEditor} from "siyuan";

import type {KernelExecutor} from "../agent/types";
import {fetchDocumentRootTitle} from "../siyuan/documentTitle";

export interface EditorContextSnapshot {
    rootId?: string;
    rootTitle?: string;
    focusedBlockId?: string;
    selectedText?: string;
    notebookId?: string;
    path?: string;
}

/** 采集当前编辑器上下文，供系统提示与 @ 引用 */
export async function captureEditorContext(kernel: KernelExecutor): Promise<EditorContextSnapshot> {
    const snap: EditorContextSnapshot = {};
    const editor = getActiveEditor(false);
    if (!editor?.protyle) {
        return snap;
    }
    const {block, rootId, notebookId, path} = editor.protyle;
    if (rootId) {
        snap.rootId = rootId;
        snap.rootTitle = await fetchDocumentRootTitle(kernel, rootId);
    }
    if (notebookId) {
        snap.notebookId = notebookId;
    }
    if (path) {
        snap.path = path;
    }
    if (block?.id) {
        snap.focusedBlockId = block.id;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) {
        const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        if (range && editor.protyle.element.contains(range.startContainer)) {
            snap.selectedText = sel.toString().trim().slice(0, 4000);
        }
    }
    return snap;
}

export function formatEditorContextForPrompt(ctx: EditorContextSnapshot): string {
    const parts: string[] = [];
    if (ctx.rootId) {
        parts.push(`当前文档 ID：${ctx.rootId}`);
    }
    if (ctx.rootTitle) {
        parts.push(`当前文档标题：${ctx.rootTitle}`);
    }
    if (ctx.focusedBlockId) {
        parts.push(`光标块 ID：${ctx.focusedBlockId}`);
    }
    if (ctx.selectedText) {
        parts.push(`选区文本：\n${ctx.selectedText}`);
    }
    if (ctx.path) {
        parts.push(`路径：${ctx.path}`);
    }
    return parts.length ? parts.join("\n") : "（无打开的编辑器焦点）";
}

export {Constants};
