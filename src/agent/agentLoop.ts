import {runBuiltinTool} from "./builtinTools";
import {confirmPromise} from "../util";
import {createFetchSyncKernelExecutor} from "./kernelExecutor";
import {
    LLM_DEBUG_PLAIN_CHAT,
    openAIChatCompletion,
    type AgentLlmFailure,
    type ChatCompletionStreamSnapshot,
} from "./openaiClient";
import {
    isBuiltinToolName,
    type AuditEvent,
    type ChatMessage,
    type KernelExecutor,
    type OpenAICompatibleConfig,
} from "./types";

export interface RunAgentLoopParams {
    kernel?: KernelExecutor;
    llm: OpenAICompatibleConfig;
    /** 已有对话（会被原地追加） */
    messages: ChatMessage[];
    userText: string;
    signal: AbortSignal;
    onAudit: (e: AuditEvent) => void;
    /** 模型流式增量输出时调用（由 UI 侧节流渲染） */
    onStreamDelta?: () => void;
    systemExtra?: string;
}

function buildSystemPrompt(extra?: string): string {
    const base =
        "你是思源笔记（SiYuan）助手。只读与写入工具可访问当前工作空间内的块与文档（受内核权限与客户端写入确认约束）。\n" +
        "规则：\n" +
        "1. 写入前用户会在客户端二次确认；若用户拒绝，应友好说明。\n" +
        "2. 回答简洁，必要时先用只读工具收集上下文。\n" +
        "3. siyuan_sql_query 仅用于只读查询（如 SELECT、WITH … SELECT、VALUES、EXPLAIN … SELECT）；不得提交 INSERT、UPDATE、DELETE 等写语句。\n";
    return extra ? `${base}\n${extra}` : base;
}

/** Agent 主循环结束态：正常完成、可预期中止 / LLM 失败、或未捕获异常 */
export type RunAgentLoopOutcome =
    | {kind: "completed"}
    | {kind: "stopped"; reason: AgentLlmFailure}
    | {kind: "unexpected_error"; message: string};

export async function runAgentLoop(p: RunAgentLoopParams): Promise<RunAgentLoopOutcome> {
    try {
        return await runAgentLoopInner(p);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {kind: "unexpected_error", message};
    }
}

async function runAgentLoopInner(p: RunAgentLoopParams): Promise<RunAgentLoopOutcome> {
    const kernel = p.kernel ?? createFetchSyncKernelExecutor();

    p.onAudit({kind: "user_message", preview: p.userText.slice(0, 200)});
    p.messages.push({role: "user", content: p.userText});

    const convo: ChatMessage[] = LLM_DEBUG_PLAIN_CHAT ?
        [...p.messages] :
        [{role: "system", content: buildSystemPrompt(p.systemExtra)}, ...p.messages];

    // 无工具轮数上限；由用户在 UI 触发 Abort（传入的 signal）中止。
    for (;;) {
        if (p.signal.aborted) {
            return {kind: "stopped", reason: {kind: "aborted"}};
        }
        const tReq = performance.now();
        p.onAudit({
            kind: "llm_request",
            model: p.llm.model,
            messageCount: convo.length,
            toolCount: 0,
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

        const completion = await openAIChatCompletion(p.llm, convo, p.signal, applyStream);
        if (completion.ok === false) {
            const noPayload =
                (!asst.content || asst.content === "") &&
                !asst.tool_calls?.length &&
                (asst.reasoning_content == null || asst.reasoning_content === "");
            if (noPayload && p.messages[p.messages.length - 1] === asst) {
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

        const ctxExec = {
            kernel,
            onAudit: p.onAudit,
            confirmWrite: async (detail: string) => {
                return confirmPromise("写入确认", `是否允许以下写入？\n\n${detail}`);
            },
        };

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
            let text: string;
            let ok = true;
            let err: string | undefined;
            try {
                text = isBuiltinToolName(name)
                    ? await runBuiltinTool(ctxExec, name, args)
                    : JSON.stringify({error: `unknown_tool:${name}`});
            } catch (e) {
                ok = false;
                err = e instanceof Error ? e.message : String(e);
                text = JSON.stringify({error: err});
            }
            p.onAudit({
                kind: "tool_result",
                toolCallId: tc.id,
                name,
                ok,
                durationMs: Math.round(performance.now() - t0),
                error: err,
            });
            const toolMsg: ChatMessage = {
                role: "tool",
                tool_call_id: tc.id,
                content: text,
            };
            convo.push(toolMsg);
            p.messages.push(toolMsg);
        }
    }
}
