import {MAX_TOOL_OUTPUT_CHARS} from "../core/constants";

export interface TruncateResult {
    text: string;
    truncated: boolean;
    originalLength: number;
}

/** 将工具输出截断到全局上限，并在 JSON 结果中标注 truncated */
export function truncateToolOutput(text: string, max = MAX_TOOL_OUTPUT_CHARS): TruncateResult {
    const originalLength = text.length;
    if (originalLength <= max) {
        return {text, truncated: false, originalLength};
    }
    const hint =
        `\n\n[输出已截断：共 ${originalLength} 字符，仅显示前 ${max} 字符。可缩小读取范围或指定行号区间后重试。]`;
    const budget = Math.max(0, max - hint.length);
    return {
        text: text.slice(0, budget) + hint,
        truncated: true,
        originalLength,
    };
}

export function isEmptyKernelMsg(msg: unknown): boolean {
    return msg == null || (typeof msg === "string" && msg.trim() === "");
}

function formatKernelData(data: unknown): string {
    if (data === undefined) {
        return "";
    }
    if (typeof data === "string") {
        return data;
    }
    return JSON.stringify(data, null, 2);
}

/** 成功且无 msg 时只序列化 data，否则保留完整响应 */
export function compactKernelResponseText(value: unknown): string {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const r = value as Record<string, unknown>;
        if (r.code === 0 && isEmptyKernelMsg(r.msg) && "data" in r) {
            return formatKernelData(r.data);
        }
    }
    return JSON.stringify(value, null, 2);
}

export function compactKernelResponseTruncated(value: unknown, max = MAX_TOOL_OUTPUT_CHARS): string {
    return truncateToolOutput(compactKernelResponseText(value), max).text;
}

export function wrapToolJson(payload: Record<string, unknown>, rawText?: string): string {
    if (rawText !== undefined) {
        const {text, truncated, originalLength} = truncateToolOutput(rawText);
        return JSON.stringify({...payload, content: text, truncated, originalLength});
    }
    const s = JSON.stringify(payload);
    const {text} = truncateToolOutput(s);
    return text;
}
