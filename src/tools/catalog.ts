import type {ToolDefinition} from "../agent/types";

const obj = (
    props: Record<string, unknown>,
    required: string[] = [],
): Record<string, unknown> => ({
    type: "object",
    properties: props,
    required,
    additionalProperties: false,
});

export const READ_TOOLS: ToolDefinition[] = [
    {
        name: "siyuan_get_block_info",
        description: "获取块或文档元数据：box、path、rootID、rootTitle。",
        parameters: obj({id: {type: "string"}}, ["id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "siyuan_read_markdown",
        description: "导出文档 Markdown。可选 start_line/end_line（1-based）截取行范围。",
        parameters: obj({
            id: {type: "string", description: "文档根块 ID"},
            start_line: {type: "integer"},
            end_line: {type: "integer"},
        }, ["id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "siyuan_read_kramdown",
        description: "读取单块 Kramdown（含块 ID IAL），用于精确编辑。",
        parameters: obj({
            id: {type: "string"},
            mode: {type: "string", enum: ["md", "textmark"]},
        }, ["id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "siyuan_search_blocks",
        description: "全文搜索块。method：0 关键字、1 查询语法、3 正则。",
        parameters: obj({
            query: {type: "string"},
            page: {type: "integer", default: 1},
            pageSize: {type: "integer", default: 16},
            method: {type: "integer", default: 0},
        }, ["query"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "siyuan_list_child_blocks",
        description: "列出父块直接子块 id、type、content 摘要。",
        parameters: obj({
            parent_id: {type: "string"},
            limit: {type: "integer", default: 32},
        }, ["parent_id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "siyuan_get_doc_outline",
        description: "获取文档大纲树（标题层级与块 ID）。",
        parameters: obj({id: {type: "string", description: "文档根块 ID"}}, ["id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "siyuan_get_backlinks",
        description: "获取块或文档的反向链接与提及。",
        parameters: obj({
            id: {type: "string"},
            keyword: {type: "string", description: "过滤关键词 k"},
            contain_children: {type: "boolean"},
        }, ["id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "siyuan_get_block_attributes",
        description: "读取块属性（name、alias、memo、custom-* 等）。",
        parameters: obj({id: {type: "string"}}, ["id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "siyuan_get_recent_docs",
        description: "列出最近更新的文档（SQL 只读查询结果）。",
        parameters: obj({limit: {type: "integer", default: 20}}),
        risk: "read",
        source: "builtin",
    },
];

export const STRUCTURE_TOOLS: ToolDefinition[] = [
    {
        name: "siyuan_list_notebooks",
        description: "列出所有笔记本 id 与名称。",
        parameters: obj({}),
        risk: "read",
        source: "builtin",
    },
    {
        name: "siyuan_list_documents",
        description: "列出笔记本下文档路径（分页）。",
        parameters: obj({
            notebook_id: {type: "string"},
            path: {type: "string", description: "路径前缀，默认 /"},
            page: {type: "integer", default: 1},
            page_size: {type: "integer", default: 32},
        }, ["notebook_id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "siyuan_sql_query",
        description: "只读 SQL（SELECT/WITH/EXPLAIN/VALUES）。",
        parameters: obj({stmt: {type: "string"}}, ["stmt"]),
        risk: "sql",
        alwaysConfirm: true,
        source: "builtin",
    },
];

export const UI_TOOLS: ToolDefinition[] = [
    {
        name: "siyuan_open_document",
        description: "在编辑器打开文档/块；highlight=true 时高亮聚焦。",
        parameters: obj({
            id: {type: "string"},
            highlight: {type: "boolean", default: false},
        }, ["id"]),
        risk: "ui",
        source: "builtin",
    },
    {
        name: "siyuan_focus_block",
        description: "滚动并高亮到块。",
        parameters: obj({id: {type: "string"}}, ["id"]),
        risk: "ui",
        source: "builtin",
    },
];

export const WRITE_TOOLS: ToolDefinition[] = [
    {
        name: "siyuan_append_markdown",
        description: "在父块末尾追加 Markdown 子块。",
        parameters: obj({parent_id: {type: "string"}, markdown: {type: "string"}}, ["parent_id", "markdown"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "siyuan_insert_markdown",
        description: "插入 Markdown。锚点 parent_id / previous_id / next_id 三选一。",
        parameters: obj({
            markdown: {type: "string"},
            parent_id: {type: "string"},
            previous_id: {type: "string"},
            next_id: {type: "string"},
        }, ["markdown"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "siyuan_update_markdown",
        description: "用 Markdown 更新单块（简单文本）。",
        parameters: obj({id: {type: "string"}, markdown: {type: "string"}}, ["id", "markdown"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "siyuan_edit_block_kramdown",
        description: "Kramdown 更新单块，须保留 {: id=\"...\"} IAL。",
        parameters: obj({id: {type: "string"}, kramdown: {type: "string"}}, ["id", "kramdown"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "siyuan_move_block",
        description: "移动块到 parent_id 或 previous_id 之后。",
        parameters: obj({
            id: {type: "string"},
            parent_id: {type: "string"},
            previous_id: {type: "string"},
        }, ["id"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "siyuan_set_block_attributes",
        description: "设置块属性键值对。",
        parameters: obj({
            id: {type: "string"},
            attrs: {type: "object", description: "如 { name: \"标题\", alias: \"别名\" }"},
        }, ["id", "attrs"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "siyuan_create_document",
        description: "在笔记本下创建新文档（Markdown）。",
        parameters: obj({
            notebook_id: {type: "string"},
            path: {type: "string", description: "如 /folder/title"},
            markdown: {type: "string"},
        }, ["notebook_id", "path"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "siyuan_rename_document",
        description: "重命名文档（修改标题块或路径）。",
        parameters: obj({
            id: {type: "string", description: "文档根块 ID"},
            title: {type: "string"},
        }, ["id", "title"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "siyuan_propose_document_edit",
        description:
            "提交文档完整 Markdown 改写方案，生成 diff 预览 ID（不立即写入）。大段改写必须先调用此工具。",
        parameters: obj({
            doc_id: {type: "string"},
            new_markdown: {type: "string"},
        }, ["doc_id", "new_markdown"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "siyuan_apply_document_edit",
        description: "应用 propose 返回的 edit_id，将新 Markdown 写入文档（替换文档内容）。",
        parameters: obj({edit_id: {type: "string"}}, ["edit_id"]),
        risk: "write",
        alwaysConfirm: true,
        source: "builtin",
    },
    {
        name: "siyuan_delete_block",
        description: "删除块（高风险，需确认）。",
        parameters: obj({id: {type: "string"}}, ["id"]),
        risk: "delete",
        alwaysConfirm: true,
        source: "builtin",
    },
];

export function allToolDefinitions(): ToolDefinition[] {
    return [...READ_TOOLS, ...STRUCTURE_TOOLS, ...UI_TOOLS, ...WRITE_TOOLS];
}
