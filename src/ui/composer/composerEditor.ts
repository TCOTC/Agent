import {Editor} from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import HardBreak from "@tiptap/extension-hard-break";
import {Placeholder} from "@tiptap/extensions/placeholder";
import {UndoRedo} from "@tiptap/extensions/undo-redo";
import type {SuggestionKeyDownProps, SuggestionProps} from "@tiptap/suggestion";
import type {Node as ProseMirrorNode} from "@tiptap/pm/model";
import {TextSelection} from "@tiptap/pm/state";
import type {EditorView} from "@tiptap/pm/view";

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

/** 段首落点用，便于在块引用芯片前点击/输入；发送时剥离 */
const COMPOSER_LEADING_ZWSP = "\u200b";

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
            out += (child.text ?? "").replaceAll(COMPOSER_LEADING_ZWSP, "");
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

/** 是否有用户输入（含空格；不含零宽占位与纯 trailingBreak） */
function composerDocHasVisibleContent(doc: ProseMirrorNode): boolean {
    let found = false;
    doc.descendants((node) => {
        if (node.type.name === "mention") {
            found = true;
            return false;
        }
        if (node.isText) {
            const t = node.text?.replaceAll(COMPOSER_LEADING_ZWSP, "") ?? "";
            if (t.length > 0) {
                found = true;
                return false;
            }
        }
        return undefined;
    });
    return found;
}

function isParagraphContentStart(editor: Editor, pos: number): boolean {
    const $pos = editor.state.doc.resolve(pos);
    return $pos.parent.type.name === "paragraph" && $pos.parentOffset === 0;
}

function focusComposerAtContentStart(editor: Editor): void {
    const {doc} = editor.state;
    let paraPos = -1;
    doc.descendants((node, pos) => {
        if (node.type.name === "paragraph") {
            paraPos = pos;
            return false;
        }
        return undefined;
    });
    if (paraPos < 0) {
        editor.commands.focus();
        return;
    }
    const $pos = doc.resolve(paraPos + 1);
    const sel = TextSelection.near($pos, -1);
    editor.view.dispatch(editor.state.tr.setSelection(sel));
    editor.view.focus();
}

function isClickInEditorHostLeftPadding(host: HTMLElement, event: MouseEvent): boolean {
    const rect = host.getBoundingClientRect();
    const padLeft = parseFloat(getComputedStyle(host).paddingLeft) || 0;
    return event.clientX < rect.left + padLeft;
}

function handleComposerEditorHostMouseDown(
    host: HTMLElement,
    editor: Editor,
    event: MouseEvent,
): void {
    if (event.button !== 0 || !isClickInEditorHostLeftPadding(host, event)) {
        return;
    }
    event.preventDefault();
    focusComposerAtContentStart(editor);
}

function placeCursorBeforeDom(view: EditorView, dom: Node): boolean {
    const rawPos = view.posAtDOM(dom, 0);
    if (rawPos == null) {
        return false;
    }
    const $pos = view.state.doc.resolve(rawPos);
    const sel = TextSelection.near($pos, -1);
    view.dispatch(view.state.tr.setSelection(sel));
    view.focus();
    return true;
}

function handleComposerChipPointerDown(view: EditorView, event: MouseEvent): boolean {
    if (event.button !== 0) {
        return false;
    }
    const chip = (event.target as HTMLElement).closest(".agent-block-ref-chip");
    if (chip) {
        const rect = chip.getBoundingClientRect();
        if (event.clientX > rect.left + 4) {
            return false;
        }
        event.preventDefault();
        return placeCursorBeforeDom(view, chip);
    }
    const para = (event.target as HTMLElement).closest("p");
    const first = para?.firstElementChild;
    if (first?.classList.contains("agent-block-ref-chip")) {
        const rect = first.getBoundingClientRect();
        if (event.clientX <= rect.left + 4) {
            event.preventDefault();
            return placeCursorBeforeDom(view, first);
        }
    }
    return false;
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

/** 空文档时 ProseMirror 的 trailingBreak 会被 Ctrl+A 选中并出现细条高亮 */
function handleComposerSelectAll(editor: Editor, event: KeyboardEvent): boolean {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") {
        return false;
    }
    if (composerDocHasVisibleContent(editor.state.doc)) {
        return false;
    }
    event.preventDefault();
    focusComposerAtContentStart(editor);
    return true;
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
                        const nodes: Array<Record<string, unknown>> = [];
                        if (isParagraphContentStart(ed, range.from)) {
                            nodes.push({type: "text", text: COMPOSER_LEADING_ZWSP});
                        }
                        nodes.push(
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
                        );
                        ed.chain().focus().insertContentAt(range, nodes).run();
                    },
                },
            }),
        ],
        editorProps: {
            attributes: {
                class: "agent-composer__pm",
            },
            handleDOMEvents: {
                mousedown: (view, event) =>
                    handleComposerChipPointerDown(view, event as MouseEvent),
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
                if (handleComposerSelectAll(editor, event)) {
                    return true;
                }
                if (handleSendKey(event, editor, opts.sendKeyMode, opts.onSend, isSuggestionActive)) {
                    return true;
                }
                return false;
            },
        },
    });

    const syncEditorEmptyClass = () => {
        const root = editor.view.dom;
        const empty = !composerDocHasVisibleContent(editor.state.doc);
        root.classList.toggle("is-editor-empty", empty);
        root.style.setProperty("--agent-composer-placeholder", JSON.stringify(placeholderText));
    };
    editor.on("create", syncEditorEmptyClass);
    editor.on("update", syncEditorEmptyClass);
    syncEditorEmptyClass();

    const onEditorHostMouseDown = (event: MouseEvent) => {
        handleComposerEditorHostMouseDown(opts.editorHost, editor, event);
    };
    opts.editorHost.addEventListener("mousedown", onEditorHostMouseDown);

    return {
        focus: () => editor.commands.focus(),
        destroy: () => {
            opts.editorHost.removeEventListener("mousedown", onEditorHostMouseDown);
            editor.destroy();
        },
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
