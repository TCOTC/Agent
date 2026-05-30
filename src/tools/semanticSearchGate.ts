import type {KernelExecutor} from "../agent/types";

/** 与 catalog 中 semantic_search_blocks 一致 */
export const SEMANTIC_SEARCH_BLOCKS_TOOL = "semantic_search_blocks";

/** blocks 表行数超过该值时默认不向模型暴露语义搜索工具 */
export const BLOCKS_ROW_DISABLE_THRESHOLD = 10_000;

const BLOCKS_COUNT_SQL = "SELECT COUNT(*) AS c FROM blocks";

let cached: {count: number; enabled: boolean; checkedAt: number} | null = null;
const CACHE_TTL_MS = 60_000;

function parseBlocksCount(data: unknown): number | null {
    if (!Array.isArray(data) || data.length === 0) {
        return null;
    }
    const row = data[0] as Record<string, unknown>;
    const raw = row.c ?? row.C ?? Object.values(row)[0];
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? n : null;
}

/** blocks 表总行数；查询失败时返回 null */
export async function queryBlocksTableRowCount(kernel: KernelExecutor): Promise<number | null> {
    const r = await kernel.post("/api/query/sql", {stmt: BLOCKS_COUNT_SQL, mode: "readonly"});
    if (r.code !== 0) {
        return null;
    }
    return parseBlocksCount(r.data);
}

export function isSemanticSearchToolEnabledForBlockCount(count: number): boolean {
    return count <= BLOCKS_ROW_DISABLE_THRESHOLD;
}

/**
 * 是否应向模型暴露 semantic_search_blocks。
 * 块数超过阈值或无法统计时默认禁用（接口在大库上很慢）。
 */
export async function resolveSemanticSearchToolEnabled(kernel: KernelExecutor): Promise<boolean> {
    const now = Date.now();
    if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
        return cached.enabled;
    }
    const count = await queryBlocksTableRowCount(kernel);
    if (count === null) {
        cached = {count: -1, enabled: false, checkedAt: now};
        return false;
    }
    const enabled = isSemanticSearchToolEnabledForBlockCount(count);
    cached = {count, enabled, checkedAt: now};
    return enabled;
}

/** 测试或库规模变化后清除缓存 */
export function clearSemanticSearchGateCache(): void {
    cached = null;
}
