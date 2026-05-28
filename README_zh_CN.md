# Agent — 思源笔记 AI Agent 插件 v2.1

专用于思源笔记的 **DeepSeek Agent**：Cursor 风格双栏侧栏、25 个工具、Diff 预览编辑、双档运行模式。

## 功能亮点

### 交互（对标 Cursor）
- **左侧会话栏**：搜索、置顶、右键删除、导出 Markdown
- **聊天 / 运行** 双 Tab：流式思考 + Protyle 预览 + 工具执行实时状态
- **Composer**：`/` 斜杠命令、`@` 块引用搜索、上下文芯片、Ctrl+Enter 发送
- **Diff 弹窗**：大段文档改写先 propose 再 apply
- **重新生成 ↻**、导出对话 ↓

### 运行模式
| 模式 | 说明 |
|------|------|
| 问答 | 只读 + UI 导航 |
| 智能体 | 全工具，低风险自动写入 |

### 工具（25 个）
读：Markdown 行范围、Kramdown、大纲、反向链接、属性、子块、搜索、最近文档、笔记本/文档列表  
写：追加/插入/更新/Kramdown/移动/删除、创建/重命名文档、propose+apply 整篇 Diff  
UI：打开文档、聚焦块  
SQL：只读查询（带模板提示）

### 安全
- 风险分自动放行（可调上限）
- 工作集限制笔记本
- 删除/SQL/整篇 apply 需确认

### 数据目录
`settings.json` · `sessions.json` · `activity.jsonl` · `token-stats.json`

## 开发

```bash
pnpm install && pnpm dev
```

在思源中重载插件，设置 → Agent → 填写 DeepSeek API Key。
