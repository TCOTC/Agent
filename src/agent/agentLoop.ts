import type Agent from "../index";
import {createFetchSyncKernelExecutor} from "./kernelExecutor";
import type {AgentLlmFailure} from "./deepseekClient";
import type {AgentMode} from "./modes";
import type {AuditEvent, ChatMessage, DeepSeekConfig, KernelExecutor} from "./types";
import type {ContextAttachment} from "../context/types";
import {createAgentSession, type AgentRunOutcome} from "../core/sdk";
import {syncChatMessagesFromAgent} from "./messageSync";
import {agentBus, AgentEvents} from "../core/eventBus";
import type {ThinkingLevel} from "../core/agent/types";

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
    /** 消息列表变更后立即刷新 UI（如用户消息写入后） */
    onMessagesChanged?: () => void;
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

import type {AssistantMessageEvent} from "../core/agent/types";

function applyMdStreamingFlag(
    messages: ChatMessage[],
    committedLen: number,
    sub: AssistantMessageEvent["type"],
): void {
    const row = messages[committedLen];
    if (!row || row.role !== "assistant") {
        return;
    }
    if (
        sub === "thinking_start" ||
        sub === "thinking_delta" ||
        sub === "text_start" ||
        sub === "text_delta"
    ) {
        row._mdStreaming = true;
        return;
    }
    if (
        sub === "thinking_end" ||
        sub === "text_end" ||
        sub === "toolcall_start" ||
        sub === "toolcall_delta" ||
        sub === "toolcall_end" ||
        sub === "done" ||
        sub === "error"
    ) {
        row._mdStreaming = false;
    }
}

function mapOutcome(outcome: AgentRunOutcome): RunAgentLoopOutcome {
    if (outcome.kind === "completed") {
        return {kind: "completed"};
    }
    if (outcome.kind === "unexpected_error") {
        return outcome;
    }
    if (outcome.reason === "aborted") {
        return {kind: "stopped", reason: {kind: "aborted"}};
    }
    return {
        kind: "stopped",
        reason: {kind: "http_error", status: 0, bodySnippet: outcome.message ?? "error"},
    };
}

/**
 * 兼容层：保留 runAgentLoop 入口，内部走 pi 式 SDK + 事件驱动循环。
 */
export async function runAgentLoop(p: RunAgentLoopParams): Promise<RunAgentLoopOutcome> {
    try {
        const kernel = p.kernel ?? createFetchSyncKernelExecutor();
        const thinkingLevel: ThinkingLevel = p.llm.thinkingEnabled === false ? "off" : "high";

        let session!: ReturnType<typeof createAgentSession>;

        const syncMessages = () => {
            syncChatMessagesFromAgent(
                p.messages,
                session.agent.state.messages,
                session.agent.state.streamingMessage,
            );
        };

        session = createAgentSession({
            plugin: p.plugin,
            kernel,
            mode: p.mode,
            llm: p.llm,
            thinkingLevel,
            messages: p.messages,
            customInstructions: p.customInstructions,
            editorContext: p.editorContext,
            attachments: p.attachments,
            worksetNotebookIds: p.worksetNotebookIds,
            riskAutoApproveMax: p.riskAutoApproveMax,
            requestConfirm: p.requestConfirm,
            showDiffPreview: p.showDiffPreview,
            onAudit: p.onAudit,
            onAgentEvent: (event) => {
                agentBus.emit(AgentEvents.AGENT_EVENT, event);
                syncMessages();
                if (event.type === "message_update") {
                    applyMdStreamingFlag(
                        p.messages,
                        session.agent.state.messages.length,
                        event.assistantMessageEvent.type,
                    );
                    p.onStreamDelta?.();
                } else if (
                    event.type === "message_end" ||
                    event.type === "message_start" ||
                    event.type === "tool_execution_start" ||
                    event.type === "tool_execution_update" ||
                    event.type === "tool_execution_end"
                ) {
                    p.onMessagesChanged?.();
                }
            },
            onToolUiHint: () => {
                syncMessages();
                p.onMessagesChanged?.();
            },
        });

        const outcome = await session.prompt(p.userText, p.signal);

        syncMessages();

        return mapOutcome(outcome);
    } catch (e) {
        return {kind: "unexpected_error", message: e instanceof Error ? e.message : String(e)};
    }
}
