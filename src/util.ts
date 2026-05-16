import {confirm} from "siyuan";

/** 供 webpack `mode` 在构建时内联替换（勿改为间接访问，否则无法被常量折叠） */
declare const process: {
    env: {
        NODE_ENV?: string;
    };
};

/** 与 `pnpm dev` / webpack `--mode development` 一致，生产包内为 false */
export const isDev = process.env.NODE_ENV === "development";

const pluginConsoleTag = "[Agent]";

/** 仅在开发环境输出，前缀为 [debug] */
export const logger = {
    debug(...args: unknown[]): void {
        if (isDev) {
            console.log("[debug]", ...args);
        }
    },
    log(...args: unknown[]): void {
        console.log(pluginConsoleTag, ...args);
    },
    warn(...args: unknown[]): void {
        console.warn(pluginConsoleTag, ...args);
    },
    error(...args: unknown[]): void {
        console.error(pluginConsoleTag, ...args);
    },
};

/** 将思源同步 confirm 包装为 Promise，便于 async 工具循环 */
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
