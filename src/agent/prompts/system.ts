import type {ContextAttachment} from "../../context/types";
import type {AgentMode} from "../modes";
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
            : "当前模式：**智能体**。可自主多步调用工具完成任务，低风险写入自动执行。";

    const parts = [
        "你是思源笔记（SiYuan）专业 Agent，运行在用户本地工作空间。",
        modeBlock,
        "",
        "## 工具策略",
        "- 当前编辑位置：get_focused_editor（思源 getActiveEditor，含文档根 ID、光标块、选区）",
        "- 理解文档：read_markdown（可指定行范围）→ 需要块 ID 时 get_doc_outline / list_child_blocks / read_kramdown",
        "- 探索结构：get_doc_outline、get_backlinks、list_child_blocks",
        "- **局部改（优先）**：先列出要动的块 ID；**2 个及以上同类操作优先批量工具**——",
        "  - 删多块：batch_delete_blocks（一次确认）",
        "  - 改多块：batch_update_markdown（保留块 ID，禁止含文档根块）",
        "  - 插多块：batch_insert_markdown；多处末尾追加：batch_append_markdown",
        "  - 单块：delete_block / update_markdown / edit_block_kramdown / insert_markdown / append_markdown",
        "- **整篇替换（慎用）**：edit_document 会替换文档根下全部正文并重建子块，**已有块 ID 会变化**；仅当多数内容都要改、或按块改不现实时使用（diff 预览后写入）",
        "- **删整篇文档**：delete_document（文档根块 ID；勿用 delete_block）",
        "- 导航：open_document（打开并展示，可选高亮）/ focus_block（聚焦光标到块）",
        "",
        "## 原则",
        "1. 先读后写，禁止臆测文档内容。",
        "2. 中文回答，结构清晰。",
        "3. **尽量保持块 ID 稳定**（局部删/改/增），避免无谓整篇 edit_document，以免双向链接失效。",
        "4. 文档标题由思源单独管理：create 的 path 末段即标题，edit/read 的正文不含标题，禁止写入重复的一级标题。",
        "5. 批量或删除操作前说明影响范围。",
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
