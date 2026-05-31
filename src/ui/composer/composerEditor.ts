import {Editor, type JSONContent} from "@tiptap/core";
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
import {
    blockMentionWireMarkdown,
    composerDocToLlmText,
    plainTextToComposerDoc,
} from "./blockMentionText";
import {handleComposerCopy, handleComposerPaste} from "./composerClipboard";

export interface ComposerEditorHandle {
    focus: () => void;
    destroy: () => void;
    /** 发送给 Agent 的纯文本（块引用为无 `@` 的 Markdown 链接） */
    getSendText: () => string;
    getDocumentJSON: () => JSONContent;
    hasVisibleContent: () => boolean;
    clear: () => void;
    setSendText: (text: string) => void;
    setDocumentJSON: (json: JSONContent | null | undefined) => void;
    isSuggestionActive: () => boolean;
}

export interface MountComposerEditorOptions {
    editorHost: HTMLElement;
    app: App;
    kernel: KernelExecutor;
    placeholder?: string;
    sendKeyMode: SendKeyMode;
    onSend: () => void;
    /** 内容变化时回调（用于持久化草稿） */
    onDraftChange?: () => void;
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

/** 将编辑器文档序列化为发送给 Agent 的纯文本（mention → `[label](siyuan://blocks/id)`） */
export function serializeComposerSendText(editor: Editor): string {
    const zwspStripped: JSONContent = JSON.parse(JSON.stringify(editor.getJSON()));
    const stripZwsp = (nodes: JSONContent[] | undefined) => {
        if (!nodes) {
            return;
        }
        for (const n of nodes) {
            if (n.type === "text" && typeof n.text === "string") {
                n.text = n.text.replaceAll(COMPOSER_LEADING_ZWSP, "");
            }
            stripZwsp(n.content);
        }
    };
    stripZwsp(zwspStripped.content);
    return composerDocToLlmText(zwspStripped);
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

function getHostContentInsets(host: HTMLElement): {left: number; right: number; top: number; bottom: number} {
    const style = getComputedStyle(host);
    return {
        left: parseFloat(style.paddingLeft) || 0,
        right: parseFloat(style.paddingRight) || 0,
        top: parseFloat(style.paddingTop) || 0,
        bottom: parseFloat(style.paddingBottom) || 0,
    };
}

/** 行尾空白处 posAtCoords 常会落到行首；仅在需要靠右落点时纠正 */
function resolveComposerPosWithHorizontalBias(
    doc: Editor["state"]["doc"],
    $pos: ReturnType<typeof doc.resolve>,
    bias: "end" | null,
): ReturnType<typeof doc.resolve> {
    if (bias !== "end" || $pos.parent.type.name !== "paragraph") {
        return $pos;
    }
    const lineStart = $pos.start();
    const lineEnd = lineStart + $pos.parent.content.size;
    if ($pos.parent.content.size > 0 && $pos.pos <= lineStart) {
        return doc.resolve(lineEnd);
    }
    return $pos;
}

function focusComposerAtCoords(
    editor: Editor,
    clientX: number,
    clientY: number,
    opts?: {horizontalBias?: "end" | null},
): void {
    const view = editor.view;
    const contentRect = view.dom.getBoundingClientRect();
    const x = Math.max(contentRect.left + 1, Math.min(contentRect.right - 1, clientX));
    const y = Math.max(contentRect.top + 1, Math.min(contentRect.bottom - 1, clientY));
    const hit = view.posAtCoords({left: x, top: y});
    if (hit) {
        let $pos = view.state.doc.resolve(hit.pos);
        const beforeBias = $pos.pos;
        $pos = resolveComposerPosWithHorizontalBias(view.state.doc, $pos, opts?.horizontalBias ?? null);
        const selBias =
            $pos.pos !== beforeBias ? -1 : hit.inside === -1 ? -1 : 1;
        const sel = TextSelection.near($pos, selBias);
        view.dispatch(view.state.tr.setSelection(sel));
        view.focus();
        return;
    }
    focusComposerAtContentStart(editor);
}

/** 点击 host 内边距：将坐标钳到内容区边缘，再按点击位置落光标 */
function focusComposerAtHostClick(
    editor: Editor,
    host: HTMLElement,
    clientX: number,
    clientY: number,
): void {
    const hostRect = host.getBoundingClientRect();
    const insets = getHostContentInsets(host);
    const contentLeft = hostRect.left + insets.left;
    const contentRight = hostRect.right - insets.right;
    const contentTop = hostRect.top + insets.top;
    const contentBottom = hostRect.bottom - insets.bottom;

    let x = clientX;
    let y = clientY;
    let horizontalBias: "end" | null = null;

    if (clientX < contentLeft) {
        x = contentLeft + 1;
    } else if (clientX > contentRight) {
        x = contentRight - 1;
        horizontalBias = "end";
    }
    if (clientY < contentTop) {
        y = contentTop + 1;
    } else if (clientY > contentBottom) {
        y = contentBottom - 1;
    }

    focusComposerAtCoords(editor, x, y, {horizontalBias});
}

/** 点击 agent-composer__editor 内边距时，将光标落到靠近点击位置 */
function handleComposerEditorHostMouseDown(
    host: HTMLElement,
    editor: Editor,
    event: MouseEvent,
): void {
    if (event.button !== 0) {
        return;
    }
    const view = editor.view;
    const target = event.target as HTMLElement;
    if (target !== host && view.dom.contains(target)) {
        return;
    }
    const hostRect = host.getBoundingClientRect();
    if (
        event.clientX < hostRect.left
        || event.clientX > hostRect.right
        || event.clientY < hostRect.top
        || event.clientY > hostRect.bottom
    ) {
        return;
    }

    event.preventDefault();
    focusComposerAtHostClick(editor, host, event.clientX, event.clientY);
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
                    blockMentionWireMarkdown(
                        blockRefDisplayLabel(node.attrs),
                        String(node.attrs.id ?? ""),
                    ),
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
                copy: (view, event) => handleComposerCopy(view, event as ClipboardEvent),
                paste: (_view, event) => handleComposerPaste(editor, event as ClipboardEvent),
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
    const notifyDraftChange = () => {
        opts.onDraftChange?.();
    };

    editor.on("create", () => {
        syncEditorEmptyClass();
        notifyDraftChange();
    });
    editor.on("update", () => {
        syncEditorEmptyClass();
        notifyDraftChange();
    });
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
        getDocumentJSON: () => editor.getJSON(),
        hasVisibleContent: () => composerDocHasVisibleContent(editor.state.doc),
        clear: () => editor.commands.clearContent(),
        setSendText: (text: string) => {
            editor.commands.setContent(plainTextToComposerDoc(text));
        },
        setDocumentJSON: (json) => {
            if (!json || json.type !== "doc") {
                editor.commands.clearContent();
            } else {
                editor.commands.setContent(json);
            }
            syncEditorEmptyClass();
        },
        isSuggestionActive,
    };
}
