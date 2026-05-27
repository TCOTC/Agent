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

/** 思源 exportMdContent：仅导出正文，不含文档标题行 */
export const EXPORT_MD_BODY_OPTS = {
    yfm: false,
    fillCSSVar: false,
    addTitle: false,
} as const;

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从 createDocWithMd 的 path 解析文档标题（末段路径名）。 */
export function docTitleFromPath(path: string): string {
    const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
    const last = normalized.split("/").filter(Boolean).pop();
    return last ?? "";
}

/**
 * 去掉 Markdown 开头与文档标题重复的一级标题。
 * 思源文档标题由文档块自身维护，不应写入正文。
 */
export function stripLeadingDocumentTitle(
    markdown: string,
    title: string | undefined,
): {markdown: string; stripped: boolean} {
    if (!title?.trim()) {
        return {markdown, stripped: false};
    }
    const leading = markdown.match(/^[\s\uFEFF]*/)?.[0] ?? "";
    const body = markdown.slice(leading.length);
    const titleRe = new RegExp(`^#{1,6}\\s+${escapeRegExp(title.trim())}\\s*(?:\\r?\\n|$)`);
    if (!titleRe.test(body)) {
        return {markdown, stripped: false};
    }
    const rest = body.replace(titleRe, "").replace(/^\s*\r?\n?/, "");
    return {markdown: leading + rest, stripped: true};
}
