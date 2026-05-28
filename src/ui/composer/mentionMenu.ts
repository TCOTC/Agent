import {Menu, type IMenu} from "siyuan";

import {getIconByType} from "../../siyuan/blockIcon";
import {
    closeOtherComposerDropdowns,
    registerComposerMenuCloser,
    unregisterComposerMenuCloser,
} from "./composerDropdown";
import type {BlockMentionHit} from "./blockMentionSearch";

const MENU_ID = "agent-composer-mention";
const MENU_GAP_PX = 4;
const VIEWPORT_TOP_MIN_PX = 32;

let activeMenu: Menu | null = null;
let activeItems: BlockMentionHit[] = [];
let selectedIndex = 0;
let onCloseCb: (() => void) | null = null;
let lastClientRect: DOMRect | null = null;
let lastAnchor: HTMLElement | null = null;

function escHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function placeMenuNearCaret(menuEl: HTMLElement, rect: DOMRect): void {
    const menuH = menuEl.getBoundingClientRect().height;
    let top = rect.top - menuH - MENU_GAP_PX;
    if (top < VIEWPORT_TOP_MIN_PX) {
        top = rect.bottom + MENU_GAP_PX;
    }
    menuEl.style.top = `${top}px`;
    menuEl.style.left = `${Math.min(rect.left, window.innerWidth - menuEl.offsetWidth - 8)}px`;
}

function syncMenuFocus(): void {
    if (!activeMenu?.element) {
        return;
    }
    const items = activeMenu.element.querySelectorAll<HTMLElement>("[data-mention-index]");
    items.forEach((el) => {
        const i = Number(el.dataset.mentionIndex);
        el.classList.toggle("b3-menu__item--current", i === selectedIndex);
    });
    const current = activeMenu.element.querySelector(
        `[data-mention-index="${selectedIndex}"]`,
    ) as HTMLElement | null;
    current?.scrollIntoView({block: "nearest"});
}

function addHitItem(menu: Menu, hit: BlockMentionHit, index: number, onPick: (hit: BlockMentionHit) => void): void {
    const iconId = getIconByType(hit.blockType, hit.blockSubtype);
    const plainLabel = hit.label;
    const item: IMenu = {
        icon: iconId,
        label: plainLabel,
        bind: (el) => {
            el.dataset.mentionIndex = String(index);
            const labelEl = el.querySelector(".b3-menu__label");
            if (labelEl) {
                if (hit.sub) {
                    labelEl.innerHTML =
                        `<span class="agent-mention-menu__title">${hit.labelHtml ?? escHtml(plainLabel)}</span>`
                        + `<span class="agent-mention-menu__meta">${escHtml(hit.sub)}</span>`;
                    el.classList.add("agent-mention-menu__item--two-line");
                } else if (hit.labelHtml) {
                    labelEl.innerHTML = hit.labelHtml;
                }
            }
            if (index === selectedIndex) {
                el.classList.add("b3-menu__item--current");
            }
        },
        click: () => {
            onPick(hit);
        },
    };
    menu.addItem(item);
}

function populateMenu(menu: Menu, items: BlockMentionHit[], onPick: (hit: BlockMentionHit) => void): void {
    let tabHeaderDone = false;
    for (let i = 0; i < items.length; i++) {
        const hit = items[i];
        if (hit.source === "tab" && !tabHeaderDone) {
            menu.addItem({type: "readonly", label: "当前窗口"});
            tabHeaderDone = true;
        }
        addHitItem(menu, hit, i, onPick);
    }
    if (!items.length) {
        menu.addItem({type: "readonly", label: "无匹配块"});
    }
}

function finishMentionMenuClose(): void {
    unregisterComposerMenuCloser(closeComposerMentionMenu);
    activeMenu = null;
    activeItems = [];
    onCloseCb?.();
    onCloseCb = null;
    lastClientRect = null;
    lastAnchor = null;
}

export function isComposerMentionMenuOpen(): boolean {
    return activeMenu !== null;
}

export function closeComposerMentionMenu(): void {
    activeMenu?.close();
}

export function openComposerMentionMenu(opts: {
    items: BlockMentionHit[];
    clientRect: DOMRect | null;
    anchor: HTMLElement;
    onPick: (hit: BlockMentionHit) => void;
    onClose?: () => void;
}): void {
    closeComposerMentionMenu();
    closeOtherComposerDropdowns();

    const items = opts.items;
    activeItems = items;
    selectedIndex = 0;
    if (opts.onClose) {
        onCloseCb = opts.onClose;
    }
    lastClientRect = opts.clientRect;
    lastAnchor = opts.anchor;

    const menu = new Menu(MENU_ID, () => {
        finishMentionMenuClose();
    });
    activeMenu = menu;
    populateMenu(menu, items, opts.onPick);

    const rect = opts.clientRect ?? opts.anchor.getBoundingClientRect();
    menu.open({
        x: rect.left,
        y: rect.top,
        h: rect.height || 0,
    });
    placeMenuNearCaret(menu.element, rect);
    registerComposerMenuCloser(closeComposerMentionMenu);
    syncMenuFocus();
}

export function updateComposerMentionMenu(
    items: BlockMentionHit[],
    clientRect: DOMRect | null,
    onPick: (hit: BlockMentionHit) => void,
): void {
    if (!lastAnchor) {
        return;
    }
    openComposerMentionMenu({
        items,
        clientRect: clientRect ?? lastClientRect,
        anchor: lastAnchor,
        onPick,
    });
}

export function handleComposerMentionMenuKeyDown(
    event: KeyboardEvent,
    onPick: (hit: BlockMentionHit) => void,
): boolean {
    if (!activeMenu || !activeItems.length) {
        return false;
    }
    if (event.key === "ArrowDown") {
        event.preventDefault();
        selectedIndex = (selectedIndex + 1) % activeItems.length;
        syncMenuFocus();
        return true;
    }
    if (event.key === "ArrowUp") {
        event.preventDefault();
        selectedIndex = (selectedIndex - 1 + activeItems.length) % activeItems.length;
        syncMenuFocus();
        return true;
    }
    if (event.key === "Enter") {
        event.preventDefault();
        const hit = activeItems[selectedIndex];
        if (hit) {
            onPick(hit);
        }
        return true;
    }
    if (event.key === "Escape") {
        closeComposerMentionMenu();
        return true;
    }
    return false;
}
