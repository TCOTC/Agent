import {runBuiltinTool} from "./builtinTools";
import {confirmPromise} from "./confirmUtil";
import {createFetchSyncKernelExecutor} from "./kernelExecutor";
import {openAIChatCompletion, type ChatCompletionStreamSnapshot} from "./openaiClient";
import type {
    AuditEvent,
    ChatMessage,
    KernelExecutor,
    OpenAICompatibleConfig,
} from "./types";

export interface RunAgentLoopParams {
    kernel?: KernelExecutor;
    llm: OpenAICompatibleConfig;
    allowSqlTool: boolean;
    worksetRootIds: Set<string>;
    /** 已有对话（会被原地追加） */
    messages: ChatMessage[];
    userText: string;
    signal: AbortSignal;
    onAudit: (e: AuditEvent) => void;
    /** 模型流式增量输出时调用（由 UI 侧节流渲染） */
    onStreamDelta?: () => void;
    systemExtra?: string;
}

function buildSystemPrompt(worksetIds: string[], extra?: string): string {
    const ws = worksetIds.length ? worksetIds.join(", ") : "（空）";
    const base = `你是思源笔记（SiYuan）助手。用户已通过「工作集」显式授权以下文档根 ID：${ws}。\n` +
        "规则：\n" +
        "1. 仅使用工具访问上述工作集内的块或文档；不要假设未授权 ID 可读。\n" +
        "2. 写入前用户会在客户端二次确认；若用户拒绝，应友好说明。\n" +
        "3. 回答简洁，必要时先用只读工具收集上下文。\n";
    return extra ? `${base}\n${extra}` : base;
}

export async function runAgentLoop(p: RunAgentLoopParams): Promise<void> {
    const kernel = p.kernel ?? createFetchSyncKernelExecutor();
    const worksetList = [...p.worksetRootIds];

    p.onAudit({kind: "user_message", preview: p.userText.slice(0, 200)});
    p.messages.push({role: "user", content: p.userText});

    const systemContent = buildSystemPrompt(worksetList, p.systemExtra);
    const convo: ChatMessage[] = [{role: "system", content: systemContent}, ...p.messages];

    // 无工具轮数上限；由用户在 UI 触发 Abort（传入的 signal）中止。
    for (;;) {
        if (p.signal.aborted) {
            throw new Error("aborted");
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

        let result;
        try {
            result = await openAIChatCompletion(
                p.llm,
                convo,
                p.allowSqlTool,
                p.signal,
                applyStream,
            );
        } catch (e) {
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
            throw e;
        }

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
            return;
        }

        const ctxExec = {
            kernel,
            worksetRootIds: p.worksetRootIds,
            allowSqlTool: p.allowSqlTool,
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
                text = await runBuiltinTool(ctxExec, name, args);
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
