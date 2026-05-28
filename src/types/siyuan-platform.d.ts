/**
 * 思源宿主 API 可能领先于 npm `siyuan` 类型包，在此补充。
 */
declare module "siyuan" {
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
