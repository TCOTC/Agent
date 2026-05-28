import {getFrontend, platformUtils} from "siyuan";

declare const __non_webpack_require__: NodeRequire | undefined;

/** localStorage 设为 `1` 时：确认提醒 / visibilitychange 会打诊断日志 */
export const VISIBILITY_DEBUG_STORAGE_KEY = "agent-debug-visibility";

type ElectronBrowserWindow = {
    isVisible(): boolean;
    isMinimized(): boolean;
};

export interface WindowVisibilityDiagnostics {
    at: string;
    context?: string;
    isSiYuanDesktopClient: boolean;
    frontend: string | null;
    pageVisibility: {
        hidden: boolean;
        visibilityState: string;
        hasFocus: boolean;
    };
    loaders: {
        hasNonWebpackRequire: boolean;
        hasRequire: boolean;
    };
    electron: {
        remoteModuleLoaded: boolean;
        remoteLoadError: string | null;
        electronModuleLoaded: boolean;
        electronLoadError: string | null;
        currentWindow: {isVisible: boolean; isMinimized: boolean} | null;
        focusedWindow: {isVisible: boolean; isMinimized: boolean} | null;
        allWindows: Array<{isVisible: boolean; isMinimized: boolean}>;
    };
    derived: {
        pageHidden: boolean;
        electronNotVisible: boolean | null;
        isWindowNotVisibleToUser: boolean;
    };
}

type RuntimeModuleLoad = {mod: unknown; error: string | null};

/** 字面量模块名 + __non_webpack_require__，避免 webpack 对动态 require 报警 */
function loadElectronRemoteModule(): RuntimeModuleLoad {
    if (typeof __non_webpack_require__ === "undefined") {
        return {mod: undefined, error: "no __non_webpack_require__"};
    }
    try {
        return {mod: __non_webpack_require__("@electron/remote"), error: null};
    } catch (e) {
        return {mod: undefined, error: e instanceof Error ? e.message : String(e)};
    }
}

function loadElectronModule(): RuntimeModuleLoad {
    if (typeof __non_webpack_require__ === "undefined") {
        return {mod: undefined, error: "no __non_webpack_require__"};
    }
    try {
        return {mod: __non_webpack_require__("electron"), error: null};
    } catch (e) {
        return {mod: undefined, error: e instanceof Error ? e.message : String(e)};
    }
}

function snapshotWindow(win: ElectronBrowserWindow | null | undefined) {
    if (!win) {
        return null;
    }
    try {
        return {isVisible: win.isVisible(), isMinimized: win.isMinimized()};
    } catch (e) {
        return null;
    }
}

/** 采集各信号快照，供控制台对比「前台 / 最小化 / 托盘隐藏」等场景 */
export function getWindowVisibilityDiagnostics(context?: string): WindowVisibilityDiagnostics {
    let frontend: string | null = null;
    try {
        frontend = getFrontend();
    } catch {
        frontend = null;
    }

    const remoteLoad = loadElectronRemoteModule();
    const remote = remoteLoad.mod as {
        getCurrentWindow?: () => ElectronBrowserWindow;
    } | undefined;

    const electronLoad = loadElectronModule();
    const electron = electronLoad.mod as {
        BrowserWindow?: {
            getFocusedWindow?: () => ElectronBrowserWindow | null;
            getAllWindows?: () => ElectronBrowserWindow[];
        };
    } | undefined;

    const currentWindow = snapshotWindow(remote?.getCurrentWindow?.());
    const focusedWindow = snapshotWindow(electron?.BrowserWindow?.getFocusedWindow?.() ?? null);
    let allWindows: Array<{isVisible: boolean; isMinimized: boolean}> = [];
    try {
        allWindows = (electron?.BrowserWindow?.getAllWindows?.() ?? [])
            .map((w) => snapshotWindow(w))
            .filter((w): w is {isVisible: boolean; isMinimized: boolean} => w != null);
    } catch {
        allWindows = [];
    }

    const pageHidden = document.hidden || document.visibilityState === "hidden";
    const electronNotVisible = probeElectronWindowNotVisible();

    return {
        at: new Date().toISOString(),
        context,
        isSiYuanDesktopClient: isSiYuanDesktopClient(),
        frontend,
        pageVisibility: {
            hidden: document.hidden,
            visibilityState: document.visibilityState,
            hasFocus: document.hasFocus(),
        },
        loaders: {
            hasNonWebpackRequire: typeof __non_webpack_require__ !== "undefined",
            hasRequire: typeof require !== "undefined",
        },
        electron: {
            remoteModuleLoaded: remote != null,
            remoteLoadError: remoteLoad.error,
            electronModuleLoaded: electron != null,
            electronLoadError: electronLoad.error,
            currentWindow,
            focusedWindow,
            allWindows,
        },
        derived: {
            pageHidden,
            electronNotVisible,
            isWindowNotVisibleToUser: isWindowNotVisibleToUser(),
        },
    };
}

export function isWindowVisibilityDebugEnabled(): boolean {
    try {
        return localStorage.getItem(VISIBILITY_DEBUG_STORAGE_KEY) === "1";
    } catch {
        return false;
    }
}

export function logWindowVisibilityDiagnostics(context?: string): WindowVisibilityDiagnostics {
    const diag = getWindowVisibilityDiagnostics(context);
    console.group(`[Agent] window visibility${context ? ` (${context})` : ""}`);
    console.log(diag);
    console.table({
        pageHidden: diag.derived.pageHidden,
        electronNotVisible: diag.derived.electronNotVisible,
        isWindowNotVisibleToUser: diag.derived.isWindowNotVisibleToUser,
        "document.hidden": diag.pageVisibility.hidden,
        "visibilityState": diag.pageVisibility.visibilityState,
        "document.hasFocus": diag.pageVisibility.hasFocus,
        "remote.current.isVisible": diag.electron.currentWindow?.isVisible,
        "remote.current.isMinimized": diag.electron.currentWindow?.isMinimized,
        "electron.focused.isVisible": diag.electron.focusedWindow?.isVisible,
        "allWindows.count": diag.electron.allWindows.length,
    });
    console.groupEnd();
    return diag;
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

/**
 * 桌面 Electron：@electron/remote 或 BrowserWindow.getFocusedWindow。
 * 任一可见且未最小化则视为「窗口仍可见」。
 */
function probeElectronWindowNotVisible(): boolean | undefined {
    const remoteLoad = loadElectronRemoteModule();
    const remote = remoteLoad.mod as {
        getCurrentWindow?: () => ElectronBrowserWindow;
    } | undefined;
    const cur = snapshotWindow(remote?.getCurrentWindow?.());
    if (cur) {
        return !cur.isVisible || cur.isMinimized;
    }

    const electronLoad = loadElectronModule();
    const electron = electronLoad.mod as {
        BrowserWindow?: {
            getFocusedWindow?: () => ElectronBrowserWindow | null;
            getAllWindows?: () => ElectronBrowserWindow[];
        };
    } | undefined;
    const focused = snapshotWindow(electron?.BrowserWindow?.getFocusedWindow?.() ?? null);
    if (focused) {
        return !focused.isVisible || focused.isMinimized;
    }

    const wins = electron?.BrowserWindow?.getAllWindows?.() ?? [];
    if (!wins.length) {
        return undefined;
    }
    // 所有窗口都不可见或最小化 → 认为用户看不见
    return wins.every((w) => {
        const s = snapshotWindow(w);
        return !s || !s.isVisible || s.isMinimized;
    });
}

/**
 * 当前窗口对用户是否「看不见」。
 * - Page Visibility（最小化、托盘隐藏等）
 * - 桌面 Electron 补充窗口状态
 */
export function isWindowNotVisibleToUser(): boolean {
    if (document.hidden || document.visibilityState === "hidden") {
        return true;
    }
    if (!isSiYuanDesktopClient()) {
        return false;
    }
    return probeElectronWindowNotVisible() === true;
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
    } catch (e) {
        console.warn("[Agent] Notification API failed", e);
        return false;
    }
}

export async function sendSiYuanDesktopNotification(options: {
    title: string;
    body: string;
}): Promise<void> {
    const title = options.title.trim();
    const body = options.body.trim();
    if (!title && !body) {
        return;
    }
    const send = platformUtils?.sendNotification;
    if (send) {
        const id = await send({title, body, delayInSeconds: 0});
        if (id >= 0) {
            if (isWindowVisibilityDebugEnabled()) {
                console.info("[Agent] sendNotification ok", {id, title});
            }
            return;
        }
        console.warn("[Agent] platformUtils.sendNotification returned", id);
    } else {
        console.warn("[Agent] platformUtils.sendNotification unavailable, trying Notification API");
    }
    const ok = await sendBrowserNotification(title, body);
    if (!ok) {
        console.warn("[Agent] desktop notification failed (platformUtils + Notification API)");
    }
}

/** 挂到 window，便于在思源开发者工具控制台手动调用 */
export function installWindowVisibilityDebug(): void {
    const w = window as Window & {
        __agentDebugVisibility?: () => WindowVisibilityDiagnostics;
    };
    w.__agentDebugVisibility = () => logWindowVisibilityDiagnostics("manual");

    if (!isWindowVisibilityDebugEnabled()) {
        return;
    }
    document.addEventListener("visibilitychange", () => {
        logWindowVisibilityDiagnostics("visibilitychange");
    });
    console.info(
        "[Agent] visibility debug on: localStorage.removeItem('%s') to disable",
        VISIBILITY_DEBUG_STORAGE_KEY,
    );
}
