/** assistant 消息行尾部 chrome（确认条、操作按钮）的 DOM 顺序与挂载 */

const detachedConfirmsByRow = new WeakMap<HTMLElement, HTMLElement>();
const detachedActionsByRow = new WeakMap<HTMLElement, HTMLElement>();

export function ensureAssistantRowChromeOrder(row: HTMLElement): void {
    const nodes = [
        row.querySelector(".agent-msg__think"),
        row.querySelector(".agent-msg__body"),
        row.querySelector(".agent-msg__tools"),
        row.querySelector(".agent-msg__confirms"),
        row.querySelector(".agent-msg__actions"),
    ].filter((n): n is Element => n != null);
    for (const el of nodes) {
        row.appendChild(el);
    }
}

function createAssistantConfirmsEl(): HTMLElement {
    const host = document.createElement("div");
    host.className = "agent-msg__confirms";
    host.setAttribute("aria-live", "polite");
    return host;
}

export function mountAssistantConfirmHost(row: HTMLElement): HTMLElement {
    let host = row.querySelector(".agent-msg__confirms") as HTMLElement | null;
    if (!host) {
        host = detachedConfirmsByRow.get(row) ?? createAssistantConfirmsEl();
        detachedConfirmsByRow.delete(row);
        row.appendChild(host);
        ensureAssistantRowChromeOrder(row);
    }
    return host;
}

export function detachAssistantConfirmHost(row: HTMLElement): void {
    const host = row.querySelector(".agent-msg__confirms");
    if (!host) {
        return;
    }
    host.remove();
    detachedConfirmsByRow.set(row, host);
}

export function createAssistantActionsEl(): HTMLElement {
    const actions = document.createElement("div");
    actions.className = "agent-msg__actions";
    actions.innerHTML = `<button type="button" class="agent-msg__action" data-copy-md title="复制 Markdown">复制</button>
  <button type="button" class="agent-msg__action" data-export-assistant title="导出对话">导出</button>
  <button type="button" class="agent-msg__action" data-regenerate-assistant title="重新生成">重新生成</button>`;
    return actions;
}

export function detachAssistantActions(row: HTMLElement): void {
    const actions = row.querySelector(".agent-msg__actions");
    if (!actions) {
        return;
    }
    actions.remove();
    detachedActionsByRow.set(row, actions);
}

export function mountAssistantActions(row: HTMLElement): HTMLElement {
    let actions = row.querySelector(".agent-msg__actions") as HTMLElement | null;
    if (!actions) {
        actions = detachedActionsByRow.get(row) ?? createAssistantActionsEl();
        detachedActionsByRow.delete(row);
        row.appendChild(actions);
        ensureAssistantRowChromeOrder(row);
    }
    return actions;
}
