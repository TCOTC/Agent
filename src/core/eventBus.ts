type Handler = (...args: unknown[]) => void;

/** 轻量事件总线，用于 UI 与 Agent 循环解耦 */
export class EventBus {
    private map = new Map<string, Set<Handler>>();

    on(event: string, fn: Handler): () => void {
        let set = this.map.get(event);
        if (!set) {
            set = new Set();
            this.map.set(event, set);
        }
        set.add(fn);
        return () => set!.delete(fn);
    }

    emit(event: string, ...args: unknown[]): void {
        const set = this.map.get(event);
        if (!set) {
            return;
        }
        for (const fn of set) {
            try {
                fn(...args);
            } catch {
                /* ignore listener errors */
            }
        }
    }

    clear(): void {
        this.map.clear();
    }
}

export const agentBus = new EventBus();

export const AgentEvents = {
    /** pi 式 Agent 生命周期事件（payload 为 AgentEvent） */
    AGENT_EVENT: "agent:event",
    STREAM_DELTA: "stream:delta",
    TOOL_START: "tool:start",
    TOOL_END: "tool:end",
    SESSION_CHANGE: "session:change",
    MODE_CHANGE: "mode:change",
    PENDING_EDIT: "edit:pending",
    MESSAGES_RENDER: "messages:render",
} as const;
