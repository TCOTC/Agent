import {isToolName, type ToolName} from "../../agent/types";

export interface ToolCallPreviewField {
    label: string;
    value: string;
    /** 该字段字符串尚未闭合，仍在流式输出 */
    streaming?: boolean;
}

export interface ToolCallStreamPreview {
    fields: ToolCallPreviewField[];
    parseComplete: boolean;
}

const FIELD_LABELS: Partial<Record<ToolName, Record<string, string>>> = {
create_document: {
        notebook_id: "笔记本 ID",
        path: "文档路径",
        markdown: "正文 Markdown",
    },
edit_document: {
        doc_id: "文档 ID",
        new_markdown: "新正文",
    },
read_markdown: {
        id: "块 / 文档 ID",
        start_line: "起始行",
        end_line: "结束行",
    },
open_document: {
        id: "块 / 文档 ID",
        highlight: "高亮",
    },
delete_block: {id: "块 ID"},
delete_document: {id: "文档根块 ID"},
rename_document: {id: "文档根块 ID", title: "新标题"},
sql_query: {stmt: "SQL"},
append_markdown: {
        parent_id: "父块 ID",
        markdown: "Markdown",
    },
insert_markdown: {
        markdown: "Markdown",
        parent_id: "父块 ID",
        previous_id: "上一块 ID",
        next_id: "下一块 ID",
    },
update_markdown: {
        id: "块 ID",
        markdown: "Markdown",
    },
edit_block_kramdown: {
        id: "块 ID",
        kramdown: "Kramdown",
    },
batch_update_markdown: {
        updates: "批量更新",
    },
batch_insert_markdown: {
        inserts: "批量插入",
    },
batch_append_markdown: {
        appends: "批量追加",
    },
batch_delete_blocks: {
        ids: "块 ID 列表",
    },
};

/** 从不完整 JSON 中提取字符串字段（支持流式未闭合引号） */
function extractPartialJsonString(src: string, key: string): {value: string; closed: boolean} | null {
    const needle = `"${key}"`;
    const idx = src.indexOf(needle);
    if (idx < 0) {
        return null;
    }
    let i = idx + needle.length;
    while (i < src.length && /\s/.test(src[i]!)) {
        i++;
    }
    if (src[i] !== ":") {
        return null;
    }
    i++;
    while (i < src.length && /\s/.test(src[i]!)) {
        i++;
    }
    if (src[i] !== "\"") {
        return null;
    }
    i++;
    let value = "";
    let escaped = false;
    while (i < src.length) {
        const c = src[i]!;
        if (escaped) {
            if (c === "n") {
                value += "\n";
            } else if (c === "t") {
                value += "\t";
            } else if (c === "r") {
                value += "\r";
            } else {
                value += c;
            }
            escaped = false;
        } else if (c === "\\") {
            escaped = true;
        } else if (c === "\"") {
            return {value, closed: true};
        } else {
            value += c;
        }
        i++;
    }
    return {value, closed: false};
}

function extractPartialScalar(src: string, key: string): {value: string; closed: boolean} | null {
    const needle = `"${key}"`;
    const idx = src.indexOf(needle);
    if (idx < 0) {
        return null;
    }
    let i = idx + needle.length;
    while (i < src.length && /\s/.test(src[i]!)) {
        i++;
    }
    if (src[i] !== ":") {
        return null;
    }
    i++;
    while (i < src.length && /\s/.test(src[i]!)) {
        i++;
    }
    const rest = src.slice(i);
    const m = rest.match(/^(true|false|null|-?\d+(?:\.\d+)?)/);
    if (!m) {
        return null;
    }
    const tail = rest.slice(m[0].length);
    const closed = /^[\s,\}]/.test(tail) || tail.length === 0;
    return {value: m[1]!, closed};
}

/** 流式解析 tool arguments JSON，渲染为可读字段（不执行） */
export function buildToolCallStreamPreview(toolName: string, argsJson: string): ToolCallStreamPreview {
    const raw = argsJson?.trim() ?? "";
    let parseComplete = false;
    // 大参数流式阶段避免每帧 JSON.parse 整段字符串
    if (raw && (raw.endsWith("}") || raw.length < 256)) {
        try {
            JSON.parse(raw);
            parseComplete = true;
        } catch {
            parseComplete = false;
        }
    }

    const fields: ToolCallPreviewField[] = [];
    const labels = isToolName(toolName) ? FIELD_LABELS[toolName] : undefined;

    if (labels) {
        for (const [key, label] of Object.entries(labels)) {
            const str = extractPartialJsonString(raw, key);
            if (str) {
                fields.push({
                    label,
                    value: str.value,
                    streaming: !str.closed,
                });
                continue;
            }
            const scalar = extractPartialScalar(raw, key);
            if (scalar) {
                fields.push({label, value: scalar.value, streaming: !scalar.closed});
            }
        }
    }

    if (parseComplete && fields.length === 0) {
        try {
            const o = JSON.parse(raw) as Record<string, unknown>;
            for (const [key, val] of Object.entries(o)) {
                const text = typeof val === "string" ? val : JSON.stringify(val);
                fields.push({
                    label: key,
                    value: text,
                });
            }
        } catch {
            /* ignore */
        }
    }

    return {fields, parseComplete};
}
