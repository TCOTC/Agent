/** 聊天区贴底滚动：仅在用户已在底部时随内容增高滚到底 */

/** 子像素舍入容差（px），不为「靠近底部」留宽限 */
const BOTTOM_EPSILON_PX = 1;

let chatBodyEl: HTMLElement | null = null;

export function bindAgentChatScrollBody(el: HTMLElement): void {
    chatBodyEl = el;
}

export function unbindAgentChatScrollBody(): void {
    chatBodyEl = null;
}

export function isAgentChatAtBottom(): boolean {
    if (!chatBodyEl) {
        return false;
    }
    const dist = chatBodyEl.scrollHeight - chatBodyEl.scrollTop - chatBodyEl.clientHeight;
    return dist <= BOTTOM_EPSILON_PX;
}

/** 无条件滚到底（如切换会话、显式滚到底） */
export function scrollAgentChatToEnd(): void {
    if (!chatBodyEl) {
        return;
    }
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (!chatBodyEl) {
                return;
            }
            chatBodyEl.scrollTop = chatBodyEl.scrollHeight;
        });
    });
}

/**
 * 在 DOM 布局完成后滚到底。
 * @param atBottom 调用方在写入 DOM **之前** 记录的 `isAgentChatAtBottom()`
 */
export function scrollAgentChatToEndAfterLayoutIfSticky(atBottom: boolean): void {
    if (!atBottom || !chatBodyEl) {
        return;
    }
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (!chatBodyEl) {
                return;
            }
            chatBodyEl.scrollTop = chatBodyEl.scrollHeight;
        });
    });
}
