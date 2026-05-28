import type Agent from "../index";
import type {AgentMode} from "../agent/modes";
import {buildModeSystemPrompt} from "../agent/prompts/system";
import type {AuditEvent, DeepSeekConfig, KernelExecutor} from "../agent/types";
import type {ContextAttachment} from "../context/types";
import {Agent} from "./agent/agent";
import {createDeepSeekStreamFn} from "./agent/deepseekStream";
import {agentToChat, chatToAgent, convertToLlm, userMessage} from "./agent/messages";
import type {AgentEvent, AgentMessage, AssistantAgentMessage, ThinkingLevel} from "./agent/types";
import {createSiyuanAgentTools, type AgentToolsContext} from "../tools/agentTools";
import {getToolByName, getToolDefinitionsForMode} from "../tools/registry";
import {assessToolRisk, formatRiskSummary} from "../tools/riskPolicy";
import type {ChatMessage} from "../agent/types";

export interface CreateAgentSessionOptions {
    plugin: Agent;
    kernel: KernelExecutor;
    mode: AgentMode;
    llm: DeepSeekConfig;
    thinkingLevel?: ThinkingLevel;
    messages?: ChatMessage[];
    customInstructions?: string;
    editorContext?: string;
    attachments?: ContextAttachment[];
    worksetNotebookIds?: string[];
    riskAutoApproveMax?: number;
    requestConfirm: (title: string, detail: string) => Promise<boolean>;
    showDiffPreview?: (html: string, title: string) => Promise<boolean>;
    onAudit: (e: AuditEvent) => void;
    onAgentEvent?: (event: AgentEvent) => void;
    onToolUiHint?: (toolCallId: string, hint: string) => void;
}

export interface AgentSession {
    agent: Agent;
    prompt: (text: string, signal?: AbortSignal) => Promise<AgentRunOutcome>;
    abort: () => void;
    getMessages: () => ChatMessage[];
    syncFromChat: (messages: ChatMessage[]) => void;
}

export type AgentRunOutcome =
    | {kind: "completed"}
    | {kind: "stopped"; reason: "aborted" | "error"; message?: string}
    | {kind: "unexpected_error"; message: string};

/**
 * SDK 嵌入模式：编程式创建 Agent 会话。
 * 对齐 pi-coding-agent 的 createAgentSession 架构。
 */
export function createAgentSession(options: CreateAgentSessionOptions): AgentSession {
    const thinkingLevel = options.thinkingLevel ?? "high";
    const systemPrompt = buildModeSystemPrompt(options.mode, {
        customInstructions: options.customInstructions,
        editorContext: options.editorContext,
        attachments: options.attachments,
        worksetNotebooks: options.worksetNotebookIds,
    });

    const toolCtx: AgentToolsContext = {
        plugin: options.plugin,
        kernel: options.kernel,
        mode: options.mode,
        onAudit: options.onAudit,
        requestConfirm: options.requestConfirm,
        showDiffPreview: options.showDiffPreview,
        worksetNotebookIds: options.worksetNotebookIds ?? [],
        riskAutoApproveMax: options.riskAutoApproveMax ?? 35,
        onToolUiHint: options.onToolUiHint,
    };

    const toolDefs = getToolDefinitionsForMode(options.mode);
    const llmWithTools = {...options.llm, tools: toolDefs};

    const agent = new Agent({
        initialState: {
            systemPrompt,
            llm: llmWithTools,
            thinkingLevel,
            tools: createSiyuanAgentTools(toolCtx),
            messages: options.messages ? chatToAgent(options.messages) : [],
        },
        streamFn: createDeepSeekStreamFn(thinkingLevel),
        convertToLlm,
        beforeToolCall: async (ctx, signal) => {
            const def = getToolByName(ctx.toolCall.name);
            if (!def) {
                return {block: true, reason: `未知工具：${ctx.toolCall.name}`};
            }
            const risk = assessToolRisk(def, ctx.args as Record<string, unknown>, toolCtx.riskAutoApproveMax);
            if (risk.autoApprove) {
                return undefined;
            }
            options.onAudit({
                kind: "tool_confirm_required",
                name: ctx.toolCall.name,
                detail: JSON.stringify(ctx.args).slice(0, 400),
                riskScore: risk.score,
            });
            const approved = await options.requestConfirm(
                `Agent · ${ctx.toolCall.name}`,
                `${formatRiskSummary(risk)}\n\n${JSON.stringify(ctx.args, null, 2).slice(0, 800)}`,
            );
            options.onAudit({kind: "tool_confirm_result", name: ctx.toolCall.name, approved});
            if (signal?.aborted) {
                return {block: true, reason: "操作已取消"};
            }
            if (!approved) {
                return {block: true, reason: "用户拒绝执行"};
            }
            return undefined;
        },
        toolExecution: "parallel",
    });

    let activeAbort: AbortController | null = null;

    agent.subscribe(async (event) => {
        if (event.type === "tool_execution_start") {
            options.onAudit({
                kind: "tool_call",
                toolCallId: event.toolCallId,
                name: event.toolName,
                argsPreview: JSON.stringify(event.args).slice(0, 400),
            });
        } else if (event.type === "tool_execution_end") {
            options.onAudit({
                kind: "tool_result",
                toolCallId: event.toolCallId,
                name: event.toolName,
                ok: !event.isError,
                durationMs: 0,
                error: event.isError ? "tool_failed" : undefined,
            });
        }
        options.onAgentEvent?.(event);
        applyToolUiFromEvent(event);
    });

    function applyToolUiFromEvent(event: AgentEvent): void {
        if (event.type === "tool_execution_start") {
            const asst = findLatestAssistant(agent.state.messages);
            if (asst) {
                asst._toolStatus = {...(asst._toolStatus ?? {}), [event.toolCallId]: "running"};
            }
        } else if (event.type === "tool_execution_end") {
            const asst = findLatestAssistant(agent.state.messages);
            if (asst) {
                const text = event.result.content.map((c) => c.text).join("\n");
                asst._toolResults = {...(asst._toolResults ?? {}), [event.toolCallId]: text};
                asst._toolStatus = {
                    ...(asst._toolStatus ?? {}),
                    [event.toolCallId]: event.isError ? "fail" : "ok",
                };
                if (asst._toolHint) {
                    delete asst._toolHint[event.toolCallId];
                }
            }
        } else if (event.type === "message_update" || event.type === "message_end") {
            if (event.message.role === "assistant") {
                syncStreamingAssistant(event.message);
            }
        }
    }

    function findLatestAssistant(messages: AgentMessage[]): AssistantAgentMessage | undefined {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role === "assistant") {
                return m;
            }
        }
        return agent.state.streamingMessage?.role === "assistant"
            ? (agent.state.streamingMessage as AssistantAgentMessage)
            : undefined;
    }

    function syncStreamingAssistant(msg: AssistantAgentMessage): void {
        const streaming = agent.state.streamingMessage;
        if (streaming?.role === "assistant") {
            Object.assign(streaming, msg);
        }
    }

    if (options.onToolUiHint) {
        const origHint = options.onToolUiHint;
        toolCtx.onToolUiHint = (toolCallId, hint) => {
            const asst = findLatestAssistant(agent.state.messages);
            if (asst) {
                asst._toolHint = {...(asst._toolHint ?? {}), [toolCallId]: hint};
            }
            origHint(toolCallId, hint);
        };
    }

    return {
        agent,
        getMessages: () => agentToChat(agent.state.messages),
        syncFromChat: (messages) => {
            agent.state.messages = chatToAgent(messages);
        },
        abort: () => {
            activeAbort?.abort();
            agent.abort();
        },
        prompt: async (text, signal) => {
            if (agent.state.isStreaming) {
                return {kind: "unexpected_error", message: "Agent 正在运行中"};
            }
            options.onAudit({kind: "user_message", preview: text.slice(0, 200)});

            activeAbort = new AbortController();
            if (signal) {
                signal.addEventListener("abort", () => activeAbort?.abort(), {once: true});
            }

            agent.state.systemPrompt = buildModeSystemPrompt(options.mode, {
                customInstructions: options.customInstructions,
                editorContext: options.editorContext,
                attachments: options.attachments,
                worksetNotebooks: options.worksetNotebookIds,
            });
            agent.state.llm = llmWithTools;
            agent.state.tools = createSiyuanAgentTools(toolCtx);

            const tReq = performance.now();
            options.onAudit({
                kind: "llm_request",
                model: options.llm.model,
                messageCount: agent.state.messages.length + 1,
                toolCount: agent.state.tools.length,
            });

            try {
                await agent.prompt(userMessage(text));

                const lastAsst = findLatestAssistant(agent.state.messages);
                if (lastAsst?.stopReason === "aborted") {
                    return {kind: "stopped", reason: "aborted"};
                }
                if (lastAsst?.stopReason === "error") {
                    return {kind: "stopped", reason: "error", message: lastAsst.errorMessage};
                }

                options.onAudit({
                    kind: "llm_response",
                    durationMs: Math.round(performance.now() - tReq),
                    finishReason: lastAsst?.tool_calls?.length ? "tool_calls" : "stop",
                });

                return {kind: "completed"};
            } catch (e) {
                return {kind: "unexpected_error", message: e instanceof Error ? e.message : String(e)};
            } finally {
                activeAbort = null;
            }
        },
    };
}
