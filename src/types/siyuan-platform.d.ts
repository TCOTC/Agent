/**
 * 思源宿主 API 可能领先于 npm `siyuan` 类型包，在此补充。
 */
interface Window {
    /** Agent 插件挂载，便于控制台调试思源 `getActiveEditor` */
    getActiveEditor?: (wndActive?: boolean) => unknown;
}

declare module "siyuan" {
    /** 桌面端：当前布局中所有页签 */
    export function getAllTabs(): unknown[];

    export function getFrontend():
        | "desktop"
        | "desktop-window"
        | "mobile"
        | "browser-desktop"
        | "browser-mobile";

    export const platformUtils: {
        sendNotification(options: {
            channel?: string;
            title?: string;
            body?: string;
            delayInSeconds?: number;
            timeoutType?: "default" | "never";
        }): Promise<number>;
        cancelNotification(id: number): void;
    };
}
