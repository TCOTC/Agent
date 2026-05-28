import Mention from "@tiptap/extension-mention";
import {mergeAttributes} from "@tiptap/core";

import {createSiyuanSvgIcon, getIconByType} from "../../siyuan/blockIcon";

export interface ComposerBlockRefOptions {
    onRemove?: (blockId: string) => void;
}

function displayLabel(attrs: {id?: string | null; label?: string | null}): string {
    const label = attrs.label?.trim();
    return label || String(attrs.id ?? "");
}

/** Composer 内联块引用：容器 + 类型图标（hover 变关闭）+ 可点击块引用文案 */
export function createComposerBlockRefExtension(options: ComposerBlockRefOptions = {}) {
    const onRemove = options.onRemove;
    return Mention.extend({
        addOptions() {
            return {
                ...this.parent?.(),
                onRemove,
            };
        },

        addAttributes() {
            return {
                ...this.parent?.(),
                blockType: {
                    default: "NodeParagraph",
                    parseHTML: (element) =>
                        element.closest(".agent-block-ref-chip")?.getAttribute("data-block-type") ?? "NodeParagraph",
                    renderHTML: (attributes) => ({
                        "data-block-type": attributes.blockType,
                    }),
                },
                blockSubtype: {
                    default: null,
                    parseHTML: (element) =>
                        element.closest(".agent-block-ref-chip")?.getAttribute("data-block-subtype"),
                    renderHTML: (attributes) => {
                        if (!attributes.blockSubtype) {
                            return {};
                        }
                        return {"data-block-subtype": attributes.blockSubtype};
                    },
                },
            };
        },

        addNodeView() {
            return ({node, getPos, editor}) => {
                const chip = document.createElement("span");
                chip.className = "agent-block-ref-chip";
                chip.contentEditable = "false";
                chip.dataset.blockType = String(node.attrs.blockType ?? "NodeParagraph");
                if (node.attrs.blockSubtype) {
                    chip.dataset.blockSubtype = String(node.attrs.blockSubtype);
                }

                const lead = document.createElement("span");
                lead.className = "agent-block-ref-chip__lead";
                lead.dataset.action = "remove";
                lead.setAttribute("role", "button");
                lead.setAttribute("tabindex", "-1");
                lead.title = "移除引用";
                lead.setAttribute("aria-label", "移除引用");

                const typeIcon = document.createElement("span");
                typeIcon.className = "agent-block-ref-chip__type";
                typeIcon.appendChild(createSiyuanSvgIcon(
                    getIconByType(String(node.attrs.blockType ?? "NodeParagraph"), node.attrs.blockSubtype),
                    "agent-block-ref-chip__svg",
                ));

                const removeIcon = document.createElement("span");
                removeIcon.className = "agent-block-ref-chip__remove";
                removeIcon.appendChild(createSiyuanSvgIcon("iconClose", "agent-block-ref-chip__svg"));

                lead.append(typeIcon, removeIcon);

                const ref = document.createElement("span");
                ref.className = "agent-block-ref-chip__ref";
                ref.dataset.type = "block-ref";
                ref.dataset.id = String(node.attrs.id ?? "");
                ref.dataset.subtype = "s";
                ref.textContent = displayLabel(node.attrs);

                chip.append(lead, ref);

                const onRemoveClick = (ev: Event) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    const pos = getPos();
                    if (typeof pos !== "number") {
                        return;
                    }
                    const blockId = String(node.attrs.id ?? "");
                    editor.chain().focus().deleteRange({from: pos, to: pos + node.nodeSize}).run();
                    onRemove?.(blockId);
                };

                lead.addEventListener("mousedown", onRemoveClick);
                lead.addEventListener("click", onRemoveClick);

                return {
                    dom: chip,
                    ignoreMutation: () => true,
                    stopEvent: (event) => {
                        const target = event.target as HTMLElement;
                        return !!target.closest?.("[data-action=\"remove\"]");
                    },
                };
            };
        },

        renderHTML({node, HTMLAttributes}) {
            return [
                "span",
                mergeAttributes(
                    {"class": "agent-block-ref-chip", "data-block-type": node.attrs.blockType},
                    HTMLAttributes,
                ),
                displayLabel(node.attrs),
            ];
        },
    });
}
