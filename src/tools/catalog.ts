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
        name: "get_block_info",
        description: "获取块或文档元数据：box、path、rootID、rootTitle。",
        parameters: obj({id: {type: "string"}}, ["id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "read_markdown",
        description: "导出文档正文 Markdown（不含文档标题行）。可选 start_line/end_line（1-based）截取行范围。",
        parameters: obj({
            id: {type: "string", description: "文档根块 ID"},
            start_line: {type: "integer"},
            end_line: {type: "integer"},
        }, ["id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "read_kramdown",
        description: "读取单块 Kramdown（含块 ID IAL），用于精确编辑。",
        parameters: obj({
            id: {type: "string"},
            mode: {type: "string", enum: ["md", "textmark"]},
        }, ["id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "search_blocks",
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
        name: "list_child_blocks",
        description: "列出父块直接子块 id、type、content 摘要。",
        parameters: obj({
            parent_id: {type: "string"},
            limit: {type: "integer", default: 32},
        }, ["parent_id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "get_doc_outline",
        description: "获取文档大纲树（标题层级与块 ID）。",
        parameters: obj({id: {type: "string", description: "文档根块 ID"}}, ["id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "get_backlinks",
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
        name: "get_block_attributes",
        description: "读取块属性（name、alias、memo、custom-* 等）。",
        parameters: obj({id: {type: "string"}}, ["id"]),
        risk: "read",
        source: "builtin",
    },
    {
        name: "get_recent_docs",
        description: "列出最近更新的文档（SQL 只读查询结果）。",
        parameters: obj({limit: {type: "integer", default: 20}}),
        risk: "read",
        source: "builtin",
    },
];

export const STRUCTURE_TOOLS: ToolDefinition[] = [
    {
        name: "list_notebooks",
        description: "列出所有笔记本 id 与名称。",
        parameters: obj({}),
        risk: "read",
        source: "builtin",
    },
    {
        name: "list_documents",
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
        name: "sql_query",
        description: "只读 SQL（SELECT/WITH/EXPLAIN/VALUES）。",
        parameters: obj({stmt: {type: "string"}}, ["stmt"]),
        risk: "sql",
        alwaysConfirm: true,
        source: "builtin",
    },
];

export const UI_TOOLS: ToolDefinition[] = [
    {
        name: "open_document",
        description: "在编辑器打开并切换到文档/块。highlight=true 时滚动高亮目标，但不将光标定位到块内。",
        parameters: obj({
            id: {type: "string"},
            highlight: {type: "boolean", default: false},
        }, ["id"]),
        risk: "ui",
        source: "builtin",
    },
    {
        name: "focus_block",
        description: "切换到目标文档并聚焦到块（光标定位），用于需要用户继续编辑时。",
        parameters: obj({id: {type: "string"}}, ["id"]),
        risk: "ui",
        source: "builtin",
    },
];

export const WRITE_TOOLS: ToolDefinition[] = [
    {
        name: "append_markdown",
        description: "在父块末尾追加单个 Markdown 子块。多处追加请用 batch_append_markdown。",
        parameters: obj({parent_id: {type: "string"}, markdown: {type: "string"}}, ["parent_id", "markdown"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "batch_append_markdown",
        description: "批量在多个父块末尾各追加一段 Markdown（一次事务）。",
        parameters: obj({
            appends: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        parent_id: {type: "string"},
                        markdown: {type: "string"},
                    },
                    required: ["parent_id", "markdown"],
                },
            },
        }, ["appends"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "insert_markdown",
        description: "插入单个 Markdown 块。插 2+ 处请用 batch_insert_markdown。锚点三选一。",
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
        name: "batch_insert_markdown",
        description: "批量插入多个 Markdown 块（一次事务）。每项锚点 parent_id / previous_id / next_id 三选一。",
        parameters: obj({
            inserts: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        markdown: {type: "string"},
                        parent_id: {type: "string"},
                        previous_id: {type: "string"},
                        next_id: {type: "string"},
                    },
                    required: ["markdown"],
                },
            },
        }, ["inserts"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "update_markdown",
        description: "用 Markdown 更新单个块。改 2 个及以上块请用 batch_update_markdown。",
        parameters: obj({id: {type: "string"}, markdown: {type: "string"}}, ["id", "markdown"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "batch_update_markdown",
        description:
            "批量更新多个已有块（保留块 ID）。禁止包含文档根块 id。改 2+ 块时优先于多次 update_markdown。",
        parameters: obj({
            updates: {
                type: "array",
                description: "最多 48 项",
                items: {
                    type: "object",
                    properties: {
                        id: {type: "string", description: "块 ID"},
                        markdown: {type: "string", description: "新内容 Markdown"},
                    },
                    required: ["id", "markdown"],
                },
            },
        }, ["updates"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "edit_block_kramdown",
        description: "Kramdown 更新单块，须保留 {: id=\"...\"} IAL。",
        parameters: obj({id: {type: "string"}, kramdown: {type: "string"}}, ["id", "kramdown"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "move_block",
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
        name: "set_block_attributes",
        description: "设置块属性键值对。",
        parameters: obj({
            id: {type: "string"},
            attrs: {type: "object", description: "如 { name: \"标题\", alias: \"别名\" }"},
        }, ["id", "attrs"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "create_document",
        description: "在笔记本下创建新文档。path 末段为文档标题，markdown 正文不要再写同名一级标题。",
        parameters: obj({
            notebook_id: {type: "string"},
            path: {type: "string", description: "如 /folder/文档标题"},
            markdown: {type: "string", description: "正文 Markdown（不含与 path 末段重复的一级标题）"},
        }, ["notebook_id", "path"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "rename_document",
        description: "重命名文档（修改标题块或路径）。",
        parameters: obj({
            id: {type: "string", description: "文档根块 ID"},
            title: {type: "string"},
        }, ["id", "title"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "delete_document",
        description:
            "从笔记本删除整篇文档（移除 .sy 文件，与侧栏删除文档一致）。参数 id 为文档根块 ID。删文档内单个块请用 delete_block，勿用本工具。",
        parameters: obj({
            id: {type: "string", description: "文档根块 ID"},
        }, ["id"]),
        risk: "delete",
        alwaysConfirm: true,
        source: "builtin",
    },
    {
        name: "edit_document",
        description:
            "用新 Markdown 替换整篇文档正文（不含文档标题）；会重建子块、块 ID 会变。仅在大范围重写时使用；删几段/加几段请优先 delete_block + insert/append/update。diff 预览确认后写入。",
        parameters: obj({
            doc_id: {type: "string", description: "文档根块 ID"},
            new_markdown: {type: "string", description: "替换后的完整 Markdown"},
        }, ["doc_id", "new_markdown"]),
        risk: "write",
        source: "builtin",
    },
    {
        name: "delete_block",
        description: "删除单个块。删 2+ 块请用 batch_delete_blocks。",
        parameters: obj({id: {type: "string"}}, ["id"]),
        risk: "delete",
        alwaysConfirm: true,
        source: "builtin",
    },
    {
        name: "batch_delete_blocks",
        description: "批量删除多个块（一次确认；内核无 batchDelete，插件内顺序调用）。",
        parameters: obj({
            ids: {
                type: "array",
                items: {type: "string"},
                description: "要删除的块 ID，最多 48 个",
            },
        }, ["ids"]),
        risk: "delete",
        alwaysConfirm: true,
        source: "builtin",
    },
];

export function allToolDefinitions(): ToolDefinition[] {
    return [...READ_TOOLS, ...STRUCTURE_TOOLS, ...UI_TOOLS, ...WRITE_TOOLS];
}
