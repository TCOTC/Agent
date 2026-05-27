/** 按 1-based 行号截取 Markdown（含首尾行） */
export function sliceMarkdownByLines(
    md: string,
    startLine?: number,
    endLine?: number,
): {content: string; totalLines: number; startLine: number; endLine: number} {
    const lines = md.split("\n");
    const totalLines = lines.length;
    let start = startLine ?? 1;
    let end = endLine ?? totalLines;
    if (start < 1) {
        start = 1;
    }
    if (end > totalLines) {
        end = totalLines;
    }
    if (start > end) {
        start = end;
    }
    const slice = lines.slice(start - 1, end);
    return {
        content: slice.join("\n"),
        totalLines,
        startLine: start,
        endLine: end,
    };
}
