import {runBuiltinTool} from "./builtinTools";
import {confirmPromise} from "./confirmUtil";
import {createFetchSyncKernelExecutor} from "./kernelExecutor";
import {openAIChatCompletion} from "./openaiClient";
import type {
    AuditEvent,
    ChatMessage,
    KernelExecutor,
    OpenAICompatibleConfig,
} from "./types";

const MAX_TOOL_ROUNDS = 10;

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

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
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
        const result = await openAIChatCompletion(p.llm, convo, p.allowSqlTool, p.signal);
        p.onAudit({
            kind: "llm_response",
            durationMs: Math.round(performance.now() - tReq),
            finish_reason: result.finish_reason,
            usage: result.usage,
        });

        const msg = result.message;
        const toolCalls = msg.tool_calls;
        const reasoningContent = msg.reasoning_content;
        if (!toolCalls?.length) {
            const done: ChatMessage = {
                role: "assistant",
                content: msg.content ?? "",
            };
            if (reasoningContent !== undefined) {
                done.reasoning_content = reasoningContent;
            }
            p.messages.push(done);
            return;
        }

        const assistantMsg: ChatMessage = {
            role: "assistant",
            content: msg.content,
            tool_calls: toolCalls,
        };
        if (reasoningContent !== undefined) {
            assistantMsg.reasoning_content = reasoningContent;
        }
        convo.push(assistantMsg);
        p.messages.push(assistantMsg);

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
    p.messages.push({
        role: "assistant",
        content: "已达到工具调用轮数上限，请精简任务或分步重试。",
    });
}
