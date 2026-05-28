import type {Editor, JSONContent} from "@tiptap/core";
import type {Node as ProseMirrorNode} from "@tiptap/pm/model";
import type {EditorView} from "@tiptap/pm/view";

/** Composer 富文本剪贴板（同插件内粘贴可还原块引用芯片） */
export const COMPOSER_CLIPBOARD_MIME = "application/x-agent-composer";

const COMPOSER_LEADING_ZWSP = "\u200b";
const BLOCK_MENTION_IN_TEXT_RE = /@\[((?:[^\]\\]|\\.)*)\]\(siyuan:\/\/blocks\/([^)]+)\)/g;

function unescapeBlockMentionLabel(raw: string): string {
    return raw.replace(/\\([\\\[\]])/g, "$1");
}

function blockMentionMarkdown(label: string, blockId: string): string {
    const escLabel = label.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
    return `@[${escLabel}](siyuan://blocks/${blockId})`;
}

function inlineChildSize(child: ProseMirrorNode): number {
    return child.isText ? (child.text?.length ?? 0) : 1;
}

function inlineRangeToPlain(parent: ProseMirrorNode, start: number, end: number): string {
    let out = "";
    let offset = 0;
    parent.forEach((child) => {
        const childFrom = offset;
        const childTo = offset + inlineChildSize(child);
        const sliceFrom = Math.max(start, childFrom);
        const sliceTo = Math.min(end, childTo);
        if (sliceFrom < sliceTo) {
            if (child.type.name === "mention") {
                const id = String(child.attrs.id ?? "");
                const label = String(child.attrs.label ?? id);
                out += blockMentionMarkdown(label, id);
            } else if (child.isText) {
                out += (child.text ?? "").slice(sliceFrom - childFrom, sliceTo - childFrom);
            } else if (child.type.name === "hardBreak") {
                out += "\n";
            }
        }
        offset = childTo;
    });
    return out;
}

function inlineRangeToJSON(parent: ProseMirrorNode, start: number, end: number): JSONContent[] {
    const out: JSONContent[] = [];
    let offset = 0;
    parent.forEach((child) => {
        const childFrom = offset;
        const childTo = offset + inlineChildSize(child);
        const sliceFrom = Math.max(start, childFrom);
        const sliceTo = Math.min(end, childTo);
        if (sliceFrom < sliceTo) {
            if (child.type.name === "mention") {
                out.push({
                    type: "mention",
                    attrs: {...child.attrs},
                });
            } else if (child.isText) {
                const text = (child.text ?? "").slice(sliceFrom - childFrom, sliceTo - childFrom);
                if (text.length) {
                    out.push({type: "text", text});
                }
            } else if (child.type.name === "hardBreak") {
                out.push({type: "hardBreak"});
            }
        }
        offset = childTo;
    });
    return out;
}

function docRangeToPlainText(doc: ProseMirrorNode, from: number, to: number): string {
    const parts: string[] = [];
    doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name !== "paragraph") {
            return;
        }
        const innerFrom = Math.max(from, pos + 1);
        const innerTo = Math.min(to, pos + node.nodeSize - 1);
        if (innerFrom < innerTo) {
            parts.push(inlineRangeToPlain(node, innerFrom - pos - 1, innerTo - pos - 1));
        }
    });
    if (!parts.length) {
        const $from = doc.resolve(from);
        if ($from.parent.type.name === "paragraph") {
            parts.push(inlineRangeToPlain(
                $from.parent,
                from - $from.start() - 1,
                to - $from.start() - 1,
            ));
        }
    }
    return parts.join("\n");
}

function docRangeToJSON(doc: ProseMirrorNode, from: number, to: number): JSONContent {
    const paragraphs: JSONContent[] = [];
    doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name !== "paragraph") {
            return;
        }
        const innerFrom = Math.max(from, pos + 1);
        const innerTo = Math.min(to, pos + node.nodeSize - 1);
        if (innerFrom < innerTo) {
            paragraphs.push({
                type: "paragraph",
                content: inlineRangeToJSON(node, innerFrom - pos - 1, innerTo - pos - 1),
            });
        }
    });
    if (!paragraphs.length) {
        const $from = doc.resolve(from);
        if ($from.parent.type.name === "paragraph") {
            paragraphs.push({
                type: "paragraph",
                content: inlineRangeToJSON(
                    $from.parent,
                    from - $from.start() - 1,
                    to - $from.start() - 1,
                ),
            });
        }
    }
    return {
        type: "doc",
        content: paragraphs.length ? paragraphs : [{type: "paragraph"}],
    };
}

function parseInlineLine(line: string): JSONContent[] {
    const nodes: JSONContent[] = [];
    let last = 0;
    const re = new RegExp(BLOCK_MENTION_IN_TEXT_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
        if (m.index > last) {
            nodes.push({type: "text", text: line.slice(last, m.index)});
        }
        nodes.push({
            type: "mention",
            attrs: {
                id: m[2],
                label: unescapeBlockMentionLabel(m[1]),
                blockType: "NodeDocument",
                blockSubtype: null,
            },
        });
        last = m.index + m[0].length;
    }
    if (last < line.length) {
        nodes.push({type: "text", text: line.slice(last)});
    }
    return nodes;
}

function splitPlainTextLines(text: string): string[] {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines;
}

/** 剪贴板 doc JSON / 纯文本 → 插入光标处的内容（避免 insert 整段 doc 产生额外段落） */
function clipboardPayloadToInsertContent(payload: JSONContent | string): JSONContent | JSONContent[] {
    if (typeof payload === "string") {
        const lines = splitPlainTextLines(payload);
        if (lines.length === 0) {
            return [];
        }
        if (lines.length === 1) {
            return parseInlineLine(lines[0]);
        }
        const merged: JSONContent[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (i > 0) {
                merged.push({type: "hardBreak"});
            }
            merged.push(...parseInlineLine(lines[i]));
        }
        return merged;
    }
    if (payload.type !== "doc" || !Array.isArray(payload.content)) {
        return payload;
    }
    const paragraphs = payload.content.filter(
        (n): n is JSONContent & {type: "paragraph"} =>
            n.type === "paragraph" && Array.isArray(n.content) && n.content.length > 0,
    );
    if (!paragraphs.length) {
        const emptyParas = payload.content.filter((n) => n.type === "paragraph");
        if (emptyParas.length === 1) {
            return [];
        }
        return payload;
    }
    if (paragraphs.length === 1) {
        return paragraphs[0].content ?? [];
    }
    const merged: JSONContent[] = [];
    for (let i = 0; i < paragraphs.length; i++) {
        if (i > 0) {
            merged.push({type: "hardBreak"});
        }
        merged.push(...(paragraphs[i].content ?? []));
    }
    return merged;
}

function plainTextHasBlockMentions(text: string): boolean {
    return text.includes("@[") && text.includes("siyuan://blocks/");
}

export function handleComposerCopy(view: EditorView, event: ClipboardEvent): boolean {
    const {state} = view;
    if (state.selection.empty || !event.clipboardData) {
        return false;
    }
    const {from, to} = state.selection;
    const plain = docRangeToPlainText(state.doc, from, to);
    const json = docRangeToJSON(state.doc, from, to);
    event.clipboardData.setData("text/plain", plain);
    event.clipboardData.setData(COMPOSER_CLIPBOARD_MIME, JSON.stringify(json));
    event.preventDefault();
    return true;
}

export function handleComposerPaste(editor: Editor, event: ClipboardEvent): boolean {
    const data = event.clipboardData;
    if (!data) {
        return false;
    }
    const custom = data.getData(COMPOSER_CLIPBOARD_MIME);
    if (custom) {
        try {
            const json = JSON.parse(custom) as JSONContent;
            const insertContent = clipboardPayloadToInsertContent(json);
            if (Array.isArray(insertContent) && !insertContent.length) {
                return false;
            }
            editor.chain().focus().insertContent(insertContent).run();
            event.preventDefault();
            return true;
        } catch {
            // 降级为纯文本解析
        }
    }
    const plain = data.getData("text/plain");
    if (plain && plainTextHasBlockMentions(plain)) {
        const insertContent = clipboardPayloadToInsertContent(plain);
        if (Array.isArray(insertContent) && !insertContent.length) {
            return false;
        }
        editor.chain().focus().insertContent(insertContent).run();
        event.preventDefault();
        return true;
    }
    return false;
}
