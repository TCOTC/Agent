import type {KernelExecutor} from "../agent/types";

export async function resolveNotebookId(
    kernel: KernelExecutor,
    blockId: string,
): Promise<{ok: true; box: string; rootId: string} | {ok: false; error: string}> {
    const r = await kernel.post("/api/block/getBlockInfo", {id: blockId});
    if (r.code !== 0) {
        return {ok: false, error: r.msg || "getBlockInfo failed"};
    }
    const d = r.data as {box?: string; rootID?: string};
    if (!d.box || !d.rootID) {
        return {ok: false, error: "missing box/rootID"};
    }
    return {ok: true, box: d.box, rootId: d.rootID};
}

export function checkWorkset(box: string, allowed: string[]): boolean {
    if (!allowed.length) {
        return true;
    }
    return allowed.includes(box);
}

export function worksetError(box: string): string {
    return `笔记本 ${box} 不在当前工作集授权范围内`;
}
