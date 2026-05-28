import type {AssistantAgentMessage, AssistantMessageEvent, AssistantMessageEventStream} from "./types";

/** 轻量 EventStream，对齐 pi-ai 的 AssistantMessageEventStream 契约 */
export class DeepSeekAssistantStream implements AssistantMessageEventStream {
    private events: AssistantMessageEvent[] = [];
    private waiters: Array<(v: IteratorResult<AssistantMessageEvent>) => void> = [];
    private finished = false;
    private finalMessage: AssistantAgentMessage | null = null;
    private streamError: Error | null = null;

    push(event: AssistantMessageEvent): void {
        if (this.finished) {
            return;
        }
        if (event.type === "done" || event.type === "error") {
            this.finalMessage = event.partial;
            if (event.type === "error") {
                this.streamError = new Error(event.errorMessage);
            }
        }
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter({value: event, done: false});
        } else {
            this.events.push(event);
        }
    }

    end(message: AssistantAgentMessage): void {
        if (this.finished) {
            return;
        }
        this.finalMessage = message;
        this.finished = true;
        this.flushDone();
    }

    fail(error: Error): void {
        if (this.finished) {
            return;
        }
        this.streamError = error;
        this.finished = true;
        this.flushDone();
    }

    private flushDone(): void {
        while (this.waiters.length) {
            this.waiters.shift()!({value: undefined as unknown as AssistantMessageEvent, done: true});
        }
    }

    async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
        while (!this.finished || this.events.length) {
            if (this.events.length) {
                yield this.events.shift()!;
                continue;
            }
            if (this.finished) {
                break;
            }
            const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
                this.waiters.push(resolve);
            });
            if (next.done) {
                break;
            }
            yield next.value;
        }
    }

    async result(): Promise<AssistantAgentMessage> {
        for await (const _ of this) {
            /* drain */
        }
        if (this.streamError) {
            throw this.streamError;
        }
        if (!this.finalMessage) {
            throw new Error("Stream ended without assistant message");
        }
        return this.finalMessage;
    }
}
