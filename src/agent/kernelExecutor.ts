import {fetchSyncPost} from "siyuan";
import type {KernelExecutor} from "./types";

/** 使用思源 fetchSyncPost 的进程内 ToolExecutor 实现（方案 A） */
export function createFetchSyncKernelExecutor(): KernelExecutor {
    return {
        async post(url: string, body?: Record<string, unknown>) {
            const res = await fetchSyncPost(url, body ?? {});
            return {code: res.code, msg: res.msg ?? "", data: res.data};
        },
    };
}
