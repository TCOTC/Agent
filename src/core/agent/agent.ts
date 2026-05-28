import {runAgentLoop, runAgentLoopContinue} from "./agent-loop";
import {convertToLlm} from "./messages";
import type {
    AgentContext,
    AgentEvent,
    AgentLoopConfig,
    AgentMessage,
    AgentState,
    AgentTool,
    QueueMode,
    StreamFn,
    ThinkingLevel,
    ToolExecutionMode,
} from "./types";
import type {DeepSeekConfig} from "../../agent/types";

export interface AgentOptions {
    initialState?: Partial<Pick<AgentState, "systemPrompt" | "llm" | "thinkingLevel" | "tools" | "messages">>;
    convertToLlm?: (messages: AgentMessage[]) => ReturnType<typeof convertToLlm> | Promise<ReturnType<typeof convertToLlm>>;
    transformContext?: AgentLoopConfig["transformContext"];
    streamFn?: StreamFn;
    beforeToolCall?: AgentLoopConfig["beforeToolCall"];
    afterToolCall?: AgentLoopConfig["afterToolCall"];
    steeringMode?: QueueMode;
    followUpMode?: QueueMode;
    toolExecution?: ToolExecutionMode;
}

class PendingMessageQueue {
    private messages: AgentMessage[] = [];
    constructor(public mode: QueueMode) {}

    enqueue(message: AgentMessage): void {
        this.messages.push(message);
    }

    hasItems(): boolean {
        return this.messages.length > 0;
    }

    drain(): AgentMessage[] {
        if (this.mode === "all") {
            const drained = this.messages.slice();
            this.messages = [];
            return drained;
        }
        const first = this.messages.shift();
        return first ? [first] : [];
    }

    clear(): void {
        this.messages = [];
    }
}

type ActiveRun = {
    promise: Promise<void>;
    resolve: () => void;
    abortController: AbortController;
};

/**
 * 有状态 Agent：封装 transcript、事件订阅、steering / follow-up 队列。
 * 对齐 pi-agent-core 的 Agent 类。
 */
export class Agent {
    private _state: {
        systemPrompt: string;
        llm: DeepSeekConfig;
        thinkingLevel: ThinkingLevel;
        tools: AgentTool[];
        messages: AgentMessage[];
        isStreaming: boolean;
        streamingMessage?: AgentMessage;
        pendingToolCalls: Set<string>;
        errorMessage?: string;
    };

    private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
    private readonly steeringQueue: PendingMessageQueue;
    private readonly followUpQueue: PendingMessageQueue;
    private activeRun?: ActiveRun;

    convertToLlm: AgentLoopConfig["convertToLlm"];
    transformContext?: AgentLoopConfig["transformContext"];
    streamFn: StreamFn;
    beforeToolCall?: AgentLoopConfig["beforeToolCall"];
    afterToolCall?: AgentLoopConfig["afterToolCall"];
    toolExecution: ToolExecutionMode;

    constructor(options: AgentOptions = {}) {
        this._state = {
            systemPrompt: options.initialState?.systemPrompt ?? "",
            llm: options.initialState?.llm ?? {baseUrl: "", apiKey: "", model: ""},
            thinkingLevel: options.initialState?.thinkingLevel ?? "high",
            tools: options.initialState?.tools?.slice() ?? [],
            messages: options.initialState?.messages?.slice() ?? [],
            isStreaming: false,
            pendingToolCalls: new Set(),
        };
        this.convertToLlm = options.convertToLlm ?? convertToLlm;
        this.transformContext = options.transformContext;
        this.streamFn = options.streamFn!;
        if (!options.streamFn) {
            throw new Error("Agent 需要 streamFn");
        }
        this.beforeToolCall = options.beforeToolCall;
        this.afterToolCall = options.afterToolCall;
        this.toolExecution = options.toolExecution ?? "parallel";
        this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
        this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
    }

    subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    get state(): AgentState {
        return this._state;
    }

    set steeringMode(mode: QueueMode) {
        this.steeringQueue.mode = mode;
    }

    get steeringMode(): QueueMode {
        return this.steeringQueue.mode;
    }

    set followUpMode(mode: QueueMode) {
        this.followUpQueue.mode = mode;
    }

    get followUpMode(): QueueMode {
        return this.followUpQueue.mode;
    }

    steer(message: AgentMessage): void {
        this.steeringQueue.enqueue(message);
    }

    followUp(message: AgentMessage): void {
        this.followUpQueue.enqueue(message);
    }

    clearSteeringQueue(): void {
        this.steeringQueue.clear();
    }

    clearFollowUpQueue(): void {
        this.followUpQueue.clear();
    }

    get signal(): AbortSignal | undefined {
        return this.activeRun?.abortController.signal;
    }

    abort(): void {
        this.activeRun?.abortController.abort();
    }

    waitForIdle(): Promise<void> {
        return this.activeRun?.promise ?? Promise.resolve();
    }

    reset(): void {
        this._state.messages = [];
        this._state.isStreaming = false;
        this._state.streamingMessage = undefined;
        this._state.pendingToolCalls = new Set();
        this._state.errorMessage = undefined;
        this.clearSteeringQueue();
        this.clearFollowUpQueue();
    }

    async prompt(input: string | AgentMessage | AgentMessage[]): Promise<void> {
        if (this.activeRun) {
            throw new Error("Agent 正在处理中，请等待完成或使用 steer / followUp 插队");
        }
        const messages = this.normalizePromptInput(input);
        await this.runPromptMessages(messages);
    }

    async continue(): Promise<void> {
        if (this.activeRun) {
            throw new Error("Agent 正在处理中");
        }
        const last = this._state.messages[this._state.messages.length - 1];
        if (!last) {
            throw new Error("没有可继续的消息");
        }
        if (last.role === "assistant") {
            throw new Error("无法从 assistant 消息继续");
        }
        await this.runContinuation();
    }

    private normalizePromptInput(input: string | AgentMessage | AgentMessage[]): AgentMessage[] {
        if (Array.isArray(input)) {
            return input;
        }
        if (typeof input !== "string") {
            return [input];
        }
        return [{role: "user", content: input, timestamp: Date.now()}];
    }

    private async runPromptMessages(
        messages: AgentMessage[],
        options: {skipInitialSteeringPoll?: boolean} = {},
    ): Promise<void> {
        await this.runWithLifecycle(async (signal) => {
            await runAgentLoop(
                messages,
                this.createContextSnapshot(),
                this.createLoopConfig(options),
                (event) => this.processEvents(event),
                signal,
                this.streamFn,
            );
        });
    }

    private async runContinuation(): Promise<void> {
        await this.runWithLifecycle(async (signal) => {
            await runAgentLoopContinue(
                this.createContextSnapshot(),
                this.createLoopConfig(),
                (event) => this.processEvents(event),
                signal,
                this.streamFn,
            );
        });
    }

    private createContextSnapshot(): AgentContext {
        return {
            systemPrompt: this._state.systemPrompt,
            messages: this._state.messages.slice(),
            tools: this._state.tools.slice(),
        };
    }

    private createLoopConfig(options: {skipInitialSteeringPoll?: boolean} = {}): AgentLoopConfig {
        let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
        return {
            llm: this._state.llm,
            thinkingLevel: this._state.thinkingLevel,
            streamFn: this.streamFn,
            convertToLlm: this.convertToLlm,
            transformContext: this.transformContext,
            beforeToolCall: this.beforeToolCall,
            afterToolCall: this.afterToolCall,
            toolExecution: this.toolExecution,
            getSteeringMessages: async () => {
                if (skipInitialSteeringPoll) {
                    skipInitialSteeringPoll = false;
                    return [];
                }
                return this.steeringQueue.drain();
            },
            getFollowUpMessages: async () => this.followUpQueue.drain(),
        };
    }

    private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
        const abortController = new AbortController();
        let resolvePromise = () => {};
        const promise = new Promise<void>((resolve) => {
            resolvePromise = resolve;
        });
        this.activeRun = {promise, resolve: resolvePromise, abortController};
        this._state.isStreaming = true;
        this._state.streamingMessage = undefined;
        this._state.errorMessage = undefined;

        try {
            await executor(abortController.signal);
        } catch (error) {
            await this.handleRunFailure(error, abortController.signal.aborted);
        } finally {
            this.finishRun();
        }
    }

    private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
        const failureMessage = {
            role: "assistant" as const,
            content: "",
            timestamp: Date.now(),
            stopReason: aborted ? ("aborted" as const) : ("error" as const),
            errorMessage: error instanceof Error ? error.message : String(error),
        };
        await this.processEvents({type: "message_start", message: failureMessage});
        await this.processEvents({type: "message_end", message: failureMessage});
        await this.processEvents({type: "turn_end", message: failureMessage, toolResults: []});
        await this.processEvents({type: "agent_end", messages: [failureMessage]});
    }

    private finishRun(): void {
        this._state.isStreaming = false;
        this._state.streamingMessage = undefined;
        this._state.pendingToolCalls = new Set();
        this.activeRun?.resolve();
        this.activeRun = undefined;
    }

    private async processEvents(event: AgentEvent): Promise<void> {
        switch (event.type) {
            case "message_start":
                this._state.streamingMessage = event.message;
                break;
            case "message_update":
                this._state.streamingMessage = event.message;
                break;
            case "message_end":
                this._state.streamingMessage = undefined;
                this._state.messages.push(event.message);
                break;
            case "tool_execution_start": {
                const pending = new Set(this._state.pendingToolCalls);
                pending.add(event.toolCallId);
                this._state.pendingToolCalls = pending;
                break;
            }
            case "tool_execution_end": {
                const pending = new Set(this._state.pendingToolCalls);
                pending.delete(event.toolCallId);
                this._state.pendingToolCalls = pending;
                break;
            }
            case "turn_end":
                if (event.message.role === "assistant" && event.message.errorMessage) {
                    this._state.errorMessage = event.message.errorMessage;
                }
                break;
            case "agent_end":
                this._state.streamingMessage = undefined;
                break;
        }

        const signal = this.activeRun?.abortController.signal;
        if (!signal) {
            throw new Error("Agent listener invoked outside active run");
        }
        for (const listener of this.listeners) {
            await listener(event, signal);
        }
    }
}
