# 思源笔记 AI / Agent 相关插件调研报告

> 调研日期：2026-05-14  
> 目的：为思源笔记后续集成 AI Agent、与笔记交互提供社区插件实现现状参考。

## 一、调研样本与本地代码位置

以下仓库已使用 `git clone --depth 1` 克隆到本工作区 **`plugin/`** 子目录（与仓库名同名），便于离线阅读与对比实现。

| 仓库 | 本地路径 |
|------|----------|
| [Achuan-2/siyuan-plugin-copilot](https://github.com/Achuan-2/siyuan-plugin-copilot) | `plugin/siyuan-plugin-copilot` |
| [yangtaihong59/siyuan-plugins-mcp-sisyphus](https://github.com/yangtaihong59/siyuan-plugins-mcp-sisyphus) | `plugin/siyuan-plugins-mcp-sisyphus` |
| [RiviaAzusa/siyuan-agent](https://github.com/RiviaAzusa/siyuan-agent) | `plugin/siyuan-agent` |
| [yangtaihong59/siyuan-plugins-ai-cli-bridge](https://github.com/yangtaihong59/siyuan-plugins-ai-cli-bridge) | `plugin/siyuan-plugins-ai-cli-bridge` |
| [DUZSSY/siyuan-ai-assistant](https://github.com/DUZSSY/siyuan-ai-assistant) | `plugin/siyuan-ai-assistant` |
| [frostime/sy-f-misc](https://github.com/frostime/sy-f-misc) | `plugin/sy-f-misc` |

原始链接列表（与上表一致，便于复制）：

- https://github.com/Achuan-2/siyuan-plugin-copilot  
- https://github.com/yangtaihong59/siyuan-plugins-mcp-sisyphus  
- https://github.com/RiviaAzusa/siyuan-agent  
- https://github.com/yangtaihong59/siyuan-plugins-ai-cli-bridge  
- https://github.com/DUZSSY/siyuan-ai-assistant  
- https://github.com/frostime/sy-f-misc  

---

## 二、总览对照

| 插件 ID | 定位简述 | Agent / 工具 | 与内核交互 | 典型技术栈 |
|---------|----------|----------------|------------|------------|
| `siyuan-plugin-copilot` | 全功能 AI 助手：上下文、多模型、Ask + Agent | 内置大量 `siyuan_*` 工具（见 `src/tools/index.ts`） | 插件内封装 `request`/块 API 等 | Vite + Svelte，依赖较少（如 Readability、KaTeX） |
| `siyuan-plugins-mcp-sisyphus` | **对外暴露 MCP + HTTP**，让外部 Agent 操作思源 | MCP 工具集按域拆分（block/document/fs/…） | 独立 **server** 构建 + 插件启动 `HttpServerLauncher`，转发到 `127.0.0.1:6806` + token | Vite 双目标 **renderer + server**，Svelte 设置 UI |
| `siyuan-agent` | 侧栏 / Tab 对话式 Agent，笔记读写 + 定时任务 | **LangChain** `StructuredTool` + 可选 **MCP 客户端** 合并工具 | `fetch`/内核 API 封装在 tools 中 | Webpack + TS，`langchain`、`@langchain/openai` 等 |
| `siyuan-plugins-ai-cli-bridge` | **不实现模型**，仅把外部 AI 网页嵌进 Dock | 无；块 ID 通过拖拽注入 iframe 页面 | 几乎只用 Dock + iframe + 拖拽 MIME | 轻量 TS 插件 |
| `siyuan-ai-assistant` | **块级文本编辑**：润色、翻译、Diff 接受拒绝 | 无通用 Agent 循环；单次补全 / 流式 | `AdapterFactory` 多厂商 + 思源块服务 | Svelte + 服务层拆分 |
| `sy-f-misc` | 个人工具箱；其中 **GPT 子模块** 含对话与思源工具 | `src/func/gpt/tools/` 下有 siyuan、文件系统等 | 可开关子功能，与 F 的其他工具并列 | Solid + `@frostime/siyuan-plugin-kits` |

---

## 三、分插件说明

### 1. SiYuan Copilot（`siyuan-plugin-copilot`）

- **功能**：描述为「拖动块、页签获取上下文，基于笔记问答和编辑」；侧栏 `AISidebar`、独立 Tab、WebView 小程序等（`src/index.ts`）。
- **实现要点**：
  - **Agent 模式**：`src/tools/index.ts` 体量很大，按 `TOOL_CATEGORIES` 组织，覆盖 SQL、块 CRUD、文档树、笔记本、属性视图、通知、网页抓取等，直接调用插件侧封装的 `../api`（对内核 HTTP 的封装）。
  - **与「官方内建 Agent」最接近**：能力集中在插件进程内，不依赖用户另起 MCP 服务即可让模型多次调用工具。
- **启发**：若内核要做 Agent，可参考其「工具 schema + 分类 + 与块/文档模型对齐」的拆分方式；需注意安全边界（SQL、删块等）与 UI 确认流程。

### 2. 西西弗斯 Sisyphus MCP（`siyuan-plugins-mcp-sisyphus`）

- **功能**：让 **外部** AI（Cursor、CLI、其他 MCP Host）通过标准 **MCP** 或 HTTP 操作思源；强调笔记本级权限、多端。
- **实现要点**：
  - 插件 `onload` 中初始化 `HttpServerLauncher`，读取 TLS、端口、思源 API URL（默认 `http://127.0.0.1:6806`）与 `siyuan.config.api.token`（`src/index.ts`）。
  - 工具按域模块化：`src/tools/block`、`document`、`fs`、`search` 等，由 registry 统一注册（`src/tools/index.ts` 为 barrel export）。
  - **架构意义**：把「Agent 大脑」放在插件外，思源只提供 **可控 API 网关**；适合与官方内核解耦、由用户自选模型宿主。
- **启发**：官方若提供「受控 MCP 或等价 RPC」，可降低每个插件重复实现 HTTP 封装；权限模型（笔记本级 token）值得对齐产品策略。

### 3. SiYuan Agent（`siyuan-agent`）

- **功能**：对话 + 笔记操作 + 模型供应商配置 + **定时任务**；支持 **MCP 工具** 与内置工具合并（`McpManager` + `getDefaultTools`，`src/index.ts`）。
- **实现要点**：
  - 使用 **LangChain 1.x**：`StructuredToolInterface`、`zod` schema；`getDefaultTools` 组合列表/搜索/编辑/计划 `writeTodos`、定时任务 CRUD 等（`src/core/tools/index.ts`）。
  - **子 Agent**：`createSubAgentTool`（如 `explore_notes`）在受限工具集上递归调用，用于控制上下文与费用。
  - 暴露 `globalThis.siyuanApp` 供工具内 `openTab` 等（需注意污染全局的取舍）。
- **启发**：内核集成可借鉴「统一 Tool 接口 + 可选 MCP 挂载 + 子 Agent 降权探索」；LangChain 非必须，但抽象层级可参考。

### 4. AI CLI Bridge（`siyuan-plugins-ai-cli-bridge`）

- **功能**：侧栏 **iframe** 加载用户配置的 URL（默认 `http://localhost:4096`）；从思源拖拽块到 iframe 时解析 `text/siyuan-block-id` 等 MIME，把 **块 ID** 交给页内输入框。
- **实现要点**：不做 LLM 调用；**集成成本最低**，适合试验 Codex Web、OpenCode、自研 Chat UI 等。
- **启发**：与 Sisyphus 组合：iframe 里跑前端，MCP 在本地连西西弗斯；官方可提供「受信任 Web 面板 + 块拖拽协议」规范，减少各插件重复造轮子。

### 5. AI Assistant（`siyuan-ai-assistant`）

- **功能**：**块级**润色、翻译、总结、自定义提示；浮动工具条、右键菜单、Diff 预览与历史；侧栏 `ChatPanel` 偏对话式辅助。
- **实现要点**：
  - `services/ai.ts`：`AdapterFactory` 切换 OpenAI 兼容 / Ollama / DeepSeek 等；流式 `streamChatCompletion`。
  - 产品重心在 **编辑闭环**（选区 → 请求 → Diff → 写回），而非多步 Agent。
- **启发**：与「Agent」互补：官方可先做强 **可控单次编辑** 与 Diff UX，再叠多步工具调用。

### 6. F's 工具箱（`sy-f-misc`）

- **说明**：**合集插件**，AI 仅为子模块之一（`declareToggleEnabled` 中 GPT 默认关闭）；还包含 Toggl、Zotero、引用等。
- **GPT 子模块**（`src/func/gpt/`）：
  - `openai`、会话 `ChatSession`、持久化、`tools/siyuan` 等，能力路径与 Copilot 有相似思路但嵌在个人工具架构内。
- **启发**：调研「AI 插件」时建议把 **sy-f-misc 仅作 GPT 子树参考**，整体不作为单一 Agent 产品对标。

---

## 四、架构模式归纳（给内核 / 官方插件的参考）

1. **进程内 Agent + 直连内核 API**（Copilot、siyuan-agent 内置工具）：延迟低、部署简单；需统一审计、配额与危险操作确认。  
2. **MCP 外置宿主**（Sisyphus）：模型与编排在外部，思源侧专注权限与 API；利于生态但依赖网络与本机服务。  
3. **iframe 外壳**（AI CLI Bridge）：最快试验第三方 UI；语义能力不在思源仓库内。  
4. **编辑优先、无工具循环**（AI Assistant）：落地快、风险面相对清晰。  

---

## 五、结论与后续试验建议

- **若目标是「与笔记深度交互的 Agent」**：优先深入 **Copilot** 与 **siyuan-agent** 的工具设计与内核调用封装；**Sisyphus** 代表「官方标准化远程能力面」的另一条轴。  
- **若目标是「快速验证多种模型 UI」**：**AI CLI Bridge** + 任意 Web Agent +（可选）MCP 最省开发量。  
- **若目标是「写作辅助而非 Agent」**：**AI Assistant** 的 Diff 与块级替换流程更值得对标。  

本地已具备完整源码树，后续可针对单点继续精读（例如：流式协议、工具 JSON Schema、错误重试、移动端 Dock 差异等）。
