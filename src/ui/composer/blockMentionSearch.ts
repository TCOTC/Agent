import {getActiveEditor} from "siyuan";

import type {KernelExecutor} from "../../agent/types";
import {normalizeNodeBlockType} from "../../siyuan/blockIcon";
import {listWindowTabMentions} from "./windowTabMentions";

export interface BlockMentionHit {
    id: string;
    label: string;
    blockType: string;
    blockSubtype: string | null;
    sub?: string;
    /** 搜索 API 返回的 HTML 片段（含 &lt;mark&gt;），仅用于菜单展示 */
    labelHtml?: string;
    /** 空查询时的窗口页签项 */
    source?: "tab" | "search";
}

function mapRefBlocksToHits(blocks: Record<string, unknown>[]): BlockMentionHit[] {
    return blocks.map((b) => {
        const id = String(b.id ?? "");
        const rawContent = typeof b.content === "string" ? b.content : "";
        const refText = typeof b.refText === "string" ? b.refText.replace(/\u200b/g, "") : "";
        const name = typeof b.name === "string" ? b.name : "";
        const raw = rawContent || refText || name || id;
        const plain = raw.replace(/<[^>]+>/g, "").trim() || id;
        const {blockType, blockSubtype} = normalizeNodeBlockType(b.type, b.subtype);
        return {
            id,
            label: plain.slice(0, 80),
            blockType,
            blockSubtype,
            labelHtml: rawContent.includes("<") ? rawContent : undefined,
            sub: typeof b.hPath === "string" ? b.hPath : undefined,
            source: "search",
        };
    });
}

async function searchRefBlockMentions(
    kernel: KernelExecutor,
    query: string,
    limit: number,
): Promise<BlockMentionHit[]> {
    const editor = getActiveEditor(false);
    const protyle = editor?.protyle;
    const block = protyle?.block;
    const contextId = block?.id ?? block?.parentID ?? protyle?.rootId ?? "";
    const rootID = block?.rootID ?? protyle?.rootId ?? contextId;

    const r = await kernel.post("/api/search/searchRefBlock", {
        k: query,
        id: contextId,
        rootID,
        beforeLen: 48,
        isDatabase: false,
        isSquareBrackets: false,
    });
    if (r.code !== 0) {
        return [];
    }
    const data = r.data as {blocks?: Record<string, unknown>[]};
    const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
    return mapRefBlocksToHits(blocks.slice(0, limit));
}

/**
 * `@` 提及数据源：
 * - 空查询：当前窗口文档页签（聚焦排第一）
 * - 有查询：`/api/search/searchRefBlock`（与思源块引用菜单一致）
 */
export async function searchBlockMentions(
    kernel: KernelExecutor,
    query: string,
    limit = 12,
): Promise<BlockMentionHit[]> {
    const q = query.trim();
    if (!q) {
        return listWindowTabMentions(kernel, limit);
    }
    return searchRefBlockMentions(kernel, q, limit);
}
