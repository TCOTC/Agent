import {openTab} from "siyuan";
import type Agent from "../index";
import type {AuditEvent, KernelExecutor, ToolName} from "../agent/types";
import {Constants} from "../core/editorContext";
import {assessToolRisk, formatRiskSummary} from "./riskPolicy";
import {getToolByName, getToolDefinitions} from "./definitions";
import {sliceMarkdownByLines} from "./markdown";
import {truncateToolOutput, wrapToolJson} from "./truncate";
import {validateKramdownPayload, verifyBlockExists} from "./kramdownValidate";
import {isToolName} from "../agent/types";

const SQL_READONLY = /^\s*(SELECT|WITH|EXPLAIN|VALUES)\b/i;

export interface ToolRunContext {
    kernel: KernelExecutor;
    plugin: Agent;
    onAudit: (e: AuditEvent) => void;
    requestConfirm: (title: string, detail: string) => Promise<boolean>;
}

function parseArgs(raw: string): Record<string, unknown> {
    try {
        const v = JSON.parse(raw || "{}");
        return typeof v === "object" && v && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

function sqlLooksReadonly(stmt: string): boolean {
    const s = stmt.trim();
    if (!SQL_READONLY.test(s)) {
        return false;
    }
    return !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|TRUNCATE)\b/i.test(s);
}

async function gateConfirm(
    ctx: ToolRunContext,
    name: ToolName,
    args: Record<string, unknown>,
    detail: string,
): Promise<{proceed: boolean; riskScore: number; autoApproved: boolean}> {
    const def = getToolByName(name);
    if (!def) {
        return {proceed: false, riskScore: 100, autoApproved: false};
    }
    const risk = assessToolRisk(def, args);
    if (risk.autoApprove) {
        return {proceed: true, riskScore: risk.score, autoApproved: true};
    }
    ctx.onAudit({
        kind: "tool_confirm_required",
        name,
        detail,
        riskScore: risk.score,
    });
    const approved = await ctx.requestConfirm(
        `Agent 请求执行：${name}`,
        `${formatRiskSummary(risk)}\n\n${detail}`,
    );
    ctx.onAudit({kind: "tool_confirm_result", name, approved});
    return {proceed: approved, riskScore: risk.score, autoApproved: false};
}

export async function runTool(
    ctx: ToolRunContext,
    name: string,
    argsJson: string,
): Promise<{text: string; ok: boolean; riskScore?: number; autoApproved?: boolean}> {
    if (!isToolName(name)) {
        return {text: JSON.stringify({error: `unknown_tool:${name}`}), ok: false};
    }
    const args = parseArgs(argsJson);
    const toolName = name;

    try {
        if (toolName === "siyuan_get_block_info") {
            const id = String(args.id ?? "");
            if (!id) {
                return {text: JSON.stringify({error: "missing id"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/getBlockInfo", {id});
            return {text: truncateToolOutput(JSON.stringify(r)).text, ok: r.code === 0};
        }

        if (toolName === "siyuan_read_markdown") {
            const id = String(args.id ?? "");
            if (!id) {
                return {text: JSON.stringify({error: "missing id"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/export/exportMdContent", {
                id,
                yfm: false,
                fillCSSVar: false,
            });
            if (r.code !== 0) {
                return {text: JSON.stringify({error: r.msg, code: r.code}), ok: false};
            }
            const data = r.data as {content?: string; hPath?: string};
            let md = typeof data.content === "string" ? data.content : "";
            const startLine = typeof args.start_line === "number" ? args.start_line : undefined;
            const endLine = typeof args.end_line === "number" ? args.end_line : undefined;
            const sliced = sliceMarkdownByLines(md, startLine, endLine);
            return {
                text: wrapToolJson({
                    hPath: data.hPath,
                    totalLines: sliced.totalLines,
                    startLine: sliced.startLine,
                    endLine: sliced.endLine,
                }, sliced.content),
                ok: true,
            };
        }

        if (toolName === "siyuan_read_kramdown") {
            const id = String(args.id ?? "");
            if (!id) {
                return {text: JSON.stringify({error: "missing id"}), ok: false};
            }
            const mode = args.mode === "textmark" ? "textmark" : "md";
            const r = await ctx.kernel.post("/api/block/getBlockKramdown", {id, mode});
            if (r.code !== 0) {
                return {text: JSON.stringify({error: r.msg, code: r.code}), ok: false};
            }
            const kd = (r.data as {kramdown?: string})?.kramdown ?? "";
            return {text: wrapToolJson({id}, kd), ok: true};
        }

        if (toolName === "siyuan_search_blocks") {
            const query = String(args.query ?? "");
            if (!query) {
                return {text: JSON.stringify({error: "missing query"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/search/fullTextSearchBlock", {
                query,
                paths: [],
                page: typeof args.page === "number" ? args.page : 1,
                pageSize: typeof args.pageSize === "number" ? args.pageSize : 16,
                method: typeof args.method === "number" ? args.method : 0,
            });
            return {text: truncateToolOutput(JSON.stringify(r)).text, ok: r.code === 0};
        }

        if (toolName === "siyuan_list_child_blocks") {
            const parentId = String(args.parent_id ?? "");
            const limit = typeof args.limit === "number" ? args.limit : 32;
            const r = await ctx.kernel.post("/api/block/getChildBlocks", {id: parentId});
            if (r.code !== 0) {
                return {text: JSON.stringify({error: r.msg}), ok: false};
            }
            const list = Array.isArray(r.data) ? r.data : [];
            const brief = list.slice(0, limit).map((b: Record<string, unknown>) => ({
                id: b.id,
                type: b.type,
                content: typeof b.content === "string" ? b.content.slice(0, 120) : b.content,
            }));
            return {
                text: truncateToolOutput(JSON.stringify({count: list.length, blocks: brief})).text,
                ok: true,
            };
        }

        if (toolName === "siyuan_open_document") {
            const id = String(args.id ?? "");
            const highlight = args.highlight === true;
            const actions = highlight
                ? [Constants.CB_GET_ALL, Constants.CB_GET_HL, Constants.CB_GET_FOCUS]
                : [Constants.CB_GET_ALL];
            openTab({
                app: ctx.plugin.app,
                doc: {id, action: actions},
            });
            return {text: JSON.stringify({ok: true, opened: id}), ok: true};
        }

        if (toolName === "siyuan_focus_block") {
            const id = String(args.id ?? "");
            openTab({
                app: ctx.plugin.app,
                doc: {
                    id,
                    action: [Constants.CB_GET_ALL, Constants.CB_GET_HL, Constants.CB_GET_FOCUS],
                },
            });
            return {text: JSON.stringify({ok: true, focused: id}), ok: true};
        }

        if (toolName === "siyuan_append_markdown") {
            const parentId = String(args.parent_id ?? "");
            const markdown = String(args.markdown ?? "");
            if (!parentId || !markdown) {
                return {text: JSON.stringify({error: "missing parent_id or markdown"}), ok: false};
            }
            const gate = await gateConfirm(
                ctx,
                toolName,
                args,
                `在 ${parentId} 下追加 ${markdown.length} 字符 Markdown`,
            );
            if (!gate.proceed) {
                return {
                    text: JSON.stringify({error: "user_cancelled"}),
                    ok: false,
                    riskScore: gate.riskScore,
                    autoApproved: gate.autoApproved,
                };
            }
            const r = await ctx.kernel.post("/api/block/appendBlock", {
                parentID: parentId,
                dataType: "markdown",
                data: markdown,
            });
            return {
                text: JSON.stringify(r),
                ok: r.code === 0,
                riskScore: gate.riskScore,
                autoApproved: gate.autoApproved,
            };
        }

        if (toolName === "siyuan_insert_markdown") {
            const markdown = String(args.markdown ?? "");
            const body: Record<string, unknown> = {dataType: "markdown", data: markdown};
            if (args.next_id) {
                body.nextID = String(args.next_id);
            } else if (args.previous_id) {
                body.previousID = String(args.previous_id);
            } else if (args.parent_id) {
                body.parentID = String(args.parent_id);
            } else {
                return {text: JSON.stringify({error: "need next_id, previous_id or parent_id"}), ok: false};
            }
            const gate = await gateConfirm(ctx, toolName, args, `插入 Markdown，长度 ${markdown.length}`);
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/insertBlock", body);
            return {
                text: JSON.stringify(r),
                ok: r.code === 0,
                riskScore: gate.riskScore,
                autoApproved: gate.autoApproved,
            };
        }

        if (toolName === "siyuan_update_markdown") {
            const id = String(args.id ?? "");
            const markdown = String(args.markdown ?? "");
            const gate = await gateConfirm(ctx, toolName, args, `更新块 ${id}，${markdown.length} 字符`);
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/updateBlock", {
                id,
                dataType: "markdown",
                data: markdown,
            });
            return {text: JSON.stringify(r), ok: r.code === 0, riskScore: gate.riskScore};
        }

        if (toolName === "siyuan_edit_block_kramdown") {
            const id = String(args.id ?? "");
            const kramdown = String(args.kramdown ?? "");
            const v = validateKramdownPayload(kramdown, id);
            if (!v.ok) {
                return {text: JSON.stringify({error: v.error}), ok: false};
            }
            const gate = await gateConfirm(
                ctx,
                toolName,
                args,
                `Kramdown 更新块 ${id}，${kramdown.length} 字符`,
            );
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/updateBlock", {
                id,
                dataType: "markdown",
                data: kramdown,
            });
            if (r.code !== 0) {
                return {text: JSON.stringify(r), ok: false};
            }
            const exists = await verifyBlockExists(ctx.kernel, id);
            return {
                text: JSON.stringify({...r, verified: exists}),
                ok: r.code === 0 && exists,
                riskScore: gate.riskScore,
            };
        }

        if (toolName === "siyuan_delete_block") {
            const id = String(args.id ?? "");
            const ref = await ctx.kernel.post("/api/block/checkBlockRef", {ids: [id]});
            const hasRef = ref.code === 0 && ref.data === true;
            const gate = await gateConfirm(
                ctx,
                toolName,
                args,
                `删除块 ${id}${hasRef ? "（该块存在引用，请谨慎）" : ""}`,
            );
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/deleteBlock", {id});
            return {text: JSON.stringify({...r, hadRefs: hasRef}), ok: r.code === 0};
        }

        if (toolName === "siyuan_move_block") {
            const id = String(args.id ?? "");
            const body: Record<string, unknown> = {id};
            if (args.parent_id) {
                body.parentID = String(args.parent_id);
            }
            if (args.previous_id) {
                body.previousID = String(args.previous_id);
            }
            const gate = await gateConfirm(ctx, toolName, args, `移动块 ${id}`);
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/moveBlock", body);
            return {text: JSON.stringify(r), ok: r.code === 0, riskScore: gate.riskScore};
        }

        if (toolName === "siyuan_sql_query") {
            const stmt = String(args.stmt ?? "");
            if (!stmt || !sqlLooksReadonly(stmt)) {
                return {text: JSON.stringify({error: "仅允许只读 SQL"}), ok: false};
            }
            const gate = await gateConfirm(ctx, toolName, args, stmt.slice(0, 800));
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/query/sql", {stmt, mode: "readonly"});
            return {text: truncateToolOutput(JSON.stringify(r)).text, ok: r.code === 0};
        }
    } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        return {text: JSON.stringify({error: err}), ok: false};
    }

    return {text: JSON.stringify({error: "unhandled"}), ok: false};
}

export {getToolDefinitions};
