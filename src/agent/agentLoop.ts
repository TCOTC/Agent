import {createFetchSyncKernelExecutor} from "./kernelExecutor";
import {
    deepseekChatCompletion,
    type AgentLlmFailure,
    type ChatCompletionStreamSnapshot,
} from "./deepseekClient";
import {getToolDefinitions} from "../tools/definitions";
import {runTool, type ToolRunContext} from "../tools/executor";
import type Agent from "../index";
import type {AuditEvent, ChatMessage, DeepSeekConfig, KernelExecutor} from "./types";

export interface RunAgentLoopParams {
    plugin: Agent;
    kernel?: KernelExecutor;
    llm: DeepSeekConfig;
    messages: ChatMessage[];
    userText: string;
    signal: AbortSignal;
    onAudit: (e: AuditEvent) => void;
    onStreamDelta?: () => void;
    systemExtra?: string;
    requestConfirm: (title: string, detail: string) => Promise<boolean>;
}

function buildSystemPrompt(extra?: string): string {
    const base =
        "你是思源笔记（SiYuan）专业 Agent 助手，运行在用户本地工作空间中。\n\n" +
        "## 能力\n" +
        "- 使用工具读取/搜索文档（优先 siyuan_read_markdown 理解全文；需要保留块 ID 或精确结构时用 siyuan_read_kramdown）。\n" +
        "- 简单追加用 siyuan_append_markdown；改单块文本用 siyuan_update_markdown；涉及块 ID、引用、容器结构时用 siyuan_edit_block_kramdown。\n" +
        "- 打开文档 siyuan_open_document；定位块 siyuan_focus_block。\n" +
        "- 删除、移动块前评估影响；SQL 仅只读。\n\n" +
        "## 原则\n" +
        "1. 先读后写，避免猜测文档内容。\n" +
        "2. 回答简洁专业，使用中文。\n" +
        "3. 低风险写入会自动执行；高风险操作会请求用户确认。\n" +
        "4. 编辑时尽量保持块 ID 稳定，避免破坏双向链接与块引用。\n";
    return extra ? `${base}\n${extra}` : base;
}

export type RunAgentLoopOutcome =
    | {kind: "completed"}
    | {kind: "stopped"; reason: AgentLlmFailure}
    | {kind: "unexpected_error"; message: string};

export async function runAgentLoop(p: RunAgentLoopParams): Promise<RunAgentLoopOutcome> {
    try {
        return await runAgentLoopInner(p);
    } catch (e) {
        return {kind: "unexpected_error", message: e instanceof Error ? e.message : String(e)};
    }
}

async function runAgentLoopInner(p: RunAgentLoopParams): Promise<RunAgentLoopOutcome> {
    const kernel = p.kernel ?? createFetchSyncKernelExecutor();
    const toolDefs = getToolDefinitions();

    p.onAudit({kind: "user_message", preview: p.userText.slice(0, 200)});
    p.messages.push({role: "user", content: p.userText});

    const convo: ChatMessage[] = [
        {role: "system", content: buildSystemPrompt(p.systemExtra)},
        ...p.messages,
    ];

    const toolCtx: ToolRunContext = {
        kernel,
        plugin: p.plugin,
        onAudit: p.onAudit,
        requestConfirm: p.requestConfirm,
    };

    for (;;) {
        if (p.signal.aborted) {
            return {kind: "stopped", reason: {kind: "aborted"}};
        }
        const tReq = performance.now();
        p.onAudit({
            kind: "llm_request",
            model: p.llm.model,
            messageCount: convo.length,
            toolCount: toolDefs.length,
        });

        const asst: ChatMessage = {role: "assistant", content: ""};
        p.messages.push(asst);
        convo.push(asst);

        const applyStream = (snap: ChatCompletionStreamSnapshot) => {
            asst.content = snap.content;
            if (snap.reasoning_content !== undefined) {
                asst.reasoning_content = snap.reasoning_content;
            }
            if (snap.tool_calls?.length) {
                asst.tool_calls = snap.tool_calls;
            } else {
                delete asst.tool_calls;
            }
            p.onStreamDelta?.();
        };

        const completion = await deepseekChatCompletion(p.llm, convo, p.signal, applyStream);
        if (completion.ok === false) {
            const empty =
                (!asst.content || asst.content === "") &&
                !asst.tool_calls?.length &&
                (asst.reasoning_content == null || asst.reasoning_content === "");
            if (empty && p.messages[p.messages.length - 1] === asst) {
                p.messages.pop();
                if (convo[convo.length - 1] === asst) {
                    convo.pop();
                }
            }
            return {kind: "stopped", reason: completion.failure};
        }
        const result = completion.result;
        const msg = result.message;
        asst.content = msg.content ?? "";
        if (msg.reasoning_content !== undefined) {
            asst.reasoning_content = msg.reasoning_content;
        }
        if (msg.tool_calls?.length) {
            asst.tool_calls = msg.tool_calls;
        } else {
            delete asst.tool_calls;
        }

        p.onAudit({
            kind: "llm_response",
            durationMs: Math.round(performance.now() - tReq),
            finishReason: result.finish_reason,
            usage: result.usage,
        });

        const toolCalls = asst.tool_calls;
        if (!toolCalls?.length) {
            return {kind: "completed"};
        }

        for (const tc of toolCalls) {
            const name = tc.function.name;
            const args = tc.function.arguments ?? "{}";
            p.onAudit({
                kind: "tool_call",
                toolCallId: tc.id,
                name,
                argsPreview: args.slice(0, 400),
            });
            const t0 = performance.now();
            const run = await runTool(toolCtx, name, args);
            p.onAudit({
                kind: "tool_result",
                toolCallId: tc.id,
                name,
                ok: run.ok,
                durationMs: Math.round(performance.now() - t0),
                error: run.ok ? undefined : "tool_failed",
                riskScore: run.riskScore,
                autoApproved: run.autoApproved,
            });
            const toolMsg: ChatMessage = {
                role: "tool",
                tool_call_id: tc.id,
                content: run.text,
            };
            convo.push(toolMsg);
            p.messages.push(toolMsg);
        }
    }
}
