import {isToolName, type ToolName} from "../../agent/types";
import {getToolByName} from "../../tools/registry";

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

/** 内置工具字段中文标签（覆盖 catalog description） */
const FIELD_LABEL_OVERRIDES: Partial<Record<ToolName, Record<string, string>>> = {
    read_markdown: {
        id: "块 / 文档 ID",
        start_line: "起始行",
        end_line: "结束行",
    },
    read_kramdown: {id: "块 ID", mode: "模式"},
    search_blocks: {
        query: "查询",
        page: "页码",
        pageSize: "每页条数",
        method: "搜索方式",
    },
    list_child_blocks: {parent_id: "父块 ID", limit: "条数上限"},
    get_doc_outline: {id: "文档根块 ID"},
    get_backlinks: {
        id: "块 / 文档 ID",
        keyword: "关键词",
        contain_children: "含子块",
    },
    get_block_attributes: {id: "块 ID"},
    get_recent_docs: {limit: "条数"},
    list_documents: {
        notebook_id: "笔记本 ID",
        path: "路径前缀",
        page: "页码",
        page_size: "每页条数",
    },
    open_document: {id: "块 / 文档 ID", highlight: "高亮"},
    focus_block: {id: "块 / 文档 ID"},
    create_document: {
        notebook_id: "笔记本 ID",
        path: "文档路径",
        markdown: "正文 Markdown",
    },
    edit_document: {doc_id: "文档 ID", new_markdown: "新正文"},
    sql_query: {stmt: "SQL"},
    append_markdown: {parent_id: "父块 ID", markdown: "Markdown"},
    insert_markdown: {
        markdown: "Markdown",
        parent_id: "父块 ID",
        previous_id: "上一块 ID",
        next_id: "下一块 ID",
    },
    update_markdown: {id: "块 ID", markdown: "Markdown"},
    edit_block_kramdown: {id: "块 ID", kramdown: "Kramdown"},
    batch_update_markdown: {updates: "批量更新"},
    batch_insert_markdown: {inserts: "批量插入"},
    batch_append_markdown: {appends: "批量追加"},
    batch_delete_blocks: {ids: "块 ID 列表"},
};

function fieldLabelFromSchema(
    toolName: string,
    key: string,
    overrides: Record<string, string> | undefined,
): string {
    if (overrides?.[key]) {
        return overrides[key]!;
    }
    const def = getToolByName(toolName);
    const props = (def?.parameters as {properties?: Record<string, {description?: string}>} | undefined)
        ?.properties;
    const desc = props?.[key]?.description;
    if (desc) {
        const head = desc.split(/[（(]/)[0]!.trim();
        if (head) {
            return head;
        }
    }
    return key;
}

function schemaPropertyKeys(toolName: string): string[] {
    const def = getToolByName(toolName);
    const props = (def?.parameters as {properties?: Record<string, unknown>} | undefined)?.properties;
    return props ? Object.keys(props) : [];
}

function mergeFieldLabels(toolName: string): Record<string, string> | undefined {
    const schemaKeys = schemaPropertyKeys(toolName);
    const overrides = isToolName(toolName) ? FIELD_LABEL_OVERRIDES[toolName] : undefined;
    if (schemaKeys.length === 0 && !overrides) {
        return undefined;
    }
    const labels: Record<string, string> = {};
    for (const key of schemaKeys) {
        labels[key] = fieldLabelFromSchema(toolName, key, overrides);
    }
    if (overrides) {
        for (const [key, label] of Object.entries(overrides)) {
            labels[key] = label;
        }
    }
    return labels;
}

function orderFieldKeys(schemaKeys: string[], discovered: string[]): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const key of schemaKeys) {
        if (discovered.includes(key) && !seen.has(key)) {
            seen.add(key);
            ordered.push(key);
        }
    }
    for (const key of discovered) {
        if (!seen.has(key)) {
            seen.add(key);
            ordered.push(key);
        }
    }
    return ordered;
}

/** 从不完整 JSON 中发现已出现的顶层字段名（按出现顺序） */
function discoverPartialJsonKeys(src: string): string[] {
    const keys: string[] = [];
    const seen = new Set<string>();
    const re = /"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const key = m[1]!;
        if (!seen.has(key)) {
            seen.add(key);
            keys.push(key);
        }
    }
    return keys;
}

function skipWs(src: string, i: number): number {
    while (i < src.length && /\s/.test(src[i]!)) {
        i++;
    }
    return i;
}

/** 从不完整 JSON 中提取字符串字段（支持流式未闭合引号） */
function extractPartialJsonStringAt(src: string, startQuote: number): {value: string; closed: boolean} {
    let i = startQuote + 1;
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

function extractPartialContainer(
    src: string,
    start: number,
    open: "[" | "{",
): {value: string; closed: boolean} {
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < src.length; i++) {
        const c = src[i]!;
        if (inStr) {
            if (escaped) {
                escaped = false;
            } else if (c === "\\") {
                escaped = true;
            } else if (c === '"') {
                inStr = false;
            }
            continue;
        }
        if (c === '"') {
            inStr = true;
            continue;
        }
        if (c === open) {
            depth++;
        } else if (c === close) {
            depth--;
            if (depth === 0) {
                return {value: src.slice(start, i + 1), closed: true};
            }
        }
    }
    return {value: src.slice(start), closed: false};
}

/** 从不完整 JSON 中提取任意类型顶层字段值 */
function extractPartialJsonValue(src: string, key: string): {value: string; closed: boolean} | null {
    const needle = `"${key}"`;
    const idx = src.indexOf(needle);
    if (idx < 0) {
        return null;
    }
    let i = idx + needle.length;
    i = skipWs(src, i);
    if (src[i] !== ":") {
        return null;
    }
    i++;
    i = skipWs(src, i);
    if (i >= src.length) {
        return null;
    }
    const c = src[i]!;
    if (c === "\"") {
        return extractPartialJsonStringAt(src, i);
    }
    if (c === "[" || c === "{") {
        return extractPartialContainer(src, i, c);
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

function tryParseComplete(raw: string): boolean {
    if (!raw) {
        return false;
    }
    if (!raw.endsWith("}") && !raw.endsWith("]") && raw.length >= 256) {
        return false;
    }
    try {
        JSON.parse(raw);
        return true;
    } catch {
        return false;
    }
}

function fieldsFromCompleteJson(
    raw: string,
    labels: Record<string, string> | undefined,
): ToolCallPreviewField[] {
    try {
        const o = JSON.parse(raw) as Record<string, unknown>;
        return Object.entries(o).map(([key, val]) => ({
            label: labels?.[key] ?? key,
            value: typeof val === "string" ? val : JSON.stringify(val, null, 2),
        }));
    } catch {
        return [];
    }
}

/** 流式解析 tool arguments JSON，渲染为可读字段（不执行） */
export function buildToolCallStreamPreview(toolName: string, argsJson: string): ToolCallStreamPreview {
    const raw = argsJson?.trim() ?? "";
    const parseComplete = tryParseComplete(raw);
    const labels = mergeFieldLabels(toolName);
    const schemaKeys = schemaPropertyKeys(toolName);
    const discovered = discoverPartialJsonKeys(raw);

    if (parseComplete) {
        const complete = fieldsFromCompleteJson(raw, labels);
        if (complete.length > 0) {
            return {fields: complete, parseComplete: true};
        }
    }

    const fields: ToolCallPreviewField[] = [];
    const keys = orderFieldKeys(schemaKeys, discovered);

    for (const key of keys) {
        const partial = extractPartialJsonValue(raw, key);
        if (!partial) {
            continue;
        }
        fields.push({
            label: labels?.[key] ?? key,
            value: partial.value,
            streaming: !partial.closed,
        });
    }

    if (parseComplete && fields.length === 0) {
        return {fields: fieldsFromCompleteJson(raw, labels), parseComplete: true};
    }

    return {fields, parseComplete};
}
