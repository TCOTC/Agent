import {confirm} from "siyuan";

/** 将思源同步 confirm 包装为 Promise，便于 async Agent 循环 */
export function confirmPromise(title: string, text: string): Promise<boolean> {
    return new Promise((resolve) => {
        confirm(
            title,
            text,
            () => resolve(true),
            () => resolve(false),
        );
    });
}
