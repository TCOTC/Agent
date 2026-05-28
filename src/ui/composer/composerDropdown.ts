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

/** Composer 底部无边框下拉（模式 / 模型等，菜单样式对齐思源 b3-menu） */
export function mountComposerDropdown<T extends string>(opts: {
    host: HTMLElement;
    ariaLabel: string;
    getValue: () => T;
    getOptions: () => ComposerDropdownOption<T>[];
    onChange: (value: T) => void;
    getTriggerLabel?: (value: T, option?: ComposerDropdownOption<T>) => string;
    renderMenuFooter?: (footer: HTMLElement) => void;
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
    const chevron = document.createElement("span");
    chevron.className = "agent-dd__chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "▾";
    trigger.append(labelEl, chevron);

    const menu = document.createElement("div");
    menu.className = "b3-menu b3-menu--list agent-dd-menu fn__none";
    menu.setAttribute("role", "listbox");

    const itemsWrap = document.createElement("div");
    itemsWrap.className = "b3-menu__items";
    menu.append(itemsWrap);

    host.append(trigger, menu);

    let open = false;

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
        menu.classList.add("fn__none");
        trigger.setAttribute("aria-expanded", "false");
        opts.onClose?.();
    };

    const openMenu = () => {
        open = true;
        menu.classList.remove("fn__none");
        trigger.setAttribute("aria-expanded", "true");
        opts.onOpen?.();
        renderMenu();
    };

    const renderMenu = () => {
        itemsWrap.replaceChildren();
        const value = opts.getValue();
        for (const option of opts.getOptions()) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "b3-menu__item";
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(option.value === value));
            if (option.value === value) {
                item.classList.add("b3-menu__item--current");
            }
            if (option.hint) {
                item.title = option.hint;
            }
            item.dataset.value = option.value;
            const main = document.createElement("span");
            main.className = "b3-menu__label";
            main.textContent = option.label;
            item.append(main);
            if (option.value === value) {
                const mark = document.createElement("span");
                mark.className = "b3-menu__action b3-menu__action--show";
                mark.setAttribute("aria-hidden", "true");
                mark.textContent = "✓";
                item.append(mark);
            }
            item.addEventListener("click", (ev) => {
                ev.stopPropagation();
                if (option.value !== opts.getValue()) {
                    opts.onChange(option.value);
                }
                close();
                syncTriggerLabel();
            });
            itemsWrap.append(item);
        }

        const existingFooter = menu.querySelector(".agent-dd-menu__footer");
        existingFooter?.remove();
        if (opts.renderMenuFooter) {
            const sep = document.createElement("button");
            sep.type = "button";
            sep.className = "b3-menu__separator";
            sep.tabIndex = -1;
            sep.setAttribute("aria-hidden", "true");
            menu.append(sep);
            const footer = document.createElement("div");
            footer.className = "agent-dd-menu__footer";
            opts.renderMenuFooter(footer);
            menu.append(footer);
        }
    };

    const onDocClick = (ev: MouseEvent) => {
        if (!host.contains(ev.target as Node)) {
            close();
        }
    };

    const onKeydown = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
            close();
        }
    };

    menu.addEventListener("click", (ev) => ev.stopPropagation());

    trigger.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (open) {
            close();
        } else {
            openMenu();
        }
    });

    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeydown);

    const refresh = () => {
        syncTriggerLabel();
        if (open) {
            renderMenu();
        }
    };

    const setValue = (_value: T) => {
        syncTriggerLabel();
        if (open) {
            renderMenu();
        }
    };

    const destroy = () => {
        close();
        document.removeEventListener("click", onDocClick);
        document.removeEventListener("keydown", onKeydown);
        host.replaceChildren();
        host.classList.remove("agent-dd");
    };

    syncTriggerLabel();

    return {refresh, setValue, close, destroy};
}
