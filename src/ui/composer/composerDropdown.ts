import {Menu, type IMenu} from "siyuan";

export interface ComposerDropdownOption<T extends string = string> {
    value: T;
    label: string;
    hint?: string;
}

export interface ComposerDropdownHandle<T extends string = string> {
    refresh: () => void;
    setValue: (value: T) => void;
    close: () => void;
    destroy: () => void;
}

const dropdownClosers = new Set<() => void>();

function closeOtherComposerDropdowns(except?: () => void): void {
    for (const close of dropdownClosers) {
        if (close !== except) {
            close();
        }
    }
}

/** 关闭所有 Composer 下拉菜单（slash / mention 等打开时可调用） */
export function closeAllComposerDropdowns(): void {
    closeOtherComposerDropdowns();
}

const MENU_GAP_PX = 4;
/** 与思源顶栏留白一致，避免菜单顶到窗口上沿 */
const VIEWPORT_TOP_MIN_PX = 32;

/** 将 commonMenu 锚定在触发器上方（Composer 底栏默认向上展开） */
function placeMenuAboveTrigger(menuEl: HTMLElement, anchor: DOMRect): void {
    const menuH = menuEl.getBoundingClientRect().height;
    let top = anchor.top - menuH - MENU_GAP_PX;
    if (top < VIEWPORT_TOP_MIN_PX) {
        top = anchor.bottom + MENU_GAP_PX;
    }
    menuEl.style.top = `${top}px`;
}

/** Composer 底部无边框下拉（模式 / 模型等，使用思源 Menu） */
export function mountComposerDropdown<T extends string>(opts: {
    host: HTMLElement;
    menuId: string;
    ariaLabel: string;
    getValue: () => T;
    getOptions: () => ComposerDropdownOption<T>[];
    onChange: (value: T) => void;
    getTriggerLabel?: (value: T, option?: ComposerDropdownOption<T>) => string;
    buildMenuItems?: (menu: Menu) => void;
    onOpen?: () => void;
    onClose?: () => void;
}): ComposerDropdownHandle<T> {
    const host = opts.host;
    host.classList.add("agent-dd");

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "agent-dd__trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", opts.ariaLabel);

    const labelEl = document.createElement("span");
    labelEl.className = "agent-dd__label";
    trigger.append(labelEl);
    host.append(trigger);

    let open = false;
    let activeMenu: Menu | null = null;

    const findOption = (value: T) => opts.getOptions().find((o) => o.value === value);

    const syncTriggerLabel = () => {
        const value = opts.getValue();
        const option = findOption(value);
        labelEl.textContent = opts.getTriggerLabel?.(value, option) ?? option?.label ?? value;
    };

    const close = () => {
        if (!open) {
            return;
        }
        open = false;
        activeMenu?.close();
        activeMenu = null;
        trigger.setAttribute("aria-expanded", "false");
        opts.onClose?.();
    };

    const buildOptionItems = (menu: Menu) => {
        const value = opts.getValue();
        for (const option of opts.getOptions()) {
            const item: IMenu = {
                iconHTML: "",
                label: option.label,
                current: option.value === value,
                click: () => {
                    if (option.value !== opts.getValue()) {
                        opts.onChange(option.value);
                    }
                    syncTriggerLabel();
                },
            };
            if (option.hint) {
                item.bind = (element) => {
                    element.title = option.hint!;
                };
            }
            menu.addItem(item);
        }
    };

    const openMenu = () => {
        closeOtherComposerDropdowns(close);
        const rect = trigger.getBoundingClientRect();
        const menu = new Menu(opts.menuId, () => {
            open = false;
            activeMenu = null;
            dropdownClosers.delete(close);
            trigger.setAttribute("aria-expanded", "false");
            opts.onClose?.();
        });
        if (menu.isOpen) {
            open = false;
            activeMenu = null;
            trigger.setAttribute("aria-expanded", "false");
            return;
        }
        activeMenu = menu;
        buildOptionItems(menu);
        opts.buildMenuItems?.(menu);
        menu.open({
            x: rect.left,
            y: rect.top,
            h: rect.height,
        });
        placeMenuAboveTrigger(menu.element, rect);
        open = true;
        trigger.setAttribute("aria-expanded", "true");
        dropdownClosers.add(close);
        opts.onOpen?.();
    };

    trigger.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (open) {
            close();
        } else {
            openMenu();
        }
    });

    const refresh = () => {
        syncTriggerLabel();
    };

    const setValue = (_value: T) => {
        syncTriggerLabel();
    };

    const destroy = () => {
        dropdownClosers.delete(close);
        close();
        host.replaceChildren();
        host.classList.remove("agent-dd");
    };

    syncTriggerLabel();

    return {refresh, setValue, close, destroy};
}
