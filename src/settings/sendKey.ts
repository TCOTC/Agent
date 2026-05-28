import type {SendKeyMode} from "./types";

export const SEND_KEY_MODE_OPTIONS: {id: SendKeyMode; label: string; description: string}[] = [
    {
        id: "enter",
        label: "回车 发送",
        description: "回车 发送；Shift+回车 / Ctrl+回车 换行",
    },
    {
        id: "ctrlEnter",
        label: "Ctrl+回车 发送",
        description: "Ctrl+回车 发送；回车 / Shift+回车 换行",
    },
];

export function getSendKeyHint(mode: SendKeyMode): string {
    return SEND_KEY_MODE_OPTIONS.find((o) => o.id === mode)?.description ?? SEND_KEY_MODE_OPTIONS[0].description;
}

export function getSendKeyHintHtml(mode: SendKeyMode): string {
    if (mode === "ctrlEnter") {
        return "<kbd>Ctrl+回车</kbd> 发送；<kbd>回车</kbd> / <kbd>Shift+回车</kbd> 换行";
    }
    return "<kbd>回车</kbd> 发送；<kbd>Shift+回车</kbd> / <kbd>Ctrl+回车</kbd> 换行";
}

function insertNewlineAtCursor(el: HTMLTextAreaElement): void {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    el.value = el.value.slice(0, start) + "\n" + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + 1;
    el.dispatchEvent(new Event("input", {bubbles: true}));
}

/** 处理输入框 Enter 相关按键；返回 true 表示已消费事件 */
export function handleComposerEnterKey(
    ev: KeyboardEvent,
    el: HTMLTextAreaElement,
    mode: SendKeyMode,
    send: () => void,
): boolean {
    if (ev.key !== "Enter" || ev.altKey) {
        return false;
    }
    const mod = ev.ctrlKey || ev.metaKey;
    if (mode === "enter") {
        if (ev.shiftKey || mod) {
            if (mod) {
                ev.preventDefault();
                insertNewlineAtCursor(el);
            }
            return mod;
        }
        ev.preventDefault();
        send();
        return true;
    }
    if (mod) {
        ev.preventDefault();
        send();
        return true;
    }
    return false;
}
