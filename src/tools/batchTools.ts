import type {KernelExecutor} from "../agent/types";
import {checkWorkset, resolveNotebookId, worksetError} from "./worksetGate";

export const BATCH_MAX_ITEMS = 48;

export interface BatchUpdateItem {
    id: string;
    markdown: string;
}

export interface BatchInsertItem {
    markdown: string;
    parent_id?: string;
    previous_id?: string;
    next_id?: string;
}

export interface BatchAppendItem {
    parent_id: string;
    markdown: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseItemArray(raw: unknown, field: string): Record<string, unknown>[] | {error: string} {
    if (!Array.isArray(raw)) {
        return {error: `missing or invalid ${field} array`};
    }
    if (raw.length === 0) {
        return {error: `${field} must not be empty`};
    }
    if (raw.length > BATCH_MAX_ITEMS) {
        return {error: `${field} exceeds max ${BATCH_MAX_ITEMS} items`};
    }
    const out: Record<string, unknown>[] = [];
    for (const item of raw) {
        const o = asRecord(item);
        if (!o) {
            return {error: `${field} items must be objects`};
        }
        out.push(o);
    }
    return out;
}

export function parseBatchUpdates(args: Record<string, unknown>): BatchUpdateItem[] | {error: string} {
    const parsed = parseItemArray(args.updates, "updates");
    if ("error" in parsed) {
        return parsed;
    }
    const updates: BatchUpdateItem[] = [];
    for (const o of parsed) {
        const id = String(o.id ?? "").trim();
        const markdown = String(o.markdown ?? "");
        if (!id) {
            return {error: "each update needs id"};
        }
        updates.push({id, markdown});
    }
    return updates;
}

export function parseBatchInserts(args: Record<string, unknown>): BatchInsertItem[] | {error: string} {
    const parsed = parseItemArray(args.inserts, "inserts");
    if ("error" in parsed) {
        return parsed;
    }
    const inserts: BatchInsertItem[] = [];
    for (const o of parsed) {
        const markdown = String(o.markdown ?? "");
        if (!markdown) {
            return {error: "each insert needs markdown"};
        }
        const parent_id = o.parent_id != null ? String(o.parent_id).trim() : undefined;
        const previous_id = o.previous_id != null ? String(o.previous_id).trim() : undefined;
        const next_id = o.next_id != null ? String(o.next_id).trim() : undefined;
        const anchors = [parent_id, previous_id, next_id].filter(Boolean).length;
        if (anchors !== 1) {
            return {error: "each insert needs exactly one of parent_id / previous_id / next_id"};
        }
        inserts.push({markdown, parent_id, previous_id, next_id});
    }
    return inserts;
}

export function parseBatchAppends(args: Record<string, unknown>): BatchAppendItem[] | {error: string} {
    const parsed = parseItemArray(args.appends, "appends");
    if ("error" in parsed) {
        return parsed;
    }
    const appends: BatchAppendItem[] = [];
    for (const o of parsed) {
        const parent_id = String(o.parent_id ?? "").trim();
        const markdown = String(o.markdown ?? "");
        if (!parent_id) {
            return {error: "each append needs parent_id"};
        }
        if (!markdown) {
            return {error: "each append needs markdown"};
        }
        appends.push({parent_id, markdown});
    }
    return appends;
}

export function parseBatchDeleteIds(args: Record<string, unknown>): string[] | {error: string} {
    const raw = args.ids;
    if (!Array.isArray(raw)) {
        return {error: "missing or invalid ids array"};
    }
    if (raw.length === 0) {
        return {error: "ids must not be empty"};
    }
    if (raw.length > BATCH_MAX_ITEMS) {
        return {error: `ids exceeds max ${BATCH_MAX_ITEMS}`};
    }
    const ids: string[] = [];
    for (const id of raw) {
        const s = String(id ?? "").trim();
        if (!s) {
            return {error: "ids must be non-empty strings"};
        }
        ids.push(s);
    }
    return ids;
}

/** 文档根块（id === rootID）批量 update 会重建子树，禁止 */
export async function isDocumentRootBlock(kernel: KernelExecutor, id: string): Promise<boolean> {
    const r = await kernel.post("/api/block/getBlockInfo", {id});
    if (r.code !== 0) {
        return false;
    }
    const d = r.data as {id?: string; rootID?: string};
    return !!d.id && d.id === d.rootID;
}

export async function gateWorksetMany(
    kernel: KernelExecutor,
    blockIds: string[],
    worksetNotebookIds: string[],
): Promise<string | null> {
    for (const id of blockIds) {
        const info = await resolveNotebookId(kernel, id);
        if (info.ok === false) {
            return info.error;
        }
        if (!checkWorkset(info.box, worksetNotebookIds)) {
            return worksetError(info.box);
        }
    }
    return null;
}

export function summarizeBatchIds(ids: string[], maxShow = 6): string {
    if (ids.length <= maxShow) {
        return ids.join(", ");
    }
    return `${ids.slice(0, maxShow).join(", ")} … 共 ${ids.length} 个`;
}

export function totalMarkdownChars(items: {markdown?: string}[]): number {
    return items.reduce((n, i) => n + (i.markdown?.length ?? 0), 0);
}
