import {postKernelJson} from "../kernelPostJson";
import type {KernelExecutor} from "./types";

/** 使用标准 fetch POST JSON 的进程内 KernelExecutor（不经思源 fetchSyncPost） */
export function createFetchSyncKernelExecutor(): KernelExecutor {
    return {
        async post(url: string, body?: Record<string, unknown>) {
            const res = await postKernelJson(url, body ?? {});
            return {code: res.code, msg: res.msg ?? "", data: res.data};
        },
    };
}
