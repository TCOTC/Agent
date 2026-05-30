import {openTab} from "siyuan";
import type Agent from "../index";
import type {AuditEvent, KernelExecutor, ToolConfirmRequest, ToolName} from "../agent/types";
import {captureEditorContext, formatEditorContextForPrompt} from "../core/editorContext";
import {
    buildOpenDocumentAction,
    getBlockFoldInfo,
    navigateToBlockRef,
} from "../siyuan/blockNavigation";
import {agentBus, AgentEvents} from "../core/eventBus";
import {computeLineDiff, diffSummary, renderDiffHtml} from "../editor/diffEngine";
import {
    gateWorksetMany,
    isDocumentRootBlock,
    parseBatchAppends,
    parseBatchDeleteIds,
    parseBatchInserts,
    parseBatchUpdates,
    summarizeBatchIds,
    totalMarkdownChars,
} from "./batchTools";
import {getToolByName} from "./registry";
import {assessToolRisk, formatRiskSummary} from "./riskPolicy";
import {docTitleFromPath, EXPORT_MD_BODY_OPTS, sliceMarkdownByLines, stripLeadingDocumentTitle} from "./markdown";
import {compactKernelResponseTruncated, truncateToolOutput, wrapToolJson} from "./truncate";
import {validateKramdownPayload, verifyBlockExists} from "./kramdownValidate";
import {checkWorkset, resolveNotebookId, worksetError} from "./worksetGate";
import {isToolName} from "../agent/types";

const SQL_READONLY = /^\s*(SELECT|WITH|EXPLAIN|VALUES)\b/i;

export interface ToolRunContext {
    kernel: KernelExecutor;
    plugin: Agent;
    onAudit: (e: AuditEvent) => void;
    requestConfirm: (req: ToolConfirmRequest) => Promise<boolean>;
    worksetNotebookIds: string[];
    getRiskAutoApproveMax: () => number;
    showDiffPreview?: (html: string, title: string, toolCallId: string) => Promise<boolean>;
    toolCallId?: string;
    /** 长时间工具步骤的 UI 提示（如等待 diff 确认） */
    onToolUiHint?: (hint: string) => void;
    /** 已由 Agent beforeToolCall 完成风险确认时跳过 gateConfirm */
    skipRiskGate?: boolean;
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
    const risk = assessToolRisk(def, args, ctx.getRiskAutoApproveMax());
    if (ctx.skipRiskGate || risk.autoApprove) {
        return {proceed: true, riskScore: risk.score, autoApproved: ctx.skipRiskGate || risk.autoApprove};
    }
    const riskSummary = formatRiskSummary(risk);
    ctx.onAudit({kind: "tool_confirm_required", name, detail, riskScore: risk.score});
    const approved = await ctx.requestConfirm({
        toolCallId: ctx.toolCallId ?? `gate:${name}`,
        toolName: name,
        title: `Agent · ${name}`,
        riskSummary,
        detail: `${riskSummary}\n\n${detail}`,
    });
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
        if (toolName === "get_block_info") {
            const id = String(args.id ?? "");
            const r = await ctx.kernel.post("/api/block/getBlockInfo", {id});
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }

        if (toolName === "read_markdown") {
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
            const md = typeof data.content === "string" ? data.content : "";
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
                    note: "正文不含文档标题；edit_document 时不要写入与 docTitle 重复的一级标题",
                    totalLines: sliced.totalLines,
                    startLine: sliced.startLine,
                    endLine: sliced.endLine,
                }, sliced.content),
                ok: true,
            };
        }

        if (toolName === "read_kramdown") {
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

        if (toolName === "search_blocks") {
            const r = await ctx.kernel.post("/api/search/fullTextSearchBlock", {
                query: String(args.query ?? ""),
                paths: [],
                page: typeof args.page === "number" ? args.page : 1,
                pageSize: typeof args.pageSize === "number" ? args.pageSize : 16,
                method: typeof args.method === "number" ? args.method : 0,
            });
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }

        if (toolName === "list_child_blocks") {
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

        if (toolName === "get_doc_outline") {
            const id = String(args.id ?? "");
            const r = await ctx.kernel.post("/api/outline/getDocOutline", {id, preview: false});
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }

        if (toolName === "get_backlinks") {
            const id = String(args.id ?? "");
            const r = await ctx.kernel.post("/api/ref/getBacklink", {
                id,
                k: String(args.keyword ?? ""),
                mk: "",
                containChildren: args.contain_children === true,
            });
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }

        if (toolName === "get_block_attributes") {
            const r = await ctx.kernel.post("/api/attr/getBlockAttrs", {id: String(args.id ?? "")});
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }

        if (toolName === "get_recent_docs") {
            const limit = typeof args.limit === "number" ? args.limit : 20;
            const r = await ctx.kernel.post("/api/query/sql", {
                stmt: `SELECT b.id, b.content, b.hpath, b.updated FROM blocks b WHERE b.type='d' ORDER BY b.updated DESC LIMIT ${limit}`,
                mode: "readonly",
            });
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }

        if (toolName === "get_focused_editor") {
            const snap = await captureEditorContext(ctx.kernel);
            const summary = formatEditorContextForPrompt(snap);
            const body = snap.selectedText?.trim()
                ? `${summary}\n\n选区文本：\n${snap.selectedText}`
                : summary;
            return {
                text: wrapToolJson({
                    rootId: snap.rootId ?? null,
                    rootTitle: snap.rootTitle ?? null,
                    focusedBlockId: snap.focusedBlockId ?? null,
                    notebookId: snap.notebookId ?? null,
                    path: snap.path ?? null,
                    hasSelection: !!(snap.selectedText?.trim()),
                }, body || "（无打开的编辑器焦点）"),
                ok: true,
            };
        }

        if (toolName === "list_notebooks") {
            const r = await ctx.kernel.post("/api/notebook/lsNotebooks", {});
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }

        if (toolName === "list_documents") {
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
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }

        if (toolName === "open_document") {
            const id = String(args.id ?? "");
            const highlight = args.highlight === true;
            const fold = await getBlockFoldInfo(ctx.kernel, id);
            openTab({
                app: ctx.plugin.app,
                doc: {
                    id,
                    action: buildOpenDocumentAction(highlight, fold),
                },
            });
            return {text: JSON.stringify({ok: true, id, highlight, ...fold}), ok: true};
        }

        if (toolName === "focus_block") {
            const id = String(args.id ?? "");
            const fold = await getBlockFoldInfo(ctx.kernel, id);
            await navigateToBlockRef({app: ctx.plugin.app, kernel: ctx.kernel, blockId: id});
            return {text: JSON.stringify({ok: true, id, ...fold}), ok: true};
        }

        if (toolName === "edit_document") {
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

            const diffToolId = ctx.toolCallId ?? `edit:${docId}`;
            ctx.onToolUiHint?.("请在下方 diff 预览中选择「应用」或「拒绝」");

            const accepted = await ctx.showDiffPreview(
                renderDiffHtml(diff),
                `文档编辑预览 · ${title ?? docId}`,
                diffToolId,
            );
            if (!accepted) {
                return {
                    text: JSON.stringify({doc_id: docId, applied: false, reason: "not_executed"}),
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

        if (toolName === "create_document") {
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

        if (toolName === "rename_document") {
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
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }

        if (toolName === "delete_document") {
            const id = String(args.id ?? "");
            const ws = await gateWorkset(ctx, id);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const ref = await ctx.kernel.post("/api/block/checkBlockRef", {ids: [id]});
            const hasRef = ref.code === 0 && ref.data === true;
            const gate = await gateConfirm(
                ctx,
                toolName,
                args,
                `删除整篇文档 ${id}${hasRef ? "（有引用）" : ""}`,
            );
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/filetree/removeDocByID", {id});
            return {text: JSON.stringify({...r, hadRefs: hasRef}), ok: r.code === 0};
        }

        if (toolName === "set_block_attributes") {
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
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }

        if (toolName === "append_markdown") {
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
            return {
                text: compactKernelResponseTruncated(r),
                ok: r.code === 0,
                riskScore: gate.riskScore,
                autoApproved: gate.autoApproved,
            };
        }

        if (toolName === "insert_markdown") {
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
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }

        if (toolName === "update_markdown") {
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
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }

        if (toolName === "edit_block_kramdown") {
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

        if (toolName === "batch_update_markdown") {
            const parsed = parseBatchUpdates(args);
            if ("error" in parsed) {
                return {text: JSON.stringify({error: parsed.error}), ok: false};
            }
            const ids = parsed.map((u) => u.id);
            const ws = await gateWorksetMany(ctx.kernel, ids, ctx.worksetNotebookIds);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            for (const id of ids) {
                if (await isDocumentRootBlock(ctx.kernel, id)) {
                    return {
                        text: JSON.stringify({
                            error: `refuse document root block ${id}: use edit_document or block-level ops`,
                        }),
                        ok: false,
                    };
                }
            }
            const gate = await gateConfirm(
                ctx,
                toolName,
                args,
                `批量更新 ${parsed.length} 块：${summarizeBatchIds(ids)}`,
            );
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/batchUpdateBlock", {
                blocks: parsed.map((u) => ({
                    id: u.id,
                    dataType: "markdown",
                    data: u.markdown,
                })),
            });
            return {
                text: JSON.stringify({count: parsed.length, ids, kernel: r}),
                ok: r.code === 0,
                riskScore: gate.riskScore,
                autoApproved: gate.autoApproved,
            };
        }

        if (toolName === "batch_insert_markdown") {
            const parsed = parseBatchInserts(args);
            if ("error" in parsed) {
                return {text: JSON.stringify({error: parsed.error}), ok: false};
            }
            const anchorIds = parsed.map((i) => i.parent_id ?? i.previous_id ?? i.next_id ?? "");
            const ws = await gateWorksetMany(ctx.kernel, anchorIds, ctx.worksetNotebookIds);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const gate = await gateConfirm(
                ctx,
                toolName,
                args,
                `批量插入 ${parsed.length} 处（约 ${totalMarkdownChars(parsed)} 字符）`,
            );
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/batchInsertBlock", {
                blocks: parsed.map((i) => ({
                    dataType: "markdown",
                    data: i.markdown,
                    parentID: i.parent_id ?? "",
                    previousID: i.previous_id ?? "",
                    nextID: i.next_id ?? "",
                })),
            });
            return {
                text: JSON.stringify({count: parsed.length, kernel: r}),
                ok: r.code === 0,
                riskScore: gate.riskScore,
                autoApproved: gate.autoApproved,
            };
        }

        if (toolName === "batch_append_markdown") {
            const parsed = parseBatchAppends(args);
            if ("error" in parsed) {
                return {text: JSON.stringify({error: parsed.error}), ok: false};
            }
            const parentIds = parsed.map((a) => a.parent_id);
            const ws = await gateWorksetMany(ctx.kernel, parentIds, ctx.worksetNotebookIds);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const gate = await gateConfirm(
                ctx,
                toolName,
                args,
                `批量追加 ${parsed.length} 处 → ${summarizeBatchIds(parentIds)}`,
            );
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/block/batchAppendBlock", {
                blocks: parsed.map((a) => ({
                    parentID: a.parent_id,
                    dataType: "markdown",
                    data: a.markdown,
                })),
            });
            return {
                text: JSON.stringify({count: parsed.length, parentIds, kernel: r}),
                ok: r.code === 0,
                riskScore: gate.riskScore,
                autoApproved: gate.autoApproved,
            };
        }

        if (toolName === "batch_delete_blocks") {
            const parsed = parseBatchDeleteIds(args);
            if ("error" in parsed) {
                return {text: JSON.stringify({error: parsed.error}), ok: false};
            }
            const ws = await gateWorksetMany(ctx.kernel, parsed, ctx.worksetNotebookIds);
            if (ws) {
                return {text: JSON.stringify({error: ws}), ok: false};
            }
            const ref = await ctx.kernel.post("/api/block/checkBlockRef", {ids: parsed});
            const hasRef = ref.code === 0 && ref.data === true;
            const gate = await gateConfirm(
                ctx,
                toolName,
                args,
                `批量删除 ${parsed.length} 块：${summarizeBatchIds(parsed)}${hasRef ? "（部分有引用）" : ""}`,
            );
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const results: {id: string; code: number; msg?: string}[] = [];
            let ok = true;
            for (const id of parsed) {
                const r = await ctx.kernel.post("/api/block/deleteBlock", {id});
                results.push({id, code: r.code, msg: r.msg});
                if (r.code !== 0) {
                    ok = false;
                }
            }
            return {
                text: JSON.stringify({count: parsed.length, hadRefs: hasRef, results}),
                ok,
                riskScore: gate.riskScore,
                autoApproved: gate.autoApproved,
            };
        }

        if (toolName === "delete_block") {
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

        if (toolName === "move_block") {
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
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }

        if (toolName === "sql_query") {
            const stmt = String(args.stmt ?? "");
            if (!stmt || !SQL_READONLY.test(stmt.trim()) || /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(stmt)) {
                return {text: JSON.stringify({error: "仅允许只读 SQL"}), ok: false};
            }
            const gate = await gateConfirm(ctx, toolName, args, stmt.slice(0, 800));
            if (!gate.proceed) {
                return {text: JSON.stringify({error: "user_cancelled"}), ok: false};
            }
            const r = await ctx.kernel.post("/api/query/sql", {stmt, mode: "readonly"});
            return {text: compactKernelResponseTruncated(r), ok: r.code === 0};
        }
    } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        agentBus.emit(AgentEvents.TOOL_END, {name: toolName, ok: false});
        return {text: JSON.stringify({error: err}), ok: false};
    }

    agentBus.emit(AgentEvents.TOOL_END, {name: toolName, ok: true});
    return {text: JSON.stringify({error: "unhandled"}), ok: false};
}
