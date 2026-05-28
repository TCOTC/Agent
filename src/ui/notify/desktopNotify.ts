import {getFrontend, platformUtils} from "siyuan";
import type {ToolConfirmRequest} from "../../agent/types";

declare const __non_webpack_require__: NodeRequire | undefined;

const SIYUAN_CMD = "siyuan-cmd";

type SendNotificationFn = (options: {
    title?: string;
    body?: string;
    delayInSeconds?: number;
    timeoutType?: "default" | "never";
}) => Promise<number>;

type ElectronBrowserWindow = {
    isVisible(): boolean;
    isMinimized(): boolean;
};

let pendingHiddenConfirmNotify: {title: string; body: string} | null = null;
let lastConfirmNotifyBody: string | null = null;
let confirmSystemNotifyDelivered = false;
const notifiedConfirmToolCallIds = new Set<string>();
let showConfirmToast: ((message: string) => void) | null = null;

export function registerConfirmToastHandler(handler: (message: string) => void): void {
    showConfirmToast = handler;
}

function loadElectronRemote(): {getCurrentWindow?: () => ElectronBrowserWindow} | undefined {
    if (typeof __non_webpack_require__ === "undefined") {
        return undefined;
    }
    try {
        return __non_webpack_require__("@electron/remote") as {
            getCurrentWindow?: () => ElectronBrowserWindow;
        };
    } catch {
        return undefined;
    }
}

function loadElectron(): {
    ipcRenderer?: {send: (channel: string, data: unknown) => void};
    BrowserWindow?: {
        getFocusedWindow?: () => ElectronBrowserWindow | null;
        getAllWindows?: () => ElectronBrowserWindow[];
    };
} | undefined {
    if (typeof __non_webpack_require__ === "undefined") {
        return undefined;
    }
    try {
        return __non_webpack_require__("electron") as {
            ipcRenderer?: {send: (channel: string, data: unknown) => void};
            BrowserWindow?: {
                getFocusedWindow?: () => ElectronBrowserWindow | null;
                getAllWindows?: () => ElectronBrowserWindow[];
            };
        };
    } catch {
        return undefined;
    }
}

function snapshotWindow(win: ElectronBrowserWindow | null | undefined) {
    if (!win) {
        return null;
    }
    try {
        return {isVisible: win.isVisible(), isMinimized: win.isMinimized()};
    } catch {
        return null;
    }
}

/** 思源桌面客户端（含独立窗口），不含浏览器与移动端 */
export function isSiYuanDesktopClient(): boolean {
    try {
        const fe = getFrontend();
        return fe === "desktop" || fe === "desktop-window";
    } catch {
        return navigator.userAgent.startsWith("SiYuan/") && !document.getElementById("sidebar");
    }
}

function probeElectronWindowNotVisible(): boolean | undefined {
    const cur = snapshotWindow(loadElectronRemote()?.getCurrentWindow?.());
    if (cur) {
        return !cur.isVisible || cur.isMinimized;
    }

    const electron = loadElectron();
    const focused = snapshotWindow(electron?.BrowserWindow?.getFocusedWindow?.() ?? null);
    if (focused) {
        return !focused.isVisible || focused.isMinimized;
    }

    const wins = electron?.BrowserWindow?.getAllWindows?.() ?? [];
    if (!wins.length) {
        return undefined;
    }
    return wins.every((w) => {
        const s = snapshotWindow(w);
        return !s || !s.isVisible || s.isMinimized;
    });
}

/** 当前窗口对用户是否「看不见」（Page Visibility + Electron 窗口状态） */
export function isWindowNotVisibleToUser(): boolean {
    if (document.hidden || document.visibilityState === "hidden") {
        return true;
    }
    if (!isSiYuanDesktopClient()) {
        return false;
    }
    return probeElectronWindowNotVisible() === true;
}

function loadSiyuanModule(): unknown {
    if (typeof __non_webpack_require__ !== "undefined") {
        try {
            return __non_webpack_require__("siyuan");
        } catch {
            /* fall through */
        }
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require("siyuan");
    } catch {
        return undefined;
    }
}

function getPlatformUtilsSendNotification(): SendNotificationFn | undefined {
    return platformUtils?.sendNotification ?? (() => {
        const mod = loadSiyuanModule() as {platformUtils?: {sendNotification?: SendNotificationFn}} | undefined;
        return mod?.platformUtils?.sendNotification;
    })();
}

function isSendNotificationOk(id: number): boolean {
    return id >= 0 || id === -1;
}

function sendNotificationViaElectronIpc(
    title: string,
    body: string,
    timeoutType: "default" | "never" = "default",
): boolean {
    const ipc = loadElectron()?.ipcRenderer;
    if (!ipc?.send) {
        return false;
    }
    try {
        ipc.send(SIYUAN_CMD, {
            cmd: "notification",
            title,
            body,
            timeoutType,
        });
        return true;
    } catch {
        return false;
    }
}

async function sendBrowserNotification(title: string, body: string): Promise<boolean> {
    if (typeof Notification === "undefined") {
        return false;
    }
    try {
        if (Notification.permission === "default") {
            await Notification.requestPermission();
        }
        if (Notification.permission !== "granted") {
            return false;
        }
        new Notification(title, {body});
        return true;
    } catch {
        return false;
    }
}

export function rememberConfirmNotifyBody(body: string): void {
    lastConfirmNotifyBody = body;
}

export function setPendingHiddenConfirmNotify(payload: {title: string; body: string} | null): void {
    pendingHiddenConfirmNotify = payload;
}

export function clearConfirmNotifyState(): void {
    pendingHiddenConfirmNotify = null;
    lastConfirmNotifyBody = null;
    confirmSystemNotifyDelivered = false;
    notifiedConfirmToolCallIds.clear();
}

function buildConfirmNotifyMessage(req: ToolConfirmRequest): string {
    return `Agent 等待确认：${req.toolName}。请在对话中高亮区域点击「允许执行」或「拒绝」。`;
}

/** 在 requestConfirm 成立时立即调用（不依赖 DOM 渲染） */
export function notifyToolConfirmRequired(req: ToolConfirmRequest): void {
    if (notifiedConfirmToolCallIds.has(req.toolCallId)) {
        return;
    }
    notifiedConfirmToolCallIds.add(req.toolCallId);
    deliverConfirmNotification(buildConfirmNotifyMessage(req));
}

/** 前台 toast；隐藏时系统通知 */
export function deliverConfirmNotification(message: string): void {
    rememberConfirmNotifyBody(message);
    const payload = {title: "Agent 等待确认", body: message};
    const hidden = isWindowNotVisibleToUser();

    if (hidden && isSiYuanDesktopClient()) {
        setPendingHiddenConfirmNotify(payload);
        void sendSiYuanDesktopNotification(payload).then((ok) => {
            if (ok) {
                markConfirmSystemNotifyDelivered();
            }
        });
        return;
    }

    setPendingHiddenConfirmNotify(null);
    resetConfirmSystemNotifyDelivered();
    showConfirmToast?.(message);
}

export function markConfirmSystemNotifyDelivered(): void {
    confirmSystemNotifyDelivered = true;
    pendingHiddenConfirmNotify = null;
}

export function resetConfirmSystemNotifyDelivered(): void {
    confirmSystemNotifyDelivered = false;
}

/** 首次隐藏发送失败时重试；或前台仅 toast、后隐藏时补发一次系统通知 */
export async function flushPendingHiddenConfirmNotification(): Promise<boolean> {
    if (!isWindowNotVisibleToUser() || !isSiYuanDesktopClient()) {
        return false;
    }
    if (confirmSystemNotifyDelivered) {
        return false;
    }
    if (!document.querySelector(".agent-msg-confirm")) {
        pendingHiddenConfirmNotify = null;
        return false;
    }

    const payload =
        pendingHiddenConfirmNotify ??
        (lastConfirmNotifyBody
            ? {title: "Agent 等待确认", body: lastConfirmNotifyBody}
            : null);
    if (!payload) {
        return false;
    }

    const ok = await sendSiYuanDesktopNotification(payload);
    if (ok) {
        markConfirmSystemNotifyDelivered();
    }
    return ok;
}

async function sendViaSiyuanPlatformUtils(title: string, body: string): Promise<boolean> {
    const send = getPlatformUtilsSendNotification();
    if (!send) {
        return false;
    }
    const id = await send({title, body, delayInSeconds: 0});
    return isSendNotificationOk(id);
}

export async function sendSiYuanDesktopNotification(options: {
    title: string;
    body: string;
}): Promise<boolean> {
    const title = options.title.trim();
    const body = options.body.trim();
    if (!title && !body) {
        return false;
    }
    if (!isSiYuanDesktopClient()) {
        return sendBrowserNotification(title, body);
    }

    if (await sendViaSiyuanPlatformUtils(title, body)) {
        return true;
    }
    if (sendNotificationViaElectronIpc(title, body)) {
        return true;
    }
    return sendBrowserNotification(title, body);
}

function onWindowVisibilityChanged(): void {
    if (!isWindowNotVisibleToUser()) {
        return;
    }
    void flushPendingHiddenConfirmNotification();
}

export function installConfirmVisibilityListener(): void {
    document.addEventListener("visibilitychange", onWindowVisibilityChanged);
}
