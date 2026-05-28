import type {KernelExecutor} from "../agent/types";

export interface BlockInfoData {
    rootID?: string;
    rootTitle?: string;
    path?: string;
    box?: string;
}

/** 通过内核 `/api/block/getBlockInfo` 获取文档根块标题 */
export async function fetchDocumentRootTitle(
    kernel: KernelExecutor,
    blockId: string,
): Promise<string> {
    const id = blockId.trim();
    if (!id) {
        return "";
    }
    const r = await kernel.post("/api/block/getBlockInfo", {id});
    if (r.code !== 0) {
        return id;
    }
    const data = r.data as BlockInfoData | undefined;
    const title = data?.rootTitle?.trim();
    return title || id;
}

/** 批量解析文档根 ID → 标题（顺序与传入一致，失败时回退为 ID） */
export async function fetchDocumentRootTitles(
    kernel: KernelExecutor,
    rootIds: string[],
): Promise<Map<string, string>> {
    const unique = [...new Set(rootIds.filter(Boolean))];
    const entries = await Promise.all(
        unique.map(async (id) => [id, await fetchDocumentRootTitle(kernel, id)] as const),
    );
    return new Map(entries);
}
