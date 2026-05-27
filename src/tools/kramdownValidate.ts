import type {KernelExecutor} from "../agent/types";

/**
 * 通过尝试 updateBlock（dry-run 不可行）改为用 getBlockKramdown + 结构检查。
 * 写入前：检查 kramdown 非空、包含目标块 ID 的 IAL（若提供 expectedId）。
 */
export function validateKramdownPayload(
    kramdown: string,
    expectedBlockId?: string,
): {ok: true} | {ok: false; error: string} {
    const trimmed = kramdown.trim();
    if (!trimmed) {
        return {ok: false, error: "kramdown 内容为空"};
    }
    if (expectedBlockId && !trimmed.includes(`id="${expectedBlockId}"`)) {
        return {
            ok: false,
            error: `kramdown 中未找到块 ID ${expectedBlockId} 的 IAL，请勿删除或改写块标识`,
        };
    }
    return {ok: true};
}

/** 写入后核对块仍存在 */
export async function verifyBlockExists(
    kernel: KernelExecutor,
    id: string,
): Promise<boolean> {
    const r = await kernel.post("/api/block/checkBlockExist", {id});
    return r.code === 0 && r.data === true;
}
