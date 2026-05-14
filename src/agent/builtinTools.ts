import {confirmPromise} from "./confirmUtil";
import type {
    AuditEvent,
    KernelExecutor,
    ToolDefinition,
} from "./types";

const MAX_DOC_SNIPPET = 14_000;

export interface RunBuiltinToolContext {
    kernel: KernelExecutor;
    worksetRootIds: Set<string>;
    allowSqlTool: boolean;
    onAudit: (e: AuditEvent) => void;
    /** 写工具二次确认 */
    confirmWrite: (detail: string) => Promise<boolean>;
}

/** 内置 Tool 的 OpenAI JSON Schema + 风险元数据 */
export function getBuiltinToolDefinitions(allowSql: boolean): ToolDefinition[] {
    const base: ToolDefinition[] = [
        {
            name: "siyuan_get_block_info",
            description:
                "根据块 ID 获取 box、path、rootID、rootTitle 等元数据。仅允许访问工作集中的文档（rootID 在工作集内）。",
            parameters: {
                type: "object",
                properties: {
                    id: {type: "string", description: "块或文档 ID"},
                },
                required: ["id"],
            },
            risk: "read",
            needsWriteConfirm: false,
            source: "builtin",
        },
        {
            name: "siyuan_read_doc",
            description:
                "读取文档内容（HTML 片段，与编辑器动态加载一致）。仅允许 rootID 属于工作集。返回内容可能被截断。",
            parameters: {
                type: "object",
                properties: {
                    id: {type: "string", description: "文档根块 ID"},
                },
                required: ["id"],
            },
            risk: "read",
            needsWriteConfirm: false,
            source: "builtin",
        },
        {
            name: "siyuan_search_blocks",
            description: "在当前工作集路径范围内全文搜索块。query 为关键词；method 0 关键字、1 查询语法、3 正则。",
            parameters: {
                type: "object",
                properties: {
                    query: {type: "string"},
                    page: {type: "integer", description: "页码，从 1 开始", default: 1},
                    pageSize: {type: "integer", default: 16},
                    method: {type: "integer", default: 0},
                },
                required: ["query"],
            },
            risk: "read",
            needsWriteConfirm: false,
            source: "builtin",
        },
        {
            name: "siyuan_append_markdown",
            description: "在指定父块下追加 Markdown 子块。父块所在文档必须在工作集中。",
            parameters: {
                type: "object",
                properties: {
                    parent_id: {type: "string", description: "父块 ID"},
                    markdown: {type: "string", description: "Markdown 文本"},
                },
                required: ["parent_id", "markdown"],
            },
            risk: "write",
            needsWriteConfirm: true,
            source: "builtin",
        },
        {
            name: "siyuan_update_markdown",
            description: "用 Markdown 更新指定块内容。该块所在文档必须在工作集中。",
            parameters: {
                type: "object",
                properties: {
                    id: {type: "string", description: "要更新的块 ID"},
                    markdown: {type: "string"},
                },
                required: ["id", "markdown"],
            },
            risk: "write",
            needsWriteConfirm: true,
            source: "builtin",
        },
    ];
    if (!allowSql) {
        return base;
    }
    return [
        ...base,
        {
            name: "siyuan_sql_query",
            description: "执行只读 SQL（内核限制行数）。需要管理员权限与用户在设置中开启；每次调用仍会弹窗确认。",
            parameters: {
                type: "object",
                properties: {
                    stmt: {type: "string", description: "SQL 语句"},
                },
                required: ["stmt"],
            },
            risk: "sql",
            needsWriteConfirm: true,
            source: "builtin",
        },
    ];
}

export function toolsToOpenAIFormat(defs: ToolDefinition[]) {
    return defs.map((d) => ({
        type: "function" as const,
        function: {
            name: d.name,
            description: d.description,
            parameters: d.parameters,
        },
    }));
}

async function ensureRootInWorkset(
    ctx: RunBuiltinToolContext,
    blockId: string,
): Promise<{ok: true; rootId: string;} | {ok: false; error: string;}> {
    const r = await ctx.kernel.post("/api/block/getBlockInfo", {id: blockId});
    if (r.code !== 0) {
        return {ok: false, error: r.msg || `getBlockInfo code=${r.code}`};
    }
    const data = r.data as Record<string, string> | undefined;
    const rootId = data?.rootID;
    if (!rootId) {
        return {ok: false, error: "missing rootID"};
    }
    if (!ctx.worksetRootIds.has(rootId)) {
        return {ok: false, error: "not_in_workset: 请先将文档加入工作集"};
    }
    return {ok: true, rootId};
}

async function collectSearchPaths(ctx: RunBuiltinToolContext): Promise<string[]> {
    const paths: string[] = [];
    for (const rootId of ctx.worksetRootIds) {
        const r = await ctx.kernel.post("/api/block/getBlockInfo", {id: rootId});
        if (r.code !== 0) {
            continue;
        }
        const d = r.data as Record<string, string>;
        if (d?.box && d?.path) {
            const p = d.path.startsWith("/") ? `${d.box}${d.path}` : `${d.box}/${d.path}`;
            paths.push(p);
        }
    }
    return paths;
}

function parseArgs(raw: string): Record<string, unknown> {
    try {
        const v = JSON.parse(raw || "{}");
        return typeof v === "object" && v ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export async function runBuiltinTool(
    ctx: RunBuiltinToolContext,
    name: string,
    argsJson: string,
): Promise<string> {
    const args = parseArgs(argsJson);

    if (name === "siyuan_get_block_info") {
        const id = String(args.id ?? "");
        if (!id) {
            return JSON.stringify({error: "missing id"});
        }
        const gate = await ensureRootInWorkset(ctx, id);
        if (!gate.ok) {
            return JSON.stringify({error: gate.error});
        }
        const r = await ctx.kernel.post("/api/block/getBlockInfo", {id});
        return JSON.stringify({code: r.code, data: r.data, msg: r.msg});
    }

    if (name === "siyuan_read_doc") {
        const id = String(args.id ?? "");
        if (!id) {
            return JSON.stringify({error: "missing id"});
        }
        if (!ctx.worksetRootIds.has(id)) {
            return JSON.stringify({error: "read_doc 仅允许传入工作集中的文档根 ID"});
        }
        const r = await ctx.kernel.post("/api/filetree/getDoc", {
            id,
            mode: 0,
            size: 512,
        });
        if (r.code !== 0) {
            return JSON.stringify({error: r.msg, code: r.code});
        }
        const data = r.data as Record<string, unknown>;
        let content = typeof data.content === "string" ? data.content : "";
        let truncated = false;
        if (content.length > MAX_DOC_SNIPPET) {
            content = content.slice(0, MAX_DOC_SNIPPET);
            truncated = true;
        }
        return JSON.stringify({
            rootID: data.rootID,
            box: data.box,
            path: data.path,
            blockCount: data.blockCount,
            truncated,
            content,
        });
    }

    if (name === "siyuan_search_blocks") {
        const query = String(args.query ?? "");
        if (!query) {
            return JSON.stringify({error: "missing query"});
        }
        if (ctx.worksetRootIds.size === 0) {
            return JSON.stringify({error: "工作集为空，无法限定搜索范围"});
        }
        const paths = await collectSearchPaths(ctx);
        if (paths.length === 0) {
            return JSON.stringify({error: "无法解析工作集路径"});
        }
        const page = typeof args.page === "number" ? args.page : 1;
        const pageSize = typeof args.pageSize === "number" ? args.pageSize : 16;
        const method = typeof args.method === "number" ? args.method : 0;
        const r = await ctx.kernel.post("/api/search/fullTextSearchBlock", {
            query,
            paths,
            page,
            pageSize,
            method,
        });
        return JSON.stringify({code: r.code, msg: r.msg, data: r.data});
    }

    if (name === "siyuan_append_markdown") {
        const parentId = String(args.parent_id ?? "");
        const markdown = String(args.markdown ?? "");
        if (!parentId || !markdown) {
            return JSON.stringify({error: "missing parent_id or markdown"});
        }
        const gate = await ensureRootInWorkset(ctx, parentId);
        if (!gate.ok) {
            return JSON.stringify({error: gate.error});
        }
        const okAppend = await ctx.confirmWrite(
            `append_markdown parent=${parentId} len=${markdown.length}`,
        );
        if (!okAppend) {
            return JSON.stringify({error: "user_cancelled"});
        }
        const r = await ctx.kernel.post("/api/block/appendBlock", {
            parentID: parentId,
            dataType: "markdown",
            data: markdown,
        });
        return JSON.stringify({code: r.code, msg: r.msg, data: r.data});
    }

    if (name === "siyuan_update_markdown") {
        const id = String(args.id ?? "");
        const markdown = String(args.markdown ?? "");
        if (!id || !markdown) {
            return JSON.stringify({error: "missing id or markdown"});
        }
        const gate = await ensureRootInWorkset(ctx, id);
        if (!gate.ok) {
            return JSON.stringify({error: gate.error});
        }
        const ok = await ctx.confirmWrite(`update_markdown id=${id} len=${markdown.length}`);
        if (!ok) {
            return JSON.stringify({error: "user_cancelled"});
        }
        const r = await ctx.kernel.post("/api/block/updateBlock", {
            id,
            dataType: "markdown",
            data: markdown,
        });
        return JSON.stringify({code: r.code, msg: r.msg, data: r.data});
    }

    if (name === "siyuan_sql_query") {
        if (!ctx.allowSqlTool) {
            return JSON.stringify({error: "sql_disabled_in_settings"});
        }
        const stmt = String(args.stmt ?? "");
        if (!stmt) {
            return JSON.stringify({error: "missing stmt"});
        }
        const ok = await confirmPromise(
            "SQL",
            `确认执行以下 SQL？\n\n${stmt.slice(0, 800)}${stmt.length > 800 ? "\n…" : ""}`,
        );
        if (!ok) {
            return JSON.stringify({error: "user_cancelled"});
        }
        const r = await ctx.kernel.post("/api/query/sql", {stmt});
        return JSON.stringify({code: r.code, msg: r.msg, data: r.data});
    }

    return JSON.stringify({error: `unknown_tool:${name}`});
}
