# Cursor 侧边栏参考（Editor + Sidepane）

> 整理日期：2026-05-28  
> 范围：**仅**经典编辑器内的 Agent 侧栏（Sidepane / Sidepanel），不含 Agents Window、Cloud Agent、布局预设（agent/editor/zen/browser）等 Cursor 3 独立界面。  
> 用途：思源 Agent 插件 UI/交互对标时的功能清单与行为说明。

### 本插件布局约定（与 Cursor 默认差异）

- **侧栏停靠**：Agent 面板默认在编辑器**右侧**（思源 Dock 右侧），而非 Cursor 常见的左侧会话轨。
- **会话列表位置**：会话切换列表在侧栏**内部靠右**的一列（右轨），与主聊天区左右并列；**默认折叠不展开**，需要时再打开切换对话。
- 下文「第二节」在保留 Cursor 能力描述的同时，按上述布局书写；Cursor 原版多为整块侧栏左侧会话列表，仅作行为参考。

## 资料来源

| 类型 | 说明 |
|------|------|
| 官方文档 | [Agent overview](https://cursor.com/docs/agent/overview.md)、[Prompting](https://cursor.com/docs/agent/prompting.md)、[Keyboard shortcuts](https://cursor.com/help/customization/keyboard-shortcuts.md)、[Changelog 3.4](https://prod.cursor.com/changelog/3-4)（Compact chats） |
| 社区 | [Layout megathread](https://forum.cursor.com/t/megathread-cursor-layout-and-ui-feedback/146790)（侧栏搜索、时钟历史；Cursor 团队有回复） |
| Changelog 2.3 | 新建对话快捷键、`Cmd/Ctrl + N` 行为（见 [changelog/2-3](https://cursor.com/changelog/2-3)） |

文中标注 **【官方】** / **【论坛】** 表示可信度；未标注的条目多来自官方，细节 UI 无公开组件规范处会注明「行为已验证，DOM 未文档化」。

---

## 一、界面与入口

### 1.1 Editor + Sidepane

- Agent 在编辑器**侧边**聊天区（sidepane）中运行，与代码编辑区并列。【官方】  
  **本插件**：侧栏默认停靠在编辑器**右侧**。
- 打开 / 切换侧栏：
  - `Cmd/Ctrl + I`：打开 Agent 侧栏（文档亦称 Toggle Sidepanel）。【官方】
  - `Cmd/Ctrl + L`：快捷键表中的 Toggle Sidepanel 之一；可带**当前选区**作为上下文打开 Agent。【官方】

### 1.2 与 Inline Edit 的关系

| 能力 | 快捷键 | 行为 |
|------|--------|------|
| **Inline edit** | `Cmd/Ctrl + K` | 在**编辑器内**就地改代码，**不打开**侧栏。【官方】 |
| **打开 Agent（可带选区）** | `Cmd/Ctrl + L` | 打开侧栏，并将选中代码纳入上下文。【官方】 |

---

## 二、会话列表（侧栏内右轨）

侧栏整体在编辑器**右侧**；会话相关 UI 占侧栏**内部右侧**一列（右轨），主聊天 / Composer 在左，二者同一 Agent 面板内左右分栏。

```
┌────────────────────────────┬──────────────────────────────┐
│ 思源编辑器                  │ Agent 侧栏（默认右侧 Dock）     │
│                            │ ┌─────────────────┬────────┐ │
│                            │ │ 主区：聊天/运行   │ 会话轨  │ │
│                            │ │ 消息时间线       │ (右轨)  │ │
│                            │ │ Composer        │ 默认折叠 │ │
│                            │ └─────────────────┴────────┘ │
└────────────────────────────┴──────────────────────────────┘
```

### 2.1 多对话切换

- 维护**多个 Agent 对话**，在右轨列表中切换当前活跃会话。【官方 / 产品惯例】
- **本插件**：右轨**默认收起**；展开后才显示会话列表与切换操作，主区以当前对话为主。
- **新建对话**：`Cmd/Ctrl + N` 在**聊天输入区或侧栏已聚焦**时新建 Agent 对话（Cursor 2.3）。【Changelog 2.3】  
  本插件可在右轨头部或主区 Header 提供「+」等入口（与 Cursor 入口位置无关，能力对齐即可）。

### 2.2 搜索

- Cursor 在 **Agent 布局**下于侧栏提供**搜索**，用于筛选 / 定位会话。【论坛 megathread，团队有回复】
- **本插件**：搜索框放在**展开的右轨**顶部（与会话列表同列），对本地 `sessions` 过滤；具体交互（实时过滤、高亮）官方 docs 未逐条写明。

### 2.3 历史

- Cursor 在 **Editor 布局**且 Agent 在侧边时，通过**时钟图标**进入**历史对话**。【论坛 megathread】
- **本插件**：历史与会话列表同属右轨能力；右轨折叠时可用主区 Header 的**时钟 / 历史**入口打开右轨并定位历史（与 Cursor「因布局不同入口不同」的思路一致，落点在右轨 + 默认折叠）。

---

## 三、主聊天区（消息时间线）

### 3.1 流式回复

- Agent 执行任务时，助手回复**持续流式输出**，而非整段一次性显示。【官方】
- 文件编辑与终端等副作用可随任务进行；改动在 **Diff view** 中审查（见第五节）。

### 3.2 工具调用展示

- 对话时间线中展示 **tool calls** 及其结果；共享对话（Share）亦包含工具调用与结果。【官方】
- **无**官方公开的卡片 DOM、折叠态、参数流式动画规范；可从 [TypeScript SDK](https://cursor.com/docs/sdk/typescript.md) 的 `tool_call` 事件（`args` / `result`、`status`）推断存在「进行中 → 完成」生命周期。
- IDE 实现为**推测**：卡片 + 状态（运行中 / 成功 / 失败），主对话可配置展示密度（见 3.3）。

### 3.3 Compact chats mode

- **Compact chats**（Changelog 3.4）：更紧凑的会话阅读视图，在信息密度与可读性之间折中。【官方】
- **工具轨迹密度**（同版本），控制单条回复中展示多少工具活动：
  - **Compact**：精简结果，最少工具痕迹
  - **Balanced**：保留重要中间步骤
  - **Detailed**：接近逐步完整上下文
- 适用于 Editor 内侧栏聊天，与 Agents Window 的 3.4 QoL 同源能力。

---

## 四、Composer 输入区

### 4.1 @ 提及

在输入框输入 `@` 可附加上下文，输入后继续打字会出现匹配建议。【官方 [Prompting](https://cursor.com/docs/agent/prompting.md)】

| 提及类型 | 作用 |
|----------|------|
| **文件 / 文件夹** | 如 `@auth.ts`、`@src/components/`；选文件夹后可 `/` 深入 |
| **Docs** | 检索已索引文档（含用户添加的 `@Docs > Add new doc`） |
| **Terminals** | 附加终端输出 |
| **Past Chats** | 引用以往对话上下文 |
| **Git diff** | `@Commit (Diff of Working State)` 未提交改动；`@Branch (Diff with Main)` 分支相对 main 的 diff |
| **Browser** | 附加内置 Browser 工具的页面上下文 |

说明：已知相关文件时优先 @；不确定时 Agent 可自行搜索，非必须每次 @。

### 4.2 Context ring（上下文环）

- 输入区旁的**环状指示器**：显示当前对话**上下文窗口占用**比例。【官方】
- **点击**展开明细托盘，按类别展示 token 占用：
  - System prompt
  - Tools（可用工具定义）
  - Rules（项目 / 用户规则）
  - Skills
  - MCP（已连接 MCP 的说明与目录）
  - Subagents（可启动的子代理类型说明）
  - Summarized conversation（较早轮次的压缩摘要）
  - Conversation（用户消息、助手回复、工具结果）
- 悬停分段条或列表行可高亮对应类别。
- 窗口接近满载时，Cursor 会压缩较早对话为摘要以腾出空间。【官方】

### 4.3 模型选择器

- 位于输入区**上方**的下拉框（model picker）。【官方】
- `Cmd/Ctrl + /`：在可用模型间**轮换**。【官方】
- 切换仅影响**当前对话**后续轮次；默认模型在 Settings → Models 配置。

### 4.4 模式（本参考仅保留 Agent / Ask）

| 模式 | 权限 / 用途 |
|------|-------------|
| **Agent** | 可编辑文件、跑终端、调用工具，完成复杂任务。【官方】 |
| **Ask** | **只读**：理解代码与回答问题，不写入。【官方】 |

- 切换：`Shift + Tab` 在模式间循环，或使用输入区上方的 **mode picker**。【官方】
- 各模式使用**独立上下文**；换任务建议新开对话。

> 说明：Cursor 另有 Plan、Debug 等模式，**不在本参考范围**。

### 4.5 斜杠命令

- 输入 `/` 触发命令（与 `@` 并列的 Composer 能力）。【官方】
- 示例：`/agent-review`（Agent Review 相关流程，见 [Agent Review](https://cursor.com/docs/agent/agent-review.md)）。
- 具体命令列表以产品内补全与文档为准，本参考不穷举。

### 4.6 其他输入能力（侧栏通用，简要）

- **图片**：拖入输入区或 `Cmd/Ctrl + V` 粘贴截图。【官方】
- **语音**：麦克风图标听写。【官方】

---

## 五、运行控制与审查

### 5.1 Stop

- **Stop** 按钮：中止当前 Agent 运行。【官方】

### 5.2 Diff view

- Agent 修改文件后，在 **Diff view** 中审查改动。【官方】
- 支持**逐项拒绝**（reject）部分变更，而非只能全接受或全撤销。
- 与 **Checkpoints**（会话内快照回滚）互补：Diff 偏「审查本次改动」；Checkpoint 偏「时间线回退」（本参考未展开 Checkpoint 细节）。

### 5.3 子代理（Subagents）

- Agent 可**自动**或通过在对话中 **`/name`** 调用子代理。【官方 [Subagents](https://cursor.com/docs/subagents.md)】
- **主对话**通常只展示子代理工作的**摘要**，详细日志留在子代理上下文，避免污染主线程。
- 内置示例子类型包括 Explore、Bash、Browser 等（以当前产品为准）。

---

## 六、消息队列

Agent **忙碌**（正在执行当前任务）时的发送语义。【官方 [Agent overview - Queued messages](https://cursor.com/docs/agent/overview.md)】

| 操作 | 行为 |
|------|------|
| 输入 + **Enter** | 消息进入**队列**，按顺序等待；队列中的条目可**拖拽排序**。 |
| **Cmd/Ctrl + Enter** | **立即发送**，**绕过队列**；附到**最近一条用户消息**并马上处理，用于**打断或改向**当前任务。 |

要点：

- 队列适合「等当前任务做完再执行」的后续指令。
- 插队适合「必须立刻纠正方向」的场景，会改变与当前 tool 结果的衔接方式（更即时、更打断）。

---

## 七、Ask questions 工具

- Agent 可在任务中通过 **Ask questions** 工具向用户**提问**。【官方】
- **等待答复期间**，Agent 仍可继续**读文件、编辑、跑命令**等；用户回答到达后并入上下文。
- 目的：减少「傻等用户输入而停工」，与侧栏聊天的阻塞式 QA 不同。

---

## 八、快捷键速查（本参考范围内）

| 快捷键 | 作用 |
|--------|------|
| `Cmd/Ctrl + I` | 打开 Agent 侧栏 |
| `Cmd/Ctrl + L` | Toggle Sidepanel；可带选区 |
| `Cmd/Ctrl + K` | Inline edit（不打开侧栏） |
| `Cmd/Ctrl + N` | 聊天聚焦时新建 Agent 对话（2.3+） |
| `Shift + Tab` | Agent / Ask 模式循环 |
| `Cmd/Ctrl + /` | 轮换模型 |
| `Enter`（Agent 忙碌时） | 排队 |
| `Cmd/Ctrl + Enter`（Agent 忙碌时） | 立即发送 / 插队 |

---

## 九、官方文档索引

| 主题 | URL |
|------|-----|
| Agent 总览（Sidepane、队列、Stop、工具） | https://cursor.com/docs/agent/overview.md |
| Prompting（@、Context ring、模型） | https://cursor.com/docs/agent/prompting.md |
| 快捷键 | https://cursor.com/help/customization/keyboard-shortcuts.md |
| Subagents | https://cursor.com/docs/subagents.md |
| Agent Review | https://cursor.com/docs/agent/agent-review.md |
| Compact chats（3.4） | https://prod.cursor.com/changelog/3-4 |
| SDK 流式 / tool_call 事件 | https://cursor.com/docs/sdk/typescript.md |

---

## 十、与本插件的对照提示（可选）

思源 Agent 插件（`AppShell`）已部分对齐：**右侧** Dock 侧栏、侧栏内**右轨会话列表（默认折叠）**、聊天/运行 Tab、Composer（`/`、`@`、Ctrl+Enter）、模式切换、流式与工具 UI。实现演进时需将现有 `agent-rail` 从「整块左侧」调整为「主区 + 可折叠右轨」。本参考**未列入**项可作为后续迭代 backlog，例如：

- 消息队列 + 拖拽排序 + `Cmd/Ctrl + Enter` 插队
- Context ring 式上下文占用可视化
- Compact / Balanced / Detailed 工具轨迹密度
- Ask questions 式「边问边做」
- Inline edit 与侧栏 Agent 的快捷键分流（`K` vs `L`）

具体实现以 `docs/开发要求.md` 与产品优先级为准。
