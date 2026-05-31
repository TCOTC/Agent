import type {JSONContent} from "@tiptap/core";

/** 块引用 wire 文本（剪贴板 / 内部交换）：`@[label](siyuan://blocks/id)` */
export const BLOCK_MENTION_WIRE_RE = /@\[((?:[^\]\\]|\\.)*)\]\(siyuan:\/\/blocks\/([^)]+)\)/g;

/** 块引用 LLM Markdown（无 leading `@`）：`[label](siyuan://blocks/id)` */
export const BLOCK_MENTION_LLM_RE = /\[((?:[^\]\\]|\\.)*)\]\(siyuan:\/\/blocks\/([^)]+)\)/g;

/** Composer 内联 / 历史正文中的 wire 与 LLM 块引用 */
export const BLOCK_MENTION_INLINE_RE = /(?:@)?\[((?:[^\]\\]|\\.)*)\]\(siyuan:\/\/blocks\/([^)]+)\)/g;

export function escapeBlockMentionLabel(label: string): string {
    return label.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export function unescapeBlockMentionLabel(raw: string): string {
    return raw.replace(/\\([\\\[\]])/g, "$1");
}

/** 发送给 Agent / LLM 的 Markdown 块引用 */
export function blockMentionLlmMarkdown(label: string, blockId: string): string {
    const escLabel = escapeBlockMentionLabel(label);
    return `[${escLabel}](siyuan://blocks/${blockId})`;
}

/** 剪贴板与 Composer 内 plain 复制的 wire 格式 */
export function blockMentionWireMarkdown(label: string, blockId: string): string {
    return `@${blockMentionLlmMarkdown(label, blockId)}`;
}

/** 将已存储用户正文中的 wire / LLM 块引用统一为 LLM 格式 */
export function userContentToLlmMarkdown(content: string): string {
    let out = content.replace(BLOCK_MENTION_WIRE_RE, (_m, rawLabel: string, blockId: string) =>
        blockMentionLlmMarkdown(unescapeBlockMentionLabel(rawLabel), blockId),
    );
    // 已是 LLM 格式的保持不变
    return out;
}

function parseInlineLineToNodes(line: string): JSONContent[] {
    const nodes: JSONContent[] = [];
    let last = 0;
    const re = new RegExp(BLOCK_MENTION_INLINE_RE.source, "g");
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

/** 从纯文本（含 wire 块引用）构建 TipTap 文档 JSON */
export function plainTextToComposerDoc(text: string): JSONContent {
    const lines = splitPlainTextLines(text);
    if (!lines.length) {
        return {type: "doc", content: [{type: "paragraph"}]};
    }
    return {
        type: "doc",
        content: lines.map((line) => ({
            type: "paragraph",
            content: line ? parseInlineLineToNodes(line) : [],
        })),
    };
}

function inlineNodesToLlmText(nodes: JSONContent[]): string {
    let out = "";
    for (const child of nodes) {
        if (child.type === "mention" && child.attrs) {
            const id = String(child.attrs.id ?? "");
            const label = String(child.attrs.label ?? id);
            out += blockMentionLlmMarkdown(label, id);
        } else if (child.type === "text") {
            out += child.text ?? "";
        } else if (child.type === "hardBreak") {
            out += "\n";
        }
    }
    return out;
}

/** TipTap 文档 JSON → 发送给 Agent 的纯文本 */
export function composerDocToLlmText(doc: JSONContent): string {
    if (doc.type !== "doc" || !Array.isArray(doc.content)) {
        return "";
    }
    const parts: string[] = [];
    for (const para of doc.content) {
        if (para.type === "paragraph" && Array.isArray(para.content)) {
            parts.push(inlineNodesToLlmText(para.content));
        }
    }
    return parts.join("\n").trim();
}

/** TipTap 文档 JSON → 会话标题等用的纯文本（块引用仅保留 label） */
export function composerDocToPlainText(doc: JSONContent): string {
    if (doc.type !== "doc" || !Array.isArray(doc.content)) {
        return "";
    }
    const parts: string[] = [];
    for (const para of doc.content) {
        if (para.type !== "paragraph" || !Array.isArray(para.content)) {
            continue;
        }
        let line = "";
        for (const child of para.content) {
            if (child.type === "mention" && child.attrs) {
                const label = String(child.attrs.label ?? child.attrs.id ?? "").trim();
                line += label || String(child.attrs.id ?? "");
            } else if (child.type === "text") {
                line += child.text ?? "";
            } else if (child.type === "hardBreak") {
                line += "\n";
            }
        }
        parts.push(line);
    }
    return parts.join("\n").trim();
}

/** 历史消息仅有 content 时，解析为可编辑的 Composer 文档 */
export function legacyUserContentToComposerDoc(content: string): JSONContent {
    return plainTextToComposerDoc(content);
}
