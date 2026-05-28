import {openTab} from "siyuan";
import type {App} from "siyuan";

import type {KernelExecutor} from "../agent/types";
import {Constants} from "../core/editorContext";

export async function getBlockFoldInfo(
    kernel: KernelExecutor,
    id: string,
): Promise<{isFolded: boolean; isRoot: boolean}> {
    const r = await kernel.post("/api/block/checkBlockFold", {id});
    if (r.code !== 0) {
        return {isFolded: false, isRoot: false};
    }
    const d = r.data as {isFolded?: boolean; isRoot?: boolean};
    return {isFolded: !!d.isFolded, isRoot: !!d.isRoot};
}

/** 与思源 checkFold / openFileById 一致：CB_GET_ALL 仅用于折叠子块的缩放聚焦。 */
export function buildOpenDocumentAction(
    highlight: boolean,
    fold: {isFolded: boolean; isRoot: boolean},
): string[] {
    if (highlight) {
        return fold.isFolded
            ? [Constants.CB_GET_HL, Constants.CB_GET_ALL]
            : [Constants.CB_GET_HL, Constants.CB_GET_CONTEXT, Constants.CB_GET_ROOTSCROLL];
    }
    if (fold.isRoot) {
        return [];
    }
    return fold.isFolded ? [Constants.CB_GET_ALL] : [];
}

export function buildFocusBlockAction(fold: {isFolded: boolean; isRoot: boolean}): string[] {
    if (fold.isFolded) {
        return [Constants.CB_GET_HL, Constants.CB_GET_FOCUS, Constants.CB_GET_ALL];
    }
    return [
        Constants.CB_GET_HL,
        Constants.CB_GET_CONTEXT,
        Constants.CB_GET_ROOTSCROLL,
        Constants.CB_GET_FOCUS,
    ];
}

function buildBlockRefOpenAction(
    fold: {isFolded: boolean; isRoot: boolean},
): {action: string[]; zoomIn: boolean} {
    const action: string[] = [];
    let zoomIn = false;
    if (!fold.isRoot) {
        action.push(Constants.CB_GET_HL);
    }
    if (fold.isFolded) {
        zoomIn = true;
        if (!action.includes(Constants.CB_GET_ALL)) {
            action.push(Constants.CB_GET_ALL);
        }
    }
    return {action, zoomIn};
}

/** 点击块引用：行为对齐 Protyle 内 `span[data-type="block-ref"]` 默认跳转 */
export async function navigateToBlockRef(opts: {
    app: App;
    kernel: KernelExecutor;
    blockId: string;
    shiftKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
}): Promise<void> {
    const fold = await getBlockFoldInfo(opts.kernel, opts.blockId);
    const mod = opts.ctrlKey || opts.metaKey;

    if (opts.shiftKey) {
        const {action, zoomIn} = buildBlockRefOpenAction(fold);
        openTab({
            app: opts.app,
            position: "bottom",
            doc: {id: opts.blockId, action, zoomIn},
        });
        return;
    }
    if (opts.altKey) {
        const {action, zoomIn} = buildBlockRefOpenAction(fold);
        openTab({
            app: opts.app,
            position: "right",
            doc: {id: opts.blockId, action, zoomIn},
        });
        return;
    }
    if (mod) {
        const action = fold.isFolded
            ? [Constants.CB_GET_HL, Constants.CB_GET_ALL]
            : [Constants.CB_GET_HL, Constants.CB_GET_CONTEXT, Constants.CB_GET_ROOTSCROLL];
        openTab({
            app: opts.app,
            keepCursor: true,
            doc: {id: opts.blockId, action, zoomIn: fold.isFolded},
        });
        return;
    }

    const {action, zoomIn} = buildBlockRefOpenAction(fold);
    openTab({
        app: opts.app,
        doc: {id: opts.blockId, action, zoomIn},
    });
}
