# Notion Custom Agents 调研报告

> 调研日期：2026-05-14  
> 读者：思源笔记核心开发者（后续计划在思源中集成与笔记交互的 AI Agent）  
> 说明：以下内容基于 Notion 官方帮助中心、产品博客与定价说明的公开信息整理；产品能力以 Notion 当前文档为准，会随版本迭代变化。

---

## 一、产品定位与发布背景

**Custom Agents（自定义智能体）**是 Notion 在 **2026 年 2 月 24 日**正式推出的能力，定位为「可 7×24 在后台运行的自主 AI 协作者」，面向团队把重复性工作（问答、分流、状态汇总、例行报告等）从「每次手动问 AI」升级为「按触发条件自动执行的工作流」。

官方表述中的关键差异：

- 不仅是「需要时问一问」，而是「监控渠道、分流任务、汇总更新、回答问题」等**端到端工作流自动化**。
- 与右下角 **Notion Agent**（随用随问的助手）互补：前者偏**按需交互**，Custom Agents 偏**按指令 + 触发器自主运行**。

参考：[Introducing Custom Agents（Notion 博客）](https://www.notion.com/blog/introducing-custom-agents)、[Custom Agents – Help Center](https://www.notion.com/help/custom-agents)。

---

## 二、与 Notion Agent 的对比（产品层）

| 维度 | Notion Agent（通用助手） | Custom Agents |
|------|-------------------------|----------------|
| 启动方式 | 用户主动发起，边写边用 | 可配置**定时**、**Notion 事件**、**Slack 事件**等触发，发布后持续在后台运行 |
| 指令形态 | 对话式即时任务 | 明确的 **Instructions（指令）**，可配合模板或由 AI 辅助起草 |
| 数据与工具范围 | 随当前工作上下文扩展 | **显式授权**：仅能访问在「Tools & access」中勾选的页面 / 数据库 / 连接器；默认**非全工作区** |
| 典型用途 | 起草、改写、摘要、单次问答 | 周期报告、工单分流、知识库问答维护、跨工具状态同步等 |

官方帮助中心对二者差异有专门 FAQ，可优先阅读：[Custom Agents – Help Center](https://www.notion.com/help/custom-agents) 文末「How is this different from Notion Agent…」。

---

## 三、核心能力结构（可映射到「Agent 系统设计」的模块）

从实现与运营视角，可把 Custom Agents 抽象为下列模块（便于与思源后续 Agent 方案对照）：

### 3.1 指令（Instructions）

- 支持「用自然语言与 AI 对话生成初稿」或「从空白手写」。
- 官方建议：先写清**岗位与产出**，再写**步骤、输入、输出**，必要时给示例。
- 有独立的最佳实践文档入口（帮助中心内链）：[Best practices for creating and optimizing a custom agent](https://www.notion.com/help/best-practices-for-creating-and-optimizing-a-custom-agent)。

### 3.2 触发器（Triggers）

支持多类触发**组合**同一 Agent，并可加过滤条件（如特定属性值、关键词、数据库视图范围等）。

1. **定时**：按日 / 周 / 月 / 年等周期，指定时区与具体时刻。
2. **Notion 内事件**（示例）：评论新增、数据库新增页、属性更新、从数据库移除页等。
3. **Slack 事件**（示例）：频道新消息、表情反应、线程、消息中 @ 到该 Agent 等；需 Slack 侧管理员先完成连接器授权；**Slack Enterprise Grid 不在支持范围**（官方说明）。

### 3.3 工具与访问（Tools & access）

- **Notion 内**：按页面 / 数据库粒度授权；可授予「全工作区对所有人可见的页面」一类较宽范围，也可极窄范围。
- **说明**：在 Instructions 里粘贴链接**不会**自动加入授权列表，必须在 Settings 里显式添加。
- **Web**：可选开关；关闭后 Agent 仅使用 Notion 与已配置应用。
- **Slack**：读写能力受连接器与所选频道约束；与 MCP 连接器在能力边界上不同（见下文 MCP 小节）。

### 3.4 模型（Model）

- 支持 **Claude / GPT / Gemini** 等；默认推荐 **Auto**（由 Notion 按任务匹配模型）。
- 计费与模型选择相关：更复杂推理的模型通常消耗更多 **Notion credits**（见第六节）。

### 3.5 运行界面：Chat / Activity / Settings

- **Chat**：针对该 Agent 的 1:1 对话区，用于**测试指令**、跑一次性任务、迭代行为。
- **Activity**：每次运行的日志（触发来源、步骤、错误等）；对 MCP 与失败排查很重要。
- **Settings**：指令、触发器、访问范围、模型等统一入口；变更后可发布。

### 3.6 版本与可逆性

- Agent 配置支持 **Version history**，可回滚到历史版本。
- 强调对 Agent 产出与配置的**可审计、可回滚**，以降低自动化带来的运营风险。

---

## 四、协作、权限与治理

### 4.1 分享与权限级别（简化 RBAC）

对单个 Custom Agent 的权限大致为三档（官方命名）：

- **Full Access**：配置指令、触发器、访问、模型；查看活动日志；运行与交互；分享管理。
- **Can Edit**：可改指令与配置、查看活动（具体边界以官方「sharing & permissions」为准）。
- **Can View and Interact**：可运行与对话；Settings 中触发器 / 指令 / Tools & Access 多为**只读**；不可编辑或分享 Agent。

细则见：[Custom Agents sharing and permissions](https://www.notion.com/help/custom-agents-sharing-and-permissions)。

### 4.2 企业侧控制

- Enterprise 管理员可限制**谁可以创建 Agent**（路径：`Settings` → `Notion AI` → `Agents`）。
- 博客与帮助中心提到：**用量仪表盘**、**接近额度时的告警**、**额度用尽自动暂停**、**运行级日志**、**细粒度数据访问控制**、**提示词注入（prompt injection）防护与治理建议**等。

安全提示（官方立场摘要）：Agent 会读取用户可控内容（含外部工具中的文本），存在被恶意内容诱导的风险；建议缩小授权范围、审查陌生内容、用仪表盘监控异常。

---

## 五、MCP（Model Context Protocol）集成要点

Custom Agents 通过 **MCP connections** 连接外部工具：支持**预置连接器**与**自定义 MCP 服务器 URL**。

### 5.1 与「原生集成」的差异（官方区分）

- **原生集成（如 Slack）**：深度内建；需工作区 Owner 等先授权；具备**触发能力**。
- **MCP 服务器**：开放协议；成员可按规则添加；提供读写工具，但**不具备触发能力**（触发仍来自定时 / Notion / Slack 等）。

文档：[MCP connections for Custom Agents](https://www.notion.com/help/mcp-connections-for-custom-agents)。

### 5.2 自定义 MCP 的启用与认证

- 使用自定义 MCP 前，需 **Workspace Admin** 在 `Settings` → `Notion AI` → `AI connectors` 中 **Enable Custom MCP servers**。
- 自定义服务器需 **公网可访问的 hosted MCP URL**。
- 认证方式：**OAuth**（部分服务需 **Dynamic Client Registration**；若不支持则需改用 API Key / Bearer 等 **Header-based** 方式）或 **Header-based**。

### 5.3 安全模型亮点（对思源有参考价值）

- **每个 Agent 与每个 MCP 连接一一对应**：连接**不跨 Agent 共享**；撤销 A 的连接不影响 B。
- **同一 Agent 内通常不能挂多个同服务的不同账号**；若需要多账号，官方建议拆成多个 Agent。
- **工具级开关**：可按工具启用 / 禁用。
- **写操作默认需确认**：写类工具默认 **Always ask**；读类可设为 **Run automatically**（仍建议谨慎）。
- **连接建立者特权**：MCP 建立后，**仅完成认证的那个人**可更新该连接的凭据与工具执行策略；其他即使有 Full Access 也不可代管该连接的认证侧配置（官方明确说明）。

这些设计把「自动化能力」与「凭据最小集、责任边界、误操作与滥用面」绑在一起，对本地笔记 / 插件生态设计有较强借鉴意义。

---

## 六、计费：Notion credits 与 Custom Agents

### 6.1 计划门槛

- Custom Agents 面向 **Business / Enterprise**（个人免费 / Plus 等计划不在本文档所述范围）。

### 6.2 公测与正式计费时间线（以官方为准）

- 博客说明：公测期曾提供约 **两个月免费试用**（官方写明截至 **2026-05-03** 一类窗口，具体以账户与区域条款为准）。
- **2026-05-04** 起按 **Notion credits** 计量；席位价与其他 AI 能力（如 Notion Agent、部分 Enterprise Search 等）的包含关系以定价页为准。

### 6.3 credits 消耗因子（帮助中心归纳）

单次运行消耗与下列因素正相关：

1. **读取内容量**（长文、大范围检索、大数据库扫描）。
2. **步骤数**（工具调用、多跳推理与动作链）。
3. **运行频率**（定时 / 高频触发）。
4. **模型选择**（复杂模型通常更贵；官方仍推荐多数场景用 Auto）。

定价页给出若干「典型 Agent 类型」的**单次成本区间与每千 credits 可跑次数量级**的示例表，便于财务与容量规划：[Buy & track Notion credits for Custom Agents](https://www.notion.com/help/custom-agent-pricing)。

### 6.4 额度用尽行为

- credits 用尽后，Custom Agents **自动暂停**；管理员增购或等到周期重置后可恢复。
- 其他非 credits 计费的 AI 功能在公平使用限制内仍可使用（官方说明）。

---

## 七、对思源笔记集成 Agent 的启发（非对标承诺，仅设计参考）

下列为从 Notion 公开信息抽象出的**可迁移思路**，不代表思源应采取相同商业或技术路线。

1. **双轨产品心智**  
   - 「边写边问」的助手 vs 「可订阅触发 + 明确授权范围」的 Agent，降低用户把自动化误当成全库上帝模式的预期风险。

2. **授权模型优先于模型能力**  
   - 默认最小权限；Instructions 里的链接不等于授权；对「全库可见页面」一类能力要谨慎产品设计。

3. **触发器是一等公民**  
   - 定时 + 文档 / 数据库事件 +（若未来有协作 IM）外部事件，决定 Agent 是否真能成为工作流基础设施，而非聊天挂件。

4. **可观测性与可回滚**  
   - 每次运行的结构化日志、配置版本历史、写操作确认策略，是团队场景落地的硬需求。

5. **开放工具层（MCP）与原生 API 的边界**  
   - MCP 灵活但无触发；原生集成体验统一但工程耦合高。思源若已有内核 API + 插件体系，可考虑：**内核能力原生暴露**、**社区 / 第三方通过 MCP 或插件 RPC 扩展**，并明确安全与凭据归属（Notion 的「每 Agent 每连接独立凭据」值得参考）。

6. **计量与公平使用**  
   - 后台 Agent 对 token 与 API 调用是「放大器」；需提前设计配额、按工作区 / 按用户、以及耗尽后的降级策略（对标 credits 仪表盘与自动暂停）。

7. **提示词注入与内容源信任**  
   - 对「Agent 会读用户笔记与外链内容」的产品，需在架构层考虑过滤、沙箱、敏感写操作二次确认，并在文档中向用户说明风险模型。

---

## 八、信息源与延伸阅读

| 主题 | 链接 |
|------|------|
| 总览与功能说明 | https://www.notion.com/help/custom-agents |
| 产品发布与叙事 | https://www.notion.com/blog/introducing-custom-agents |
| 产品落地页 | https://www.notion.com/product/custom-agents |
| MCP 与 Custom Agents | https://www.notion.com/help/mcp-connections-for-custom-agents |
| credits 与定价 | https://www.notion.com/help/custom-agent-pricing |
| credits 仪表盘说明 | https://www.notion.com/help/notion-credits-dashboard |
| 管理员入门指南 | https://www.notion.com/help/guides/admin-guide-to-getting-started-with-custom-agents |
| 模板入口（官方） | https://www.notion.com/custom-agent-templates |

---

## 九、调研局限

- 未在付费工作区中做 hands-on 实测；具体 UI 流程、连接器列表、区域策略以实际账号为准。
- Notion 迭代较快，触发器类型、支持的应用与 MCP 预置列表可能更新，集成前建议再扫一遍上述官方链接。

---

*报告结束。*
