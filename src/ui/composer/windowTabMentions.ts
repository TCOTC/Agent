import {getActiveEditor, getAllTabs} from "siyuan";

import type {KernelExecutor} from "../../agent/types";
import {fetchDocumentRootTitles} from "../../siyuan/documentTitle";
import type {BlockMentionHit} from "./blockMentionSearch";

type TabLike = {
    model?: {
        editor?: {
            protyle?: {
                block?: {rootID?: string};
                rootId?: string;
            };
        };
    };
};

function getTabRootId(tab: TabLike): string | null {
    const block = tab.model?.editor?.protyle?.block;
    const rootId = block?.rootID ?? tab.model?.editor?.protyle?.rootId;
    return rootId ? String(rootId) : null;
}

/** 当前窗口已打开的文档页签（`getActiveEditor(false)` 对应文档排第一，标题走内核 getBlockInfo） */
export async function listWindowTabMentions(
    kernel: KernelExecutor,
    limit = 20,
): Promise<BlockMentionHit[]> {
    const orderedIds: string[] = [];
    const seen = new Set<string>();

    const pushId = (id: string) => {
        if (!id || seen.has(id)) {
            return;
        }
        seen.add(id);
        orderedIds.push(id);
    };

    const editor = getActiveEditor(false);
    const activeRootId = editor?.protyle?.block?.rootID ?? editor?.protyle?.rootId;
    if (activeRootId) {
        pushId(String(activeRootId));
    }

    try {
        const tabs = getAllTabs() as TabLike[];
        for (const tab of tabs) {
            if (orderedIds.length >= limit) {
                break;
            }
            const id = getTabRootId(tab);
            if (id) {
                pushId(id);
            }
        }
    } catch {
        // 移动端等环境可能无 getAllTabs
    }

    const ids = orderedIds.slice(0, limit);
    if (!ids.length) {
        return [];
    }

    const titles = await fetchDocumentRootTitles(kernel, ids);
    return ids.map((id) => ({
        id,
        label: titles.get(id) ?? id,
        blockType: "NodeDocument",
        blockSubtype: null,
        source: "tab" as const,
    }));
}
