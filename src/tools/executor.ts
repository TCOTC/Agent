import {openTab} from "siyuan";
import type Agent from "../index";
import type {AuditEvent, KernelExecutor, ToolName} from "../agent/types";
import {Constants} from "../core/editorContext";
import {agentBus, AgentEvents} from "../core/eventBus";
import {computeLineDiff, diffSummary, renderDiffHtml} from "../editor/diffEngine";
import {getToolByName} from "./registry";
import {assessToolRisk, formatRiskSummary} from "./riskPolicy";
import {docTitleFromPath, EXPORT_MD_BODY_OPTS, sliceMarkdownByLines, stripLeadingDocumentTitle} from "./markdown";
import {truncateToolOutput, wrapToolJson} from "./truncate";
import {validateKramdownPayload, verifyBlockExists} from "./kramdownValidate";
import {checkWorkset, resolveNotebookId, worksetError} from "./worksetGate";
import {isToolName} from "../agent/types";

const SQL_READONLY = /^\s*(SELECT|WITH|EXPLAIN|VALUES)\b/i;

export interface ToolRunContext {
    kernel: KernelExecutor;
    plugin: Agent;
    onAudit: (e: AuditEvent) => void;
    requestConfirm: (title: string, detail: string) => Promise<boolean>;
    worksetNotebookIds: string[];
    riskAutoApproveMax: number;
    showDiffPreview?: (html: string, title: string) => Promise<boolean>;
    /** 长时间工具步骤的 UI 提示（如等待 diff 确认） */
    onToolUiHint?: (hint: string) => void;
}

function parseArgs(raw: string): Record<string, unknown> {
    try {
        const v = JSON.parse(raw || "{}");
        return typeof v === "object" && v && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
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
    const risk = assessToolRisk(def, args, ctx.riskAutoApproveMax);
    if (risk.autoApprove) {
        return {proceed: true, riskScore: risk.score, autoApproved: true};
    }
    ctx.onAudit({kind: "tool_confirm_required", name, detail, riskScore: risk.score});
    const approved = await ctx.requestConfirm(`Agent · ${name}`, `${formatRiskSummary(risk)}\n\n${detail}`);
    ctx.onAudit({kind: "tool_confirm_result", name, approved});
    return {proceed: approved, riskScore: risk.score, autoApproved: false};
}

async function gateWorkset(ctx: ToolRunContext, blockId: string): Promise<string | null> {
    const info = await resolveNotebookId(ctx.kernel, blockId);
    if (info.ok === false) {
        return info.error;
    }
    if (!checkWorkset(info.box, ctx.worksetNotebookIds)) {
        return worksetError(info.box);
    }
    return null;
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

    agentBus.emit(AgentEvents.TOOL_START, {name: toolName, args});

    try {
        if (toolName === "siyuan_get_block_info") {
            const id = String(args.id ?? "");
            const r = await ctx.kernel.post("/api/block/getBlockInfo", {id});
            return {text: truncateToolOutput(JSON.stringify(r)).text, ok: r.code === 0};
        }

        if (toolName === "siyuan_read_markdown") {
            const id = String(args.id ?? "");
            const ws = await gateWorkset(ctx, id);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const r = await ctx.kernel.post("/api/export/exportMdContent", {id, ...EXPORT_MD_BODY_OPTS});
            if (r.code !== 0) {
                return {text: JSON.stringify({error: r.msg}), ok: false};
            }
            const data = r.data as {content?: string; hPath?: string};
            let md = typeof data.content === "string" ? data.content : "";
            const info = await ctx.kernel.post("/api/block/getBlockInfo", {id});
            const docTitle = (info.data as {rootTitle?: string})?.rootTitle;
            const sliced = sliceMarkdownByLines(
                md,
                typeof args.start_line === "number" ? args.start_line : undefined,
                typeof args.end_line === "number" ? args.end_line : undefined,
            );
            return {
                text: wrapToolJson({
                    hPath: data.hPath,
                    docTitle,
                    note: "正文不含文档标题；siyuan_edit_document 时不要写入与 docTitle 重复的一级标题",
                    totalLines: sliced.totalLines,
                    startLine: sliced.startLine,
                    endLine: sliced.endLine,
                }, sliced.content),
                ok: true,
            };
        }

        if (toolName === "siyuan_read_kramdown") {
            const id = String(args.id ?? "");
            const ws = await gateWorkset(ctx, id);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/getBlockKramdown", {
                id,
                mode: args.mode === "textmark" ? "textmark" : "md",
            });
            if (r.code !== 0) {
                return {text: JSON.stringify({error: r.msg}), ok: false};
            }
            const kd = (r.data as {kramdown?: string})?.kramdown ?? "";
            return {text: wrapToolJson({id}, kd), ok: true};
        }

        if (toolName === "siyuan_search_blocks") {
            const r = await ctx.kernel.post("/api/search/fullTextSearchBlock", {
                query: String(args.query ?? ""),
                paths: [],
                page: typeof args.page === "number" ? args.page : 1,
                pageSize: typeof args.pageSize === "number" ? args.pageSize : 16,
                method: typeof args.method === "number" ? args.method : 0,
            });
            return {text: truncateToolOutput(JSON.stringify(r)).text, ok: r.code === 0};
        }

        if (toolName === "siyuan_list_child_blocks") {
            const r = await ctx.kernel.post("/api/block/getChildBlocks", {id: String(args.parent_id ?? "")});
            if (r.code !== 0) {
                return {text: JSON.stringify({error: r.msg}), ok: false};
            }
            const list = Array.isArray(r.data) ? r.data : [];
            const limit = typeof args.limit === "number" ? args.limit : 32;
            const brief = list.slice(0, limit).map((b: Record<string, unknown>) => ({
                id: b.id,
                type: b.type,
                content: typeof b.content === "string" ? b.content.slice(0, 120) : b.content,
            }));
            return {text: truncateToolOutput(JSON.stringify({count: list.length, blocks: brief})).text, ok: true};
        }

        if (toolName === "siyuan_get_doc_outline") {
            const id = String(args.id ?? "");
            const r = await ctx.kernel.post("/api/outline/getDocOutline", {id, preview: false});
            return {text: truncateToolOutput(JSON.stringify(r)).text, ok: r.code === 0};
        }

        if (toolName === "siyuan_get_backlinks") {
            const id = String(args.id ?? "");
            const r = await ctx.kernel.post("/api/ref/getBacklink", {
                id,
                k: String(args.keyword ?? ""),
                mk: "",
                containChildren: args.contain_children === true,
            });
            return {text: truncateToolOutput(JSON.stringify(r)).text, ok: r.code === 0};
        }

        if (toolName === "siyuan_get_block_attributes") {
            const r = await ctx.kernel.post("/api/attr/getBlockAttrs", {id: String(args.id ?? "")});
            return {text: truncateToolOutput(JSON.stringify(r)).text, ok: r.code === 0};
        }

        if (toolName === "siyuan_get_recent_docs") {
            const limit = typeof args.limit === "number" ? args.limit : 20;
            const r = await ctx.kernel.post("/api/query/sql", {
                stmt: `SELECT b.id, b.content, b.hpath, b.updated FROM blocks b WHERE b.type='d' ORDER BY b.updated DESC LIMIT ${limit}`,
                mode: "readonly",
            });
            return {text: truncateToolOutput(JSON.stringify(r)).text, ok: r.code === 0};
        }

        if (toolName === "siyuan_list_notebooks") {
            const r = await ctx.kernel.post("/api/notebook/lsNotebooks", {});
            return {text: truncateToolOutput(JSON.stringify(r)).text, ok: r.code === 0};
        }

        if (toolName === "siyuan_list_documents") {
            const nb = String(args.notebook_id ?? "");
            if (ctx.worksetNotebookIds.length && !ctx.worksetNotebookIds.includes(nb)) {
                return {text: JSON.stringify({error: worksetError(nb)}), ok: false};
            }
            const r = await ctx.kernel.post("/api/filetree/listDocsByPath", {
                notebook: nb,
                path: String(args.path ?? "/"),
                page: typeof args.page === "number" ? args.page : 1,
                pageSize: typeof args.page_size === "number" ? args.page_size : 32,
            });
            return {text: truncateToolOutput(JSON.stringify(r)).text, ok: r.code === 0};
        }

        if (toolName === "siyuan_open_document" || toolName === "siyuan_focus_block") {
            const id = String(args.id ?? "");
            const highlight = toolName === "siyuan_focus_block" || args.highlight === true;
            openTab({
                app: ctx.plugin.app,
                doc: {
                    id,
                    action: highlight
                        ? [Constants.CB_GET_ALL, Constants.CB_GET_HL, Constants.CB_GET_FOCUS]
                        : [Constants.CB_GET_ALL],
                },
            });
            return {text: JSON.stringify({ok: true, id}), ok: true};
        }

        if (toolName === "siyuan_edit_document") {
            const docId = String(args.doc_id ?? "");
            let newMd = String(args.new_markdown ?? "");
            const ws = await gateWorkset(ctx, docId);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const info = await ctx.kernel.post("/api/block/getBlockInfo", {id: docId});
            const title = (info.data as {rootTitle?: string})?.rootTitle;
            const stripped = stripLeadingDocumentTitle(newMd, title);
            newMd = stripped.markdown;

            const cur = await ctx.kernel.post("/api/export/exportMdContent", {id: docId, ...EXPORT_MD_BODY_OPTS});
            if (cur.code !== 0) {
                return {text: JSON.stringify({error: cur.msg}), ok: false};
            }
            const oldMd = (cur.data as {content?: string})?.content ?? "";
            const diff = computeLineDiff(oldMd, newMd);
            const summary = diffSummary(diff);

            if (summary.adds === 0 && summary.removes === 0) {
                return {
                    text: JSON.stringify({doc_id: docId, applied: false, reason: "no_changes"}),
                    ok: true,
                };
            }

            ctx.onAudit({
                kind: "pending_edit",
                docId,
                adds: summary.adds,
                removes: summary.removes,
            });

            if (!ctx.showDiffPreview) {
                return {text: JSON.stringify({error: "preview_unavailable"}), ok: false};
            }

            ctx.onToolUiHint?.("请在弹窗中查看 diff 并选择「应用」或「拒绝」");

            const accepted = await ctx.showDiffPreview(
                renderDiffHtml(diff),
                `文档编辑预览 · ${title ?? docId}`,
            );
            if (!accepted) {
                return {
                    text: JSON.stringify({doc_id: docId, applied: false, reason: "user_rejected"}),
                    ok: false,
                };
            }

            const r = await ctx.kernel.post("/api/block/updateBlock", {
                id: docId,
                dataType: "markdown",
                data: newMd,
            });
            return {
                text: JSON.stringify({
                    doc_id: docId,
                    applied: r.code === 0,
                    summary,
                    title_stripped: stripped.stripped,
                    kernel: r,
                }),
                ok: r.code === 0,
            };
        }

        if (toolName === "siyuan_create_document") {
            const nb = String(args.notebook_id ?? "");
            if (ctx.worksetNotebookIds.length && !ctx.worksetNotebookIds.includes(nb)) {
                return {text: JSON.stringify({error: worksetError(nb)}), ok: false};
            }
            const gate = await gateConfirm(ctx, toolName, args, `创建文档 ${args.path}`);
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const path = String(args.path ?? "/Untitled");
            let markdown = String(args.markdown ?? "");
            const title = docTitleFromPath(path);
            const stripped = stripLeadingDocumentTitle(markdown, title);
            markdown = stripped.markdown;
            const r = await ctx.kernel.post("/api/filetree/createDocWithMd", {
                notebook: nb,
                path,
                markdown,
            });
            return {
                text: JSON.stringify({
                    code: r.code,
                    msg: r.msg,
                    data: r.data,
                    title_stripped: stripped.stripped,
                }),
                ok: r.code === 0,
            };
        }

        if (toolName === "siyuan_rename_document") {
            const id = String(args.id ?? "");
            const ws = await gateWorkset(ctx, id);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const gate = await gateConfirm(ctx, toolName, args, `重命名为 ${args.title}`);
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/filetree/renameDocByID", {
                id,
                title: String(args.title ?? ""),
            });
            return {text: JSON.stringify(r), ok: r.code === 0};
        }

        if (toolName === "siyuan_set_block_attributes") {
            const id = String(args.id ?? "");
            const ws = await gateWorkset(ctx, id);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const attrs = args.attrs;
            if (!attrs || typeof attrs !== "object") {
                return {text: JSON.stringify({error: "missing attrs"}), ok: false};
            }
            const gate = await gateConfirm(ctx, toolName, args, `设置属性 ${JSON.stringify(attrs).slice(0, 200)}`);
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/attr/setBlockAttrs", {id, attrs});
            return {text: JSON.stringify(r), ok: r.code === 0};
        }

        if (toolName === "siyuan_append_markdown") {
            const parentId = String(args.parent_id ?? "");
            const ws = await gateWorkset(ctx, parentId);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const gate = await gateConfirm(ctx, toolName, args, `追加到 ${parentId}`);
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/appendBlock", {
                parentID: parentId,
                dataType: "markdown",
                data: String(args.markdown ?? ""),
            });
            return {text: JSON.stringify(r), ok: r.code === 0, riskScore: gate.riskScore, autoApproved: gate.autoApproved};
        }

        if (toolName === "siyuan_insert_markdown") {
            const markdown = String(args.markdown ?? "");
            const body: Record<string, unknown> = {dataType: "markdown", data: markdown};
            const anchor = String(args.next_id ?? args.previous_id ?? args.parent_id ?? "");
            if (args.next_id) {
                body.nextID = String(args.next_id);
            } else if (args.previous_id) {
                body.previousID = String(args.previous_id);
            } else if (args.parent_id) {
                body.parentID = String(args.parent_id);
            } else {
                return {text: JSON.stringify({error: "need anchor id"}), ok: false};
            }
            const ws = await gateWorkset(ctx, anchor);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const gate = await gateConfirm(ctx, toolName, args, "插入 Markdown");
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/insertBlock", body);
            return {text: JSON.stringify(r), ok: r.code === 0};
        }

        if (toolName === "siyuan_update_markdown") {
            const id = String(args.id ?? "");
            const ws = await gateWorkset(ctx, id);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const gate = await gateConfirm(ctx, toolName, args, `更新块 ${id}`);
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/updateBlock", {
                id,
                dataType: "markdown",
                data: String(args.markdown ?? ""),
            });
            return {text: JSON.stringify(r), ok: r.code === 0};
        }

        if (toolName === "siyuan_edit_block_kramdown") {
            const id = String(args.id ?? "");
            const kramdown = String(args.kramdown ?? "");
            const v = validateKramdownPayload(kramdown, id);
            if (!v.ok) {
                return {text: JSON.stringify({error: v.error}), ok: false};
            }
            const ws = await gateWorkset(ctx, id);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const gate = await gateConfirm(ctx, toolName, args, `Kramdown 更新 ${id}`);
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/updateBlock", {id, dataType: "markdown", data: kramdown});
            const exists = r.code === 0 && (await verifyBlockExists(ctx.kernel, id));
            return {text: JSON.stringify({...r, verified: exists}), ok: r.code === 0 && exists};
        }

        if (toolName === "siyuan_delete_block") {
            const id = String(args.id ?? "");
            const ws = await gateWorkset(ctx, id);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const ref = await ctx.kernel.post("/api/block/checkBlockRef", {ids: [id]});
            const hasRef = ref.code === 0 && ref.data === true;
            const gate = await gateConfirm(ctx, toolName, args, `删除 ${id}${hasRef ? "（有引用）" : ""}`);
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/deleteBlock", {id});
            return {text: JSON.stringify({...r, hadRefs: hasRef}), ok: r.code === 0};
        }

        if (toolName === "siyuan_move_block") {
            const id = String(args.id ?? "");
            const ws = await gateWorkset(ctx, id);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
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
            return {text: JSON.stringify(r), ok: r.code === 0};
        }

        if (toolName === "siyuan_sql_query") {
            const stmt = String(args.stmt ?? "");
            if (!stmt || !SQL_READONLY.test(stmt.trim()) || /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(stmt)) {
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
        agentBus.emit(AgentEvents.TOOL_END, {name: toolName, ok: false});
        return {text: JSON.stringify({error: err}), ok: false};
    }

    agentBus.emit(AgentEvents.TOOL_END, {name: toolName, ok: true});
    return {text: JSON.stringify({error: "unhandled"}), ok: false};
}
