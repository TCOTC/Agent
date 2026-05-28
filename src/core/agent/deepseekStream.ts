import {
    deepseekChatCompletion,
    type AgentLlmFailure,
    type ChatCompletionStreamSnapshot,
} from "../../agent/deepseekClient";
import type {DeepSeekConfig} from "../../agent/types";
import {DeepSeekAssistantStream} from "./eventStream";
import {assistantMessage} from "./messages";
import type {
    AssistantAgentMessage,
    AssistantMessageEvent,
    DeepSeekStreamContext,
    StreamFn,
    ThinkingLevel,
} from "./types";

function failureToStopReason(f: AgentLlmFailure): {stopReason: "error" | "aborted"; errorMessage: string} {
    if (f.kind === "aborted") {
        return {stopReason: "aborted", errorMessage: "操作已取消"};
    }
    if (f.kind === "http_error") {
        return {stopReason: "error", errorMessage: `HTTP ${f.status}: ${f.bodySnippet.slice(0, 200)}`};
    }
    if (f.kind === "network_error") {
        return {stopReason: "error", errorMessage: f.message};
    }
    return {stopReason: "error", errorMessage: f.kind};
}

function snapshotToAssistant(
    snap: ChatCompletionStreamSnapshot,
    base: AssistantAgentMessage,
): AssistantAgentMessage {
    return {
        ...base,
        content: snap.content,
        reasoning_content: snap.reasoning_content,
        tool_calls: snap.tool_calls,
    };
}

function applyThinkingLevel(cfg: DeepSeekConfig, level: ThinkingLevel): DeepSeekConfig {
    if (level === "off") {
        return {...cfg, thinkingEnabled: false};
    }
    return {
        ...cfg,
        thinkingEnabled: true,
        reasoningEffort: level === "max" ? "max" : "high",
    };
}

/** DeepSeek 专用 StreamFn：将 SSE 增量映射为 pi 式 AssistantMessageEvent */
export function createDeepSeekStreamFn(thinkingLevel: ThinkingLevel): StreamFn {
    return (config, context, signal) => {
        const stream = new DeepSeekAssistantStream();
        const llm = applyThinkingLevel(config, thinkingLevel);
        const base = assistantMessage({content: ""});
        const messages = [{role: "system" as const, content: context.systemPrompt}, ...context.messages];

        void (async () => {
            let prevContent = "";
            let prevReasoning = "";
            let started = false;
            let textStarted = false;
            let thinkStarted = false;
            let toolcallStarted = false;
            let lastPartial: AssistantAgentMessage = {...base};

            const emitPartial = (partial: AssistantAgentMessage, event: AssistantMessageEvent) => {
                lastPartial = partial;
                stream.push(event);
            };

            const completion = await deepseekChatCompletion(
                {...llm, tools: context.tools},
                messages,
                signal ?? new AbortController().signal,
                (snap) => {
                    const partial = snapshotToAssistant(snap, base);

                    if (!started) {
                        started = true;
                        emitPartial(partial, {type: "start", partial: {...partial}});
                    }

                    const contentDelta = snap.content.slice(prevContent.length);
                    if (contentDelta) {
                        if (!textStarted) {
                            textStarted = true;
                            emitPartial(partial, {type: "text_start", partial: {...partial}});
                        }
                        emitPartial(partial, {type: "text_delta", partial: {...partial}, delta: contentDelta});
                        prevContent = snap.content;
                    }

                    const reasoning = snap.reasoning_content ?? "";
                    const reasoningDelta = reasoning.slice(prevReasoning.length);
                    if (reasoningDelta) {
                        if (!thinkStarted) {
                            thinkStarted = true;
                            emitPartial(partial, {type: "thinking_start", partial: {...partial}});
                        }
                        emitPartial(partial, {
                            type: "thinking_delta",
                            partial: {...partial},
                            delta: reasoningDelta,
                        });
                        prevReasoning = reasoning;
                    }

                    if (snap.tool_calls?.length) {
                        if (!toolcallStarted) {
                            toolcallStarted = true;
                            emitPartial(partial, {type: "toolcall_start", partial: {...partial}});
                        }
                        emitPartial(partial, {type: "toolcall_delta", partial: {...partial}});
                    }
                },
            );

            if (completion.ok === false) {
                const {stopReason, errorMessage} = failureToStopReason(completion.failure);
                const failed: AssistantAgentMessage = {
                    ...lastPartial,
                    stopReason,
                    errorMessage,
                };
                if (textStarted) {
                    stream.push({type: "text_end", partial: {...failed}});
                }
                if (thinkStarted) {
                    stream.push({type: "thinking_end", partial: {...failed}});
                }
                stream.push({type: "error", partial: failed, errorMessage});
                stream.end(failed);
                return;
            }

            const msg = completion.result.message;
            const finalMsg: AssistantAgentMessage = {
                ...base,
                content: msg.content ?? "",
                reasoning_content: msg.reasoning_content,
                tool_calls: msg.tool_calls,
                stopReason: msg.tool_calls?.length ? "tool_calls" : "stop",
                _llmUsage: completion.result.usage,
            };

            if (textStarted) {
                stream.push({type: "text_end", partial: {...finalMsg}});
            }
            if (thinkStarted) {
                stream.push({type: "thinking_end", partial: {...finalMsg}});
            }
            if (finalMsg.tool_calls?.length) {
                stream.push({type: "toolcall_start", partial: {...finalMsg}});
                stream.push({type: "toolcall_end", partial: {...finalMsg}});
            }
            stream.push({type: "done", partial: {...finalMsg}});
            stream.end(finalMsg);
        })().catch((e) => {
            stream.fail(e instanceof Error ? e : new Error(String(e)));
        });

        return stream;
    };
}

export const deepSeekStreamFn = createDeepSeekStreamFn("high");
