export interface SlashCommand {
    id: string;
    label: string;
    hint: string;
    insert: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
    {id: "clear", label: "/clear", hint: "清空当前对话", insert: ""},
    {id: "doc", label: "/doc", hint: "读取当前文档（提示 Agent）", insert: "请读取当前打开的文档并总结要点。"},
    {id: "outline", label: "/outline", hint: "获取当前文档大纲", insert: "请获取当前文档的大纲结构。"},
    {id: "search", label: "/search", hint: "搜索笔记", insert: "请在工作空间中搜索："},
    {id: "edit", label: "/edit", hint: "进入编辑模式说明", insert: "请切换到编辑模式思路：先 read_markdown，再 propose 大改或 kramdown 小改。"},
    {id: "fix", label: "/fix", hint: "润色选区/文档", insert: "请润色改进当前文档的文笔与结构，先读取再 propose 修改。"},
];

export function filterSlashCommands(input: string): SlashCommand[] {
    const m = input.match(/(?:^|\s)\/([\w]*)$/);
    if (!m) {
        return [];
    }
    const q = m[1].toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.id.startsWith(q) || c.label.slice(1).startsWith(q));
}

export function applySlashCommand(cmd: SlashCommand, current: string): string {
    if (cmd.id === "clear") {
        return "__AGENT_CLEAR__";
    }
    const m = current.match(/(?:^|\s)\/([\w]*)$/);
    if (!m) {
        return current + cmd.insert;
    }
    return current.slice(0, m.index! + (m[0].startsWith(" ") ? 1 : 0)) + cmd.insert;
}
