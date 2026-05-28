import type {AgentMessage, AssistantAgentMessage} from "../core/agent/types";
import {createChatFromAgent, patchChatFromAgent} from "../core/agent/messages";
import type {ChatMessage} from "./types";

/**
 * 将 Agent 状态合并进 UI 用的 messages 数组，保持已有 ChatMessage 对象引用不变。
 * 避免流式输出时 WeakMap / streamMd 缓存因对象重建而失效导致界面闪烁。
 */
export function syncChatMessagesFromAgent(
    target: ChatMessage[],
    committed: AgentMessage[],
    streaming?: AgentMessage,
): void {
    for (let i = 0; i < committed.length; i++) {
        if (i >= target.length) {
            target.push(createChatFromAgent(committed[i]));
        } else {
            patchChatFromAgent(target[i], committed[i]);
        }
    }

    const streamingAssistant =
        streaming?.role === "assistant" ? (streaming as AssistantAgentMessage) : undefined;

    if (streamingAssistant) {
        const idx = committed.length;
        let row: ChatMessage;
        if (idx >= target.length) {
            row = createChatFromAgent(streamingAssistant);
            target.push(row);
        } else if (target[idx].role !== "assistant") {
            row = createChatFromAgent(streamingAssistant);
            target.push(row);
        } else {
            row = target[idx];
            patchChatFromAgent(row, streamingAssistant);
        }
        for (const m of target) {
            if (m.role === "assistant") {
                m._streaming = m === row;
            }
        }
        return;
    }

    for (const m of target) {
        if (m.role === "assistant") {
            delete m._streaming;
            delete m._mdStreaming;
        }
    }

    if (target.length > committed.length) {
        target.length = committed.length;
    }
}
