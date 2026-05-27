import type {ToolDefinition, ToolName} from "../agent/types";

export function getToolDefinitions(): ToolDefinition[] {
    return [
        {
            name: "siyuan_get_block_info",
            description: "获取块或文档的元数据：box、path、rootID、rootTitle 等。",
            parameters: {
                type: "object",
                properties: {id: {type: "string", description: "块或文档 ID"}},
                required: ["id"],
                additionalProperties: false,
            },
            risk: "read",
            source: "builtin",
        },
        {
            name: "siyuan_read_markdown",
            description:
                "读取文档的 Markdown 原文（内核导出）。id 为文档根块 ID。可选 start_line/end_line（1-based）截取行范围。",
            parameters: {
                type: "object",
                properties: {
                    id: {type: "string", description: "文档根块 ID"},
                    start_line: {type: "integer", description: "起始行号，从 1 开始"},
                    end_line: {type: "integer", description: "结束行号（含）"},
                },
                required: ["id"],
            },
            risk: "read",
            source: "builtin",
        },
        {
            name: "siyuan_read_kramdown",
            description:
                "读取单个块的 Kramdown 源码（含块 ID IAL）。用于精确编辑、保留块引用。id 为块 ID。",
            parameters: {
                type: "object",
                properties: {
                    id: {type: "string", description: "块 ID"},
                    mode: {
                        type: "string",
                        enum: ["md", "textmark"],
                        description: "默认 md",
                    },
                },
                required: ["id"],
            },
            risk: "read",
            source: "builtin",
        },
        {
            name: "siyuan_search_blocks",
            description: "全文搜索块。method：0 关键字、1 查询语法、3 正则。",
            parameters: {
                type: "object",
                properties: {
                    query: {type: "string"},
                    page: {type: "integer", default: 1},
                    pageSize: {type: "integer", default: 16},
                    method: {type: "integer", default: 0},
                },
                required: ["query"],
            },
            risk: "read",
            source: "builtin",
        },
        {
            name: "siyuan_list_child_blocks",
            description: "列出父块下直接子块的 id、type、content 摘要。",
            parameters: {
                type: "object",
                properties: {
                    parent_id: {type: "string"},
                    limit: {type: "integer", default: 32},
                },
                required: ["parent_id"],
            },
            risk: "read",
            source: "builtin",
        },
        {
            name: "siyuan_open_document",
            description: "在编辑器中打开文档或块。highlight 为 true 时高亮并聚焦该块。",
            parameters: {
                type: "object",
                properties: {
                    id: {type: "string"},
                    highlight: {type: "boolean", default: false},
                },
                required: ["id"],
            },
            risk: "ui",
            source: "builtin",
        },
        {
            name: "siyuan_focus_block",
            description: "在当前已打开的文档中滚动并高亮到指定块（不切换文档）。",
            parameters: {
                type: "object",
                properties: {id: {type: "string"}},
                required: ["id"],
            },
            risk: "ui",
            source: "builtin",
        },
        {
            name: "siyuan_append_markdown",
            description: "在父块末尾追加 Markdown 子块。适合新增段落、列表项等。",
            parameters: {
                type: "object",
                properties: {
                    parent_id: {type: "string"},
                    markdown: {type: "string"},
                },
                required: ["parent_id", "markdown"],
            },
            risk: "write",
            source: "builtin",
        },
        {
            name: "siyuan_insert_markdown",
            description:
                "在 next_id 之前、previous_id 之后或 parent_id 下插入 Markdown。锚点三选一。",
            parameters: {
                type: "object",
                properties: {
                    markdown: {type: "string"},
                    parent_id: {type: "string"},
                    previous_id: {type: "string"},
                    next_id: {type: "string"},
                },
                required: ["markdown"],
            },
            risk: "write",
            source: "builtin",
        },
        {
            name: "siyuan_update_markdown",
            description: "用 Markdown 更新单个块（适合纯文本段落，可能无法保留复杂结构）。",
            parameters: {
                type: "object",
                properties: {
                    id: {type: "string"},
                    markdown: {type: "string"},
                },
                required: ["id", "markdown"],
            },
            risk: "write",
            source: "builtin",
        },
        {
            name: "siyuan_edit_block_kramdown",
            description:
                "用 Kramdown 更新单个块（保留块 ID 与引用）。kramdown 须包含该块的 {: id=\"...\"} IAL。",
            parameters: {
                type: "object",
                properties: {
                    id: {type: "string"},
                    kramdown: {type: "string"},
                },
                required: ["id", "kramdown"],
            },
            risk: "write",
            source: "builtin",
        },
        {
            name: "siyuan_delete_block",
            description: "删除指定块。若块被引用，操作风险较高。",
            parameters: {
                type: "object",
                properties: {id: {type: "string"}},
                required: ["id"],
            },
            risk: "delete",
            alwaysConfirm: true,
            source: "builtin",
        },
        {
            name: "siyuan_move_block",
            description: "移动块到新的 parent_id 或 previous_id 之后。",
            parameters: {
                type: "object",
                properties: {
                    id: {type: "string"},
                    parent_id: {type: "string"},
                    previous_id: {type: "string"},
                },
                required: ["id"],
            },
            risk: "write",
            source: "builtin",
        },
        {
            name: "siyuan_sql_query",
            description:
                "只读 SQL 查询（SELECT / WITH / EXPLAIN / VALUES）。禁止写语句。",
            parameters: {
                type: "object",
                properties: {stmt: {type: "string"}},
                required: ["stmt"],
            },
            risk: "sql",
            alwaysConfirm: true,
            source: "builtin",
        },
    ];
}

export function toolsToDeepSeekFormat(defs: ToolDefinition[]) {
    return defs.map((d) => ({
        type: "function" as const,
        function: {
            name: d.name,
            description: d.description,
            parameters: d.parameters,
        },
    }));
}

export function getToolByName(name: ToolName): ToolDefinition | undefined {
    return getToolDefinitions().find((d) => d.name === name);
}
