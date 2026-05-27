export type DiffLineKind = "same" | "add" | "remove";

export interface DiffLine {
    kind: DiffLineKind;
    text: string;
    oldLineNo?: number;
    newLineNo?: number;
}

/** 基于 LCS 的行级 diff（Myers 简化版） */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
    const a = oldText.split("\n");
    const b = newText.split("\n");
    const n = a.length;
    const m = b.length;
    const dp: number[][] = Array.from({length: n + 1}, () => Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push({kind: "same", text: a[i], oldLineNo: i + 1, newLineNo: j + 1});
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            out.push({kind: "remove", text: a[i], oldLineNo: i + 1});
            i++;
        } else {
            out.push({kind: "add", text: b[j], newLineNo: j + 1});
            j++;
        }
    }
    while (i < n) {
        out.push({kind: "remove", text: a[i], oldLineNo: i + 1});
        i++;
    }
    while (j < m) {
        out.push({kind: "add", text: b[j], newLineNo: j + 1});
        j++;
    }
    return out;
}

export function diffSummary(lines: DiffLine[]): {adds: number; removes: number; sames: number} {
    let adds = 0;
    let removes = 0;
    let sames = 0;
    for (const l of lines) {
        if (l.kind === "add") {
            adds++;
        } else if (l.kind === "remove") {
            removes++;
        } else {
            sames++;
        }
    }
    return {adds, removes, sames};
}

export function renderDiffHtml(lines: DiffLine[]): string {
    const parts: string[] = [];
    for (const l of lines) {
        const cls =
            l.kind === "add" ? "agent-diff__line--add" :
                l.kind === "remove" ? "agent-diff__line--remove" :
                "agent-diff__line--same";
        const prefix = l.kind === "add" ? "+" : l.kind === "remove" ? "-" : " ";
        const no =
            l.kind === "add" ? l.newLineNo :
                l.kind === "remove" ? l.oldLineNo :
                l.newLineNo;
        parts.push(
            `<div class="agent-diff__line ${cls}"><span class="agent-diff__no">${no ?? ""}</span><span class="agent-diff__prefix">${prefix}</span><span class="agent-diff__text">${escapeHtml(l.text)}</span></div>`,
        );
    }
    return parts.join("");
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
