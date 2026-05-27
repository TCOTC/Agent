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

export function wrapToolJson(payload: Record<string, unknown>, rawText?: string): string {
    if (rawText !== undefined) {
        const {text, truncated, originalLength} = truncateToolOutput(rawText);
        return JSON.stringify({...payload, content: text, truncated, originalLength});
    }
    const s = JSON.stringify(payload);
    const {text} = truncateToolOutput(s);
    return text;
}
