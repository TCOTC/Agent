import type {AuditEvent} from "../agent/types";

export interface ActivityLogEntry {
    ts: string;
    event: AuditEvent;
}

/** 将审计事件序列化为 JSONL 一行 */
export function serializeAuditLine(e: AuditEvent): string {
    return JSON.stringify({ts: new Date().toISOString(), event: e} satisfies ActivityLogEntry);
}

/** 内存缓冲 + 定期刷盘由 UI 层调用 plugin.saveData */
export class ActivityLogBuffer {
    private lines: string[] = [];
    private readonly maxLines: number;

    constructor(maxLines = 5000) {
        this.maxLines = maxLines;
    }

    push(e: AuditEvent): void {
        this.lines.push(serializeAuditLine(e));
        if (this.lines.length > this.maxLines) {
            this.lines.splice(0, this.lines.length - this.maxLines);
        }
    }

    drain(): string {
        const chunk = this.lines.join("\n");
        this.lines.length = 0;
        return chunk;
    }

    peekRecent(n = 200): string[] {
        return this.lines.slice(-n);
    }
}
