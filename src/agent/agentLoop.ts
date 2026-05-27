import {createFetchSyncKernelExecutor} from "./kernelExecutor";
import {
    deepseekChatCompletion,
    type AgentLlmFailure,
    type ChatCompletionStreamSnapshot,
} from "./deepseekClient";
import {getToolDefinitionsForMode} from "../tools/registry";
import {runTool, type ToolRunContext} from "../tools/executor";
import type Agent from "../index";
import type {AgentMode} from "./modes";
import {buildModeSystemPrompt} from "./prompts/system";
import {agentBus, AgentEvents} from "../core/eventBus";
import type {AuditEvent, ChatMessage, DeepSeekConfig, KernelExecutor} from "./types";
import type {ContextAttachment} from "../context/types";

export interface RunAgentLoopParams {
    plugin: Agent;
    kernel?: KernelExecutor;
    llm: DeepSeekConfig;
    mode: AgentMode;
    messages: ChatMessage[];
    userText: string;
    signal: AbortSignal;
    onAudit: (e: AuditEvent) => void;
    onStreamDelta?: () => void;
    customInstructions?: string;
    editorContext?: string;
    attachments?: ContextAttachment[];
    worksetNotebookIds?: string[];
    riskAutoApproveMax?: number;
    requestConfirm: (title: string, detail: string) => Promise<boolean>;
    showDiffPreview?: (html: string, title: string) => Promise<boolean>;
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
    const toolDefs = getToolDefinitionsForMode(p.mode);

    p.onAudit({kind: "user_message", preview: p.userText.slice(0, 200)});
    p.messages.push({role: "user", content: p.userText});

    const systemContent = buildModeSystemPrompt(p.mode, {
        customInstructions: p.customInstructions,
        editorContext: p.editorContext,
        attachments: p.attachments,
        worksetNotebooks: p.worksetNotebookIds,
    });

    const convo: ChatMessage[] = [{role: "system", content: systemContent}, ...p.messages];

    const toolCtx: ToolRunContext = {
        kernel,
        plugin: p.plugin,
        onAudit: p.onAudit,
        requestConfirm: p.requestConfirm,
        worksetNotebookIds: p.worksetNotebookIds ?? [],
        riskAutoApproveMax: p.riskAutoApproveMax ?? 35,
        showDiffPreview: p.showDiffPreview,
    };

    const llm: DeepSeekConfig = {...p.llm, tools: toolDefs};

    for (;;) {
        if (p.signal.aborted) {
            return {kind: "stopped", reason: {kind: "aborted"}};
        }
        const tReq = performance.now();
        p.onAudit({
            kind: "llm_request",
            model: llm.model,
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
            agentBus.emit(AgentEvents.STREAM_DELTA);
            p.onStreamDelta?.();
        };

        const completion = await deepseekChatCompletion(llm, convo, p.signal, applyStream);
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

        asst._toolStatus = asst._toolStatus ?? {};
        for (const tc of toolCalls) {
            asst._toolStatus[tc.id] = "running";
            agentBus.emit(AgentEvents.MESSAGES_RENDER);

            const name = tc.function.name;
            const args = tc.function.arguments ?? "{}";
            p.onAudit({kind: "tool_call", toolCallId: tc.id, name, argsPreview: args.slice(0, 400)});
            const t0 = performance.now();
            const run = await runTool(toolCtx, name, args);
            asst._toolStatus[tc.id] = run.ok ? "ok" : "fail";
            agentBus.emit(AgentEvents.TOOL_END, {name, ok: run.ok});
            agentBus.emit(AgentEvents.MESSAGES_RENDER);

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
            convo.push({role: "tool", tool_call_id: tc.id, content: run.text});
            p.messages.push({role: "tool", tool_call_id: tc.id, content: run.text});
        }
    }
}
