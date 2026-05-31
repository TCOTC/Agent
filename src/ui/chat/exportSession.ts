import type {ChatMessage} from "../../agent/types";
import type {ChatSession} from "../../session/types";

export function sessionToMarkdown(session: ChatSession, messages?: ChatMessage[]): string {
    const exportMessages = messages ?? session.messages;
    const lines: string[] = [
        `# ${session.title}`,
        "",
        `- 创建：${session.createdAt}`,
        `- 模式：${session.mode}`,
        "",
    ];
    for (const m of exportMessages) {
        if (m.role === "user") {
            lines.push("## 用户", "", m.content ?? "", "");
        } else if (m.role === "assistant") {
            if (m.reasoning_content) {
                lines.push("<details><summary>思考</summary>", "", m.reasoning_content, "", "</details>", "");
            }
            lines.push("## Assistant", "", m.content ?? "", "");
        } else if (m.role === "tool") {
            lines.push("### 工具", "", (m.content ?? "").slice(0, 2000), "");
        }
    }
    return lines.join("\n");
}

export function downloadTextFile(filename: string, content: string): void {
    const blob = new Blob([content], {type: "text/markdown;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
