/** assistant 消息行尾部 chrome（确认条、操作按钮）的 DOM 顺序与挂载 */

const detachedConfirmsByRow = new WeakMap<HTMLElement, HTMLElement>();
const detachedActionsByRow = new WeakMap<HTMLElement, HTMLElement>();

const ASSISTANT_CHROME_SELECTORS = [
    ".agent-msg__think",
    ".agent-msg__body",
    ".agent-msg__tools",
    ".agent-msg__diffs",
    ".agent-msg__confirms",
    ".agent-msg__actions",
] as const;

/** 仅在子节点顺序错乱时重排，避免流式阶段每帧移动 body / tools 触发 Mutation */
export function ensureAssistantRowChromeOrder(row: HTMLElement): void {
    const nodes: Element[] = [];
    for (const sel of ASSISTANT_CHROME_SELECTORS) {
        const n = row.querySelector(sel);
        if (n) {
            nodes.push(n);
        }
    }
    if (nodes.length < 2) {
        return;
    }
    const indexByChild = new Map<Element, number>();
    for (let i = 0; i < row.children.length; i++) {
        indexByChild.set(row.children[i]!, i);
    }
    let lastIdx = -1;
    for (const n of nodes) {
        const idx = indexByChild.get(n);
        if (idx === undefined) {
            continue;
        }
        if (idx < lastIdx) {
            for (const el of nodes) {
                row.appendChild(el);
            }
            return;
        }
        lastIdx = idx;
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
