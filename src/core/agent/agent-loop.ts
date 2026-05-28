/**
 * Agent 循环：对齐 pi-agent-core 的事件协议与 tool 生命周期。
 * AgentMessage 仅在 LLM 边界通过 convertToLlm 转换。
 */

import type {
    AgentContext,
    AgentEvent,
    AgentLoopConfig,
    AgentMessage,
    AgentTool,
    AgentToolCall,
    AgentToolResult,
    AssistantAgentMessage,
    BeforeToolCallContext,
    ToolResultAgentMessage,
} from "./types";
import {extractToolCalls} from "./types";
import type {StreamFn} from "./types";
import {toolResultMessage} from "./messages";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

export async function runAgentLoop(
    prompts: AgentMessage[],
    context: AgentContext,
    config: AgentLoopConfig,
    emit: AgentEventSink,
    signal?: AbortSignal,
    streamFn?: StreamFn,
): Promise<AgentMessage[]> {
    const newMessages: AgentMessage[] = [...prompts];
    const currentContext: AgentContext = {
        ...context,
        messages: [...context.messages, ...prompts],
    };

    await emit({type: "agent_start"});
    await emit({type: "turn_start"});
    for (const prompt of prompts) {
        await emit({type: "message_start", message: prompt});
        await emit({type: "message_end", message: prompt});
    }

    await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
    return newMessages;
}

export async function runAgentLoopContinue(
    context: AgentContext,
    config: AgentLoopConfig,
    emit: AgentEventSink,
    signal?: AbortSignal,
    streamFn?: StreamFn,
): Promise<AgentMessage[]> {
    if (context.messages.length === 0) {
        throw new Error("Cannot continue: no messages in context");
    }
    const last = context.messages[context.messages.length - 1];
    if (last.role === "assistant") {
        throw new Error("Cannot continue from message role: assistant");
    }

    const newMessages: AgentMessage[] = [];
    await emit({type: "agent_start"});
    await emit({type: "turn_start"});
    await runLoop({...context}, newMessages, config, signal, emit, streamFn);
    return newMessages;
}

async function runLoop(
    currentContext: AgentContext,
    newMessages: AgentMessage[],
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
    emit: AgentEventSink,
    streamFn?: StreamFn,
): Promise<void> {
    let firstTurn = true;
    let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) ?? [];

    while (true) {
        let hasMoreToolCalls = true;

        while (hasMoreToolCalls || pendingMessages.length > 0) {
            if (signal?.aborted) {
                await emit({type: "agent_end", messages: newMessages});
                return;
            }

            if (!firstTurn) {
                await emit({type: "turn_start"});
            } else {
                firstTurn = false;
            }

            if (pendingMessages.length > 0) {
                for (const message of pendingMessages) {
                    await emit({type: "message_start", message});
                    await emit({type: "message_end", message});
                    currentContext.messages.push(message);
                    newMessages.push(message);
                }
                pendingMessages = [];
            }

            const message = await streamAssistantResponse(
                currentContext,
                config,
                signal,
                emit,
                streamFn,
            );
            newMessages.push(message);

            if (message.stopReason === "error" || message.stopReason === "aborted") {
                await emit({type: "turn_end", message, toolResults: []});
                await emit({type: "agent_end", messages: newMessages});
                return;
            }

            const toolCalls = extractToolCalls(message);
            const toolResults: ToolResultAgentMessage[] = [];
            hasMoreToolCalls = false;

            if (toolCalls.length > 0) {
                const batch = await executeToolCalls(currentContext, message, toolCalls, config, signal, emit);
                toolResults.push(...batch.messages);
                hasMoreToolCalls = !batch.terminate;

                for (const result of toolResults) {
                    currentContext.messages.push(result);
                    newMessages.push(result);
                }

                if (signal?.aborted) {
                    await emit({type: "turn_end", message, toolResults});
                    await emit({type: "agent_end", messages: newMessages});
                    return;
                }
            }

            await emit({type: "turn_end", message, toolResults});

            pendingMessages = (await config.getSteeringMessages?.()) ?? [];
        }

        const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
        if (followUpMessages.length > 0) {
            pendingMessages = followUpMessages;
            continue;
        }
        break;
    }

    await emit({type: "agent_end", messages: newMessages});
}

async function streamAssistantResponse(
    context: AgentContext,
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
    emit: AgentEventSink,
    streamFn?: StreamFn,
): Promise<AssistantAgentMessage> {
    let messages = context.messages;
    if (config.transformContext) {
        messages = await config.transformContext(messages, signal);
    }

    const llmMessages = await config.convertToLlm(messages);
    const stream = (streamFn ?? config.streamFn)!;
    const response = stream(
        config.llm,
        {
            systemPrompt: context.systemPrompt,
            messages: llmMessages,
            tools: config.llm.tools,
        },
        signal,
    );

    let partialMessage: AssistantAgentMessage | null = null;
    let addedPartial = false;

    for await (const event of response) {
        switch (event.type) {
            case "start":
                partialMessage = event.partial;
                context.messages.push(partialMessage);
                addedPartial = true;
                await emit({type: "message_start", message: {...partialMessage}});
                break;

            case "text_start":
            case "text_delta":
            case "text_end":
            case "thinking_start":
            case "thinking_delta":
            case "thinking_end":
            case "toolcall_start":
            case "toolcall_delta":
            case "toolcall_end":
                if (partialMessage) {
                    partialMessage = event.partial;
                    context.messages[context.messages.length - 1] = partialMessage;
                    await emit({
                        type: "message_update",
                        assistantMessageEvent: event,
                        message: {...partialMessage},
                    });
                }
                break;

            case "done":
            case "error": {
                const finalMessage = await response.result();
                if (addedPartial) {
                    context.messages[context.messages.length - 1] = finalMessage;
                } else {
                    context.messages.push(finalMessage);
                }
                if (!addedPartial) {
                    await emit({type: "message_start", message: {...finalMessage}});
                }
                await emit({type: "message_end", message: finalMessage});
                return finalMessage;
            }
        }
    }

    const finalMessage = await response.result();
    if (addedPartial) {
        context.messages[context.messages.length - 1] = finalMessage;
    } else {
        context.messages.push(finalMessage);
        await emit({type: "message_start", message: {...finalMessage}});
    }
    await emit({type: "message_end", message: finalMessage});
    return finalMessage;
}

type ExecutedBatch = {messages: ToolResultAgentMessage[]; terminate: boolean};

async function executeToolCalls(
    currentContext: AgentContext,
    assistantMessage: AssistantAgentMessage,
    toolCalls: AgentToolCall[],
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
    emit: AgentEventSink,
): Promise<ExecutedBatch> {
    const hasSequential = toolCalls.some(
        (tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
    );
    if (config.toolExecution === "sequential" || hasSequential) {
        return executeSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
    }
    return executeParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

async function executeSequential(
    currentContext: AgentContext,
    assistantMessage: AssistantAgentMessage,
    toolCalls: AgentToolCall[],
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
    emit: AgentEventSink,
): Promise<ExecutedBatch> {
    const finalized: Array<{toolCall: AgentToolCall; result: AgentToolResult; isError: boolean}> = [];
    const messages: ToolResultAgentMessage[] = [];

    for (const toolCall of toolCalls) {
        await emit({
            type: "tool_execution_start",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.arguments,
        });

        const outcome = await prepareAndExecute(
            currentContext,
            assistantMessage,
            toolCall,
            config,
            signal,
            emit,
        );
        await emitToolExecutionEnd(outcome, emit);
        const msg = createToolResultMessage(outcome);
        await emitToolResultMessage(msg, emit);
        finalized.push(outcome);
        messages.push(msg);

        if (signal?.aborted) {
            break;
        }
    }

    return {messages, terminate: batchShouldTerminate(finalized, signal)};
}

async function executeParallel(
    currentContext: AgentContext,
    assistantMessage: AssistantAgentMessage,
    toolCalls: AgentToolCall[],
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
    emit: AgentEventSink,
): Promise<ExecutedBatch> {
    type Entry =
        | {toolCall: AgentToolCall; result: AgentToolResult; isError: boolean}
        | (() => Promise<{toolCall: AgentToolCall; result: AgentToolResult; isError: boolean}>);

    const entries: Entry[] = [];

    for (const toolCall of toolCalls) {
        await emit({
            type: "tool_execution_start",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.arguments,
        });

        const prep = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
        if (prep.kind === "immediate") {
            await emitToolExecutionEnd(prep.outcome, emit);
            entries.push(prep.outcome);
            if (signal?.aborted) {
                break;
            }
            continue;
        }

        entries.push(async () => {
            const executed = await executePrepared(prep, signal, emit);
            const finalized = await finalizeExecuted(
                currentContext,
                assistantMessage,
                prep,
                executed,
                config,
                signal,
            );
            await emitToolExecutionEnd(finalized, emit);
            return finalized;
        });

        if (signal?.aborted) {
            break;
        }
    }

    const finalized = await Promise.all(
        entries.map((e) => (typeof e === "function" ? e() : Promise.resolve(e))),
    );
    const messages: ToolResultAgentMessage[] = [];
    for (const f of finalized) {
        const msg = createToolResultMessage(f);
        await emitToolResultMessage(msg, emit);
        messages.push(msg);
    }

    return {messages, terminate: batchShouldTerminate(finalized, signal)};
}

type PreparedToolCall = {
    kind: "prepared";
    toolCall: AgentToolCall;
    tool: AgentTool;
    args: unknown;
};

type ImmediateOutcome = {
    kind: "immediate";
    outcome: {toolCall: AgentToolCall; result: AgentToolResult; isError: boolean};
};

async function prepareToolCall(
    currentContext: AgentContext,
    assistantMessage: AssistantAgentMessage,
    toolCall: AgentToolCall,
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateOutcome> {
    const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
    if (!tool) {
        return {
            kind: "immediate",
            outcome: {
                toolCall,
                result: errorResult(`Tool ${toolCall.name} not found`),
                isError: true,
            },
        };
    }

    try {
        if (config.beforeToolCall) {
            const ctx: BeforeToolCallContext = {
                assistantMessage,
                toolCall,
                args: toolCall.arguments,
                context: currentContext,
            };
            const before = await config.beforeToolCall(ctx, signal);
            if (signal?.aborted) {
                return {
                    kind: "immediate",
                    outcome: {
                        toolCall,
                        result: errorResult("操作已取消", {terminate: true}),
                        isError: true,
                    },
                };
            }
            if (before?.block) {
                return {
                    kind: "immediate",
                    outcome: {
                        toolCall,
                        result: errorResult(before.reason ?? "工具执行被阻止", {
                            terminate: signal?.aborted === true,
                        }),
                        isError: true,
                    },
                };
            }
        }

        return {kind: "prepared", toolCall, tool, args: toolCall.arguments};
    } catch (e) {
        return {
            kind: "immediate",
            outcome: {
                toolCall,
                result: errorResult(e instanceof Error ? e.message : String(e)),
                isError: true,
            },
        };
    }
}

async function prepareAndExecute(
    currentContext: AgentContext,
    assistantMessage: AssistantAgentMessage,
    toolCall: AgentToolCall,
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
    emit: AgentEventSink,
): Promise<{toolCall: AgentToolCall; result: AgentToolResult; isError: boolean}> {
    const prep = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
    if (prep.kind === "immediate") {
        return prep.outcome;
    }
    const executed = await executePrepared(prep, signal, emit);
    return finalizeExecuted(currentContext, assistantMessage, prep, executed, config, signal);
}

async function executePrepared(
    prepared: PreparedToolCall,
    signal: AbortSignal | undefined,
    emit: AgentEventSink,
): Promise<{result: AgentToolResult; isError: boolean}> {
    const updates: Promise<void>[] = [];
    try {
        const result = await prepared.tool.execute(
            prepared.toolCall.id,
            prepared.args as never,
            signal,
            (partial) => {
                updates.push(
                    Promise.resolve(
                        emit({
                            type: "tool_execution_update",
                            toolCallId: prepared.toolCall.id,
                            toolName: prepared.toolCall.name,
                            args: prepared.toolCall.arguments,
                            partialResult: partial,
                        }),
                    ),
                );
            },
        );
        await Promise.all(updates);
        return {result, isError: false};
    } catch (e) {
        await Promise.all(updates);
        return {
            result: errorResult(e instanceof Error ? e.message : String(e)),
            isError: true,
        };
    }
}

async function finalizeExecuted(
    currentContext: AgentContext,
    assistantMessage: AssistantAgentMessage,
    prepared: PreparedToolCall,
    executed: {result: AgentToolResult; isError: boolean},
    config: AgentLoopConfig,
    signal: AbortSignal | undefined,
): Promise<{toolCall: AgentToolCall; result: AgentToolResult; isError: boolean}> {
    let result = executed.result;
    let isError = executed.isError;

    if (config.afterToolCall) {
        try {
            const after = await config.afterToolCall(
                {
                    assistantMessage,
                    toolCall: prepared.toolCall,
                    args: prepared.args,
                    result,
                    isError,
                    context: currentContext,
                },
                signal,
            );
            if (after) {
                if (after.content !== undefined) {
                    result = {...result, content: after.content};
                }
                if (after.details !== undefined) {
                    result = {...result, details: after.details};
                }
                if (after.isError !== undefined) {
                    isError = after.isError;
                }
                if (after.terminate !== undefined) {
                    result = {...result, terminate: after.terminate};
                }
            }
        } catch (e) {
            result = errorResult(e instanceof Error ? e.message : String(e));
            isError = true;
        }
    }

    return {toolCall: prepared.toolCall, result, isError};
}

function errorResult(message: string, opts?: {terminate?: boolean}): AgentToolResult {
    return {
        content: [{type: "text", text: message}],
        details: {},
        ...(opts?.terminate ? {terminate: true} : {}),
    };
}

function shouldTerminate(
    finalized: Array<{result: AgentToolResult}>,
): boolean {
    return finalized.length > 0 && finalized.every((f) => f.result.terminate === true);
}

function batchShouldTerminate(
    finalized: Array<{result: AgentToolResult}>,
    signal: AbortSignal | undefined,
): boolean {
    if (signal?.aborted) {
        return true;
    }
    return shouldTerminate(finalized);
}

async function emitToolExecutionEnd(
    finalized: {toolCall: AgentToolCall; result: AgentToolResult; isError: boolean},
    emit: AgentEventSink,
): Promise<void> {
    await emit({
        type: "tool_execution_end",
        toolCallId: finalized.toolCall.id,
        toolName: finalized.toolCall.name,
        result: finalized.result,
        isError: finalized.isError,
    });
}

function createToolResultMessage(finalized: {
    toolCall: AgentToolCall;
    result: AgentToolResult;
    isError: boolean;
}): ToolResultAgentMessage {
    const text = finalized.result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    return toolResultMessage(
        finalized.toolCall.id,
        finalized.toolCall.name,
        text,
        finalized.isError,
    );
}

async function emitToolResultMessage(msg: ToolResultAgentMessage, emit: AgentEventSink): Promise<void> {
    await emit({type: "message_start", message: msg});
    await emit({type: "message_end", message: msg});
}
