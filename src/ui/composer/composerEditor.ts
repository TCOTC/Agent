import {Editor} from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import HardBreak from "@tiptap/extension-hard-break";
import {Placeholder} from "@tiptap/extensions/placeholder";
import {UndoRedo} from "@tiptap/extensions/undo-redo";
import type {SuggestionKeyDownProps, SuggestionProps} from "@tiptap/suggestion";
import type {Node as ProseMirrorNode} from "@tiptap/pm/model";

import type {App} from "siyuan";

import type {KernelExecutor} from "../../agent/types";
import type {SendKeyMode} from "../../settings/types";
import {navigateToBlockRef} from "../../siyuan/blockNavigation";
import {createComposerBlockRefExtension} from "./composerBlockRef";
import {searchBlockMentions, type BlockMentionHit} from "./blockMentionSearch";
import {
    closeComposerMentionMenu,
    handleComposerMentionMenuKeyDown,
    isComposerMentionMenuOpen,
    openComposerMentionMenu,
    updateComposerMentionMenu,
} from "./mentionMenu";

export interface ComposerEditorHandle {
    focus: () => void;
    destroy: () => void;
    getSendText: () => string;
    clear: () => void;
    setSendText: (text: string) => void;
    isSuggestionActive: () => boolean;
}

export interface MountComposerEditorOptions {
    editorHost: HTMLElement;
    app: App;
    kernel: KernelExecutor;
    placeholder?: string;
    sendKeyMode: SendKeyMode;
    onSend: () => void;
}

function blockRefDisplayLabel(attrs: {id?: string | null; label?: string | null}): string {
    const label = attrs.label?.trim();
    if (label) {
        return label;
    }
    return String(attrs.id ?? "");
}

function blockMentionMarkdown(label: string, blockId: string): string {
    const escLabel = label.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
    return `@[${escLabel}](siyuan://blocks/${blockId})`;
}

function inlineNodesToSendText(node: ProseMirrorNode): string {
    let out = "";
    node.forEach((child) => {
        if (child.type.name === "mention") {
            const id = String(child.attrs.id ?? "");
            const label = String(child.attrs.label ?? id);
            out += blockMentionMarkdown(label, id);
        } else if (child.isText) {
            out += child.text ?? "";
        } else if (child.type.name === "hardBreak") {
            out += "\n";
        }
    });
    return out;
}

/** 将编辑器文档序列化为发送给 Agent 的纯文本（mention → `@[label](siyuan://blocks/id)`） */
export function serializeComposerSendText(editor: Editor): string {
    const parts: string[] = [];
    editor.state.doc.forEach((node) => {
        if (node.type.name === "paragraph") {
            parts.push(inlineNodesToSendText(node));
        }
    });
    return parts.join("\n").trim();
}

function createMentionSuggestionRenderer(
    anchor: HTMLElement,
): () => {
    onStart: (props: SuggestionProps<BlockMentionHit>) => void;
    onUpdate: (props: SuggestionProps<BlockMentionHit>) => void;
    onExit: () => void;
    onKeyDown: (props: SuggestionKeyDownProps) => boolean;
} {
    let pickCommand: ((item: BlockMentionHit) => void) | null = null;

    const pick = (hit: BlockMentionHit) => {
        pickCommand?.(hit);
    };

    const clientRect = (props: SuggestionProps<BlockMentionHit>) => props.clientRect?.() ?? null;

    return () => ({
        onStart: (props) => {
            pickCommand = (item) => props.command(item);
            openComposerMentionMenu({
                items: props.items,
                clientRect: clientRect(props),
                anchor,
                onPick: pick,
            });
        },
        onUpdate: (props) => {
            pickCommand = (item) => props.command(item);
            updateComposerMentionMenu(props.items, clientRect(props), pick);
        },
        onExit: () => {
            closeComposerMentionMenu();
            pickCommand = null;
        },
        onKeyDown: ({event}) => handleComposerMentionMenuKeyDown(event, pick),
    });
}

function handleSendKey(
    ev: KeyboardEvent,
    editor: Editor,
    mode: SendKeyMode,
    send: () => void,
    suggestionActive: () => boolean,
): boolean {
    if (ev.key !== "Enter" || ev.altKey || suggestionActive()) {
        return false;
    }
    const mod = ev.ctrlKey || ev.metaKey;
    if (mode === "enter") {
        if (ev.shiftKey || mod) {
            ev.preventDefault();
            editor.commands.setHardBreak();
            return true;
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
    ev.preventDefault();
    editor.commands.setHardBreak();
    return true;
}

/** 挂载 TipTap Composer（块 mention 芯片 + Undo/Redo） */
export function mountComposerEditor(opts: MountComposerEditorOptions): ComposerEditorHandle {
    const isSuggestionActive = () => isComposerMentionMenuOpen();

    const BlockRef = createComposerBlockRefExtension();

    const placeholderText = opts.placeholder ?? "说点什么…";

    const editor = new Editor({
        element: opts.editorHost,
        extensions: [
            Document,
            Paragraph,
            Text,
            HardBreak,
            UndoRedo,
            Placeholder.configure({
                placeholder: placeholderText,
                emptyEditorClass: "is-editor-empty",
                emptyNodeClass: "is-empty",
                dataAttribute: "placeholder",
            }),
            BlockRef.configure({
                renderText: ({node}) =>
                    blockMentionMarkdown(blockRefDisplayLabel(node.attrs), String(node.attrs.id ?? "")),
                suggestion: {
                    char: "@",
                    allowSpaces: true,
                    items: async ({query}) => searchBlockMentions(opts.kernel, query),
                    render: createMentionSuggestionRenderer(opts.editorHost),
                    command: ({editor: ed, range, props}) => {
                        const hit = props as BlockMentionHit;
                        ed.chain().focus().insertContentAt(range, [
                            {
                                type: "mention",
                                attrs: {
                                    id: hit.id,
                                    label: hit.label,
                                    blockType: hit.blockType,
                                    blockSubtype: hit.blockSubtype,
                                },
                            },
                            {type: "text", text: " "},
                        ]).run();
                    },
                },
            }),
        ],
        editorProps: {
            attributes: {
                class: "agent-composer__pm",
            },
            handleClick: (_view, _pos, event) => {
                if ((event.target as HTMLElement).closest?.("[data-action=\"remove\"]")) {
                    return false;
                }
                const refEl = (event.target as HTMLElement).closest?.(".agent-block-ref-chip__ref");
                if (!refEl) {
                    return false;
                }
                const blockId = refEl.getAttribute("data-id");
                if (!blockId) {
                    return false;
                }
                event.preventDefault();
                event.stopPropagation();
                void navigateToBlockRef({
                    app: opts.app,
                    kernel: opts.kernel,
                    blockId,
                    shiftKey: event.shiftKey,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    metaKey: event.metaKey,
                });
                return true;
            },
            handleKeyDown: (_view, event) => {
                if (handleSendKey(event, editor, opts.sendKeyMode, opts.onSend, isSuggestionActive)) {
                    return true;
                }
                return false;
            },
        },
    });

    const syncEditorEmptyClass = () => {
        const root = editor.view.dom;
        root.classList.toggle("is-editor-empty", editor.isEmpty);
        root.style.setProperty("--agent-composer-placeholder", JSON.stringify(placeholderText));
    };
    editor.on("create", syncEditorEmptyClass);
    editor.on("update", syncEditorEmptyClass);
    syncEditorEmptyClass();

    return {
        focus: () => editor.commands.focus(),
        destroy: () => editor.destroy(),
        getSendText: () => serializeComposerSendText(editor),
        clear: () => editor.commands.clearContent(),
        setSendText: (text: string) => {
            const lines = text.split("\n");
            const content = lines.map((line) => ({
                type: "paragraph" as const,
                content: line ? [{type: "text" as const, text: line}] : [],
            }));
            editor.commands.setContent({type: "doc", content});
        },
        isSuggestionActive,
    };
}
