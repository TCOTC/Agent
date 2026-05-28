# Agent 底座

> 文档版本：v1.0  
> 日期：2026-05-28  
> 目的：记录思源 Agent 插件底座应如何参考 [pi](https://github.com/earendil-works/pi) 构建；供后续底座重构会话使用。

---

## 一、背景

开发要求明确：**Agent 底座思路参考 pi**（[earendil-works/pi](https://github.com/earendil-works/pi)）。此前实现主要对照思源源码与 Cursor 侧栏，**未系统阅读 pi 代码**。本文档基于 pi 仓库 README 与包结构整理，本地浅克隆见 **`refer/pi/`**。

**参考代码目录**：工作区根目录下的 **`refer/`**（原 `plugin/`，已重命名）。该目录仅用于离线阅读，**不打包进插件发布产物**（已在 `.gitignore` 中忽略）。

| 路径 | 内容 |
|------|------|
| `refer/pi/` | [earendil-works/pi](https://github.com/earendil-works/pi) 浅克隆（`git clone --depth 1`） |
| `refer/siyuan-plugin-copilot/` 等 | 社区思源 AI 插件参考克隆 |

---

## 二、pi 是什么

TypeScript **monorepo**，自称 **Agent Harness**：分层为 **LLM 层 → Agent 运行时 → 产品层（CLI/SDK）→ UI 层**。

主仓库 `packages/` 含 **4 个包**：

| npm 包 | 目录 | 一句话 |
|--------|------|--------|
| `@earendil-works/pi-ai` | `packages/ai` | 统一多 Provider 的 LLM 流式 API（含 DeepSeek） |
| `@earendil-works/pi-agent-core` | `packages/agent` | **Agent 运行时**：tool 调用、状态、事件流 |
| `@earendil-works/pi-coding-agent` | `packages/coding-agent` | 交互式 Coding Agent CLI + **SDK 嵌入** |
| `@earendil-works/pi-tui` | `packages/tui` | 终端 UI（差分渲染） |

**不在主 repo、但文档提到**：

- `@earendil-works/pi-web-ui`：Web 聊天组件（npm 有，主 repo 无）
- [pi-chat](https://github.com/earendil-works/pi-chat)：Slack/聊天自动化（独立 repo）

---

## 三、各包职责与「值得学什么」

### 3.1 `@earendil-works/pi-agent-core`（`refer/pi/packages/agent`）——**底座核心，优先读**

与现有 `src/agent/agentLoop.ts` 直接对应，是构建底座最应对齐的一层。

| 模块 | 路径 | 可参考的点 |
|------|------|-----------|
| Agent 循环 | `src/agent-loop.ts` | 多轮 tool call 循环、`turn_start/end` 语义 |
| Agent 类 | `src/agent.ts` | 有状态 Agent、`subscribe` 事件、`prompt/continue/abort` |
| 类型系统 | `src/types.ts` | `AgentMessage` 与 LLM Message 分离、工具结果结构 |
| Harness | `src/harness/agent-harness.ts` | 更高层 harness 编排 |
| 会话 | `src/harness/session/` | JSONL 持久化、session 管理 |
| 上下文压缩 | `src/harness/compaction/` | 超长对话 `compact`、分支摘要 |
| 工具钩子 | README / `agent.ts` | `beforeToolCall` / `afterToolCall`（类似风险确认，更系统化） |
| Steering / Follow-up | `agent.ts` | 工具执行中 **插队改指令**、结束后 **追加任务** |
| 消息桥接 | `transformContext` + `convertToLlm` | UI 消息与发给模型的消息解耦 |

**事件模型**（UI 应订阅，而非自行拼 patch 状态）：

```
agent_start → turn_start → message_start / message_update / message_end
  → tool_execution_start / tool_execution_update / tool_execution_end
  → turn_end → agent_end
```

**与当前插件差距**：现有 `agentLoop` 能跑，但缺少 pi 的 **事件协议、消息分层、steering、compaction、工具执行生命周期**。

---

### 3.2 `@earendil-works/pi-ai`（`refer/pi/packages/ai`）——**LLM 抽象层，选读**

| 模块 | 可参考的点 |
|------|-----------|
| `src/stream.ts` / `types.ts` | 流式事件：`text_delta`、thinking、tool call 增量 JSON |
| `src/models.ts` | 模型发现与注册 |
| `src/providers/` | 各 Provider 适配（**含 DeepSeek**） |
| Tool 定义 | **TypeBox** schema + 参数校验 |
| Context | 可序列化 `Context`，便于换模型 / 持久化 |

**对思源 Agent**：仅支持 DeepSeek，不必整包搬 `pi-ai`，但值得学：

- 流式事件的 **统一枚举**（text / reasoning / tool_call 分事件）
- Tool schema 校验方式
- Token / cost 统计

---

### 3.3 `@earendil-works/pi-coding-agent`（`refer/pi/packages/coding-agent`）——**产品层 / SDK，重点学架构**

CLI 产品，但 **`core/sdk.ts` 是嵌入型 Agent 范本**。

| 模块 | 可参考的点 |
|------|-----------|
| `core/sdk.ts` | `createAgentSession()` — 编程式创建 Agent |
| `core/agent-session.ts` | 会话运行时、事件监听 |
| `core/session-manager.ts` | 会话分支、entry 类型化存储 |
| `core/extensions/` | **扩展系统**：注册 tool、hook、slash command |
| `core/tools/` | 内置 tool 工厂（read/write/edit…） |
| `core/compaction/` | 产品级 compaction |
| `core/event-bus.ts` | 内部事件总线 |
| `core/skills.ts` | Skill 加载与注入 prompt |
| `modes/interactive/components/` | 工具执行 UI、消息渲染（TUI，概念可参考） |

**pi 产品哲学**（见 `packages/coding-agent/README.md`）：

- 核心极简，能力靠 **Extensions / Skills / Pi Packages** 扩展
- 四种模式：交互 / print / RPC / **SDK 嵌入**
- 默认少量内置 tool，其余靠扩展

**思源 Agent 定位**：≈ pi 的 **SDK 嵌入模式** + **思源内置 tools** + **Cursor 风格 Web UI**（非 TUI）。

---

### 3.4 `@earendil-works/pi-tui`（`refer/pi/packages/tui`）——**低优先级**

终端差分渲染 TUI。运行在浏览器侧栏，**基本不可直接复用**；最多借鉴组件化与增量更新思路。

---

## 四、建议阅读顺序（clone 后）

```bash
cd refer/pi
npm install --ignore-scripts
npm run build
```

1. `packages/agent/README.md` → `agent-loop.ts` → `agent.ts` → `types.ts`
2. `packages/agent/src/harness/`（session、compaction、messages）
3. `packages/coding-agent/src/core/sdk.ts` → `agent-session.ts` → `extensions/`
4. `packages/ai/README.md` 中 DeepSeek / streaming / tools 章节
5. 按需：`packages/coding-agent/src/core/tools/`（tool 工厂与输出截断）

---

## 五、映射到思源 Agent 插件

| 层次 | pi 对应 | 当前实现 | 重构方向 |
|------|---------|----------|----------|
| Agent 循环 | `pi-agent-core` | `src/agent/agentLoop.ts` | 对齐事件模型 + tool 生命周期 |
| LLM 客户端 | `pi-ai`（DeepSeek provider） | `src/agent/deepseekClient.ts` | 学流式事件结构，保持 DeepSeek 专用 |
| 会话 | `harness/session` + `SessionManager` | `src/session/storage.ts` | entry 类型化、分支 / 压缩 |
| 工具 | `AgentTool` + extensions | `src/tools/executor.ts` | `beforeToolCall`、并行执行、统一结果格式 |
| 风险确认 | `beforeToolCall` block | `src/tools/riskPolicy.ts` | 并入 tool 生命周期钩子 |
| UI | SDK events → 组件 | `AppShell` + `messageRenderer` | 订阅 pi 式事件，减少 ad-hoc patch |
| 扩展性 | extensions / skills | 无 | 长期：MCP / 插件扩展 |

**保留**（开发要求）：`agentLoop` 核心思路、`streamMdRender` 流式 Markdown 封存渲染——重构时 **迁移到 pi 式事件驱动 UI**，而非删除流式渲染能力。

---

## 六、底座重构会话检查清单

新开 Cursor 会话做底座重构前，建议确认：

- [ ] 已读 `refer/pi/packages/agent/README.md`
- [ ] 已读 `refer/pi/packages/agent/src/agent-loop.ts` 与 `agent.ts`
- [ ] 已读 `refer/pi/packages/coding-agent/src/core/sdk.ts`
- [ ] 已读 [开发要求](./开发要求.md) 中与底座相关的约束（DeepSeek 专用、14000 字符 tool 上限等）
- [ ] 明确 UI 仍对标 **Cursor 侧栏**，不是 pi TUI
- [ ] 明确思源 tools 走 `src/tools/`，不照搬 pi 的 read/bash/edit

---

## 七、相关文档

- [开发要求](./开发要求.md)
- [插件 Agent 底层架构方案构思](./插件Agent底层架构方案构思.md)
- [流式 Markdown 封存策略讨论](./流式-Markdown-封存策略讨论.md)
- [调研思源 AI 插件](./调研思源AI插件.md)
- pi 官方文档：<https://pi.dev/docs/latest>
