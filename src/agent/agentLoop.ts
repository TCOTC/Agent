import type Agent from "../index";
import {createFetchSyncKernelExecutor} from "./kernelExecutor";
import type {AgentLlmFailure} from "./deepseekClient";
import type {AgentMode} from "./modes";
import type {AuditEvent, ChatMessage, DeepSeekConfig, KernelExecutor, ToolConfirmRequest} from "./types";
import type {ContextAttachment} from "../context/types";
import {createAgentSession, type AgentRunOutcome} from "../core/sdk";
import {syncChatMessagesFromAgent} from "./messageSync";
import {agentBus, AgentEvents} from "../core/eventBus";
import type {ThinkingLevel} from "../core/agent/types";

export interface RunAgentLoopParams {
    plugin: Agent;
    /** 所属聊天会话 id，用于多 run 并行时定位 Agent 实例 */
    sessionId: string;
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
    getRiskAutoApproveMax?: () => number;
    requestConfirm: (req: ToolConfirmRequest) => Promise<boolean>;
    showDiffPreview?: (html: string, title: string, toolCallId: string) => Promise<boolean>;
    /** createAgentSession 完成后回调，供 UI 按会话 id 绑定独立 abort */
    onRunReady?: (handles: {abort: () => void}) => void;
}

export type RunAgentLoopOutcome =
    | {kind: "completed"}
    | {kind: "stopped"; reason: AgentLlmFailure}
    | {kind: "unexpected_error"; message: string};

import type {AssistantMessageEvent} from "../core/agent/types";

type AgentSdkSession = ReturnType<typeof createAgentSession>;

const agentSessionsById = new Map<string, AgentSdkSession>();

function applyMdStreamingFlag(
    messages: ChatMessage[],
    committedLen: number,
    sub: AssistantMessageEvent["type"],
): void {
    const row = messages[committedLen];
    if (!row || row.role !== "assistant") {
        return;
    }
    if (sub === "thinking_start") {
        row._mdStreaming = true;
        row._thinkingMdOpen = true;
        return;
    }
    if (sub === "thinking_delta") {
        row._mdStreaming = true;
        return;
    }
    if (sub === "thinking_end") {
        row._thinkingMdOpen = false;
    }
    if (
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

/** 指定会话的 Agent SDK 实例（多 run 并行时按 sessionId 查询） */
export function getAgentSession(sessionId: string): AgentSdkSession | null {
    return agentSessionsById.get(sessionId) ?? null;
}

/**
 * 兼容旧调用：传入 sessionId 时精确查找；未传且仅有一个 run 时返回该实例。
 */
export function getActiveAgentSession(sessionId?: string): AgentSdkSession | null {
    if (sessionId) {
        return getAgentSession(sessionId);
    }
    if (agentSessionsById.size === 1) {
        return agentSessionsById.values().next().value ?? null;
    }
    return null;
}

/** 卸载或重置时中止所有运行中的 Agent */
export function abortAllAgentSessions(): void {
    for (const session of agentSessionsById.values()) {
        session.abort();
    }
    agentSessionsById.clear();
}

/**
 * 兼容层：保留 runAgentLoop 入口，内部走 pi 式 SDK + 事件驱动循环。
 */
export async function runAgentLoop(p: RunAgentLoopParams): Promise<RunAgentLoopOutcome> {
    try {
        const kernel = p.kernel ?? createFetchSyncKernelExecutor();
        const thinkingLevel: ThinkingLevel = p.llm.thinkingEnabled === false ? "off" : "high";

        let session!: AgentSdkSession;

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
            getRiskAutoApproveMax: p.getRiskAutoApproveMax,
            requestConfirm: p.requestConfirm,
            showDiffPreview: p.showDiffPreview,
            onAudit: p.onAudit,
            onConfirmUiChange: () => {
                syncMessages();
                p.onMessagesChanged?.();
            },
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

        p.onRunReady?.({abort: () => session.abort()});

        agentSessionsById.set(p.sessionId, session);
        try {
            const outcome = await session.prompt(p.userText, p.signal);

            syncMessages();

            return mapOutcome(outcome);
        } finally {
            agentSessionsById.delete(p.sessionId);
        }
    } catch (e) {
        return {kind: "unexpected_error", message: e instanceof Error ? e.message : String(e)};
    }
}
