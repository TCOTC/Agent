import {SQL_TEMPLATES} from "./sqlHints";

export function buildModeSystemPrompt(mode: AgentMode, extras: {
    customInstructions?: string;
    editorContext?: string;
    attachments?: ContextAttachment[];
    worksetNotebooks?: string[];
}): string {
    const modeBlock =
        mode === "ask"
            ? "当前模式：**问答**。你只能使用只读与 UI 导航工具，不得修改笔记内容。"
            : mode === "edit"
            ? "当前模式：**编辑**。优先读取目标文档，使用 propose/apply 或 Kramdown 精准编辑；大改前先展示差异。"
            : "当前模式：**Agent**。可自主多步调用工具完成任务，低风险写入自动执行。";

    const parts = [
        "你是思源笔记（SiYuan）专业 Agent，运行在用户本地工作空间。",
        modeBlock,
        "",
        "## 工具策略",
        "- 理解文档：siyuan_read_markdown（可指定行范围）→ 需要块 ID 时 siyuan_read_kramdown",
        "- 探索结构：siyuan_get_doc_outline、siyuan_get_backlinks、siyuan_list_child_blocks",
        "- 大段改写：siyuan_propose_document_edit 生成 diff → 用户确认后 siyuan_apply_document_edit",
        "- 单块精确改：siyuan_edit_block_kramdown（保留 IAL）",
        "- 导航：siyuan_open_document / siyuan_focus_block",
        "",
        "## 原则",
        "1. 先读后写，禁止臆测文档内容。",
        "2. 中文回答，结构清晰。",
        "3. 保持块 ID 稳定，避免破坏双向链接。",
        "4. 批量或删除操作前说明影响范围。",
        "",
        SQL_TEMPLATES,
    ];

    if (extras.customInstructions?.trim()) {
        parts.push("", "## 用户自定义指令", extras.customInstructions.trim());
    }

    if (extras.worksetNotebooks?.length) {
        parts.push("", "## 工作集（仅可操作以下笔记本）", extras.worksetNotebooks.join("\n"));
    }

    if (extras.attachments?.length) {
        parts.push("", "## 用户附加的上下文");
        for (const a of extras.attachments) {
            parts.push(`- [${a.kind}] ${a.label} (${a.id})${a.preview ? "：" + a.preview.slice(0, 200) : ""}`);
        }
    }

    if (extras.editorContext?.trim()) {
        parts.push("", "## 当前编辑器", extras.editorContext.trim());
    }

    return parts.join("\n");
}
