# 流式 Markdown 封存策略讨论记录

本文档整理 Agent 插件中流式渲染 Markdown 时「封存边界」相关的问题、成因与后续改进方向（讨论结论），便于实现与评审时对照。

---

## 1. 背景与现象

助手消息以 SSE 等方式流式追加 Markdown，插件为减少重复 `md2html` 请求，会对已稳定的**前缀**做「封存」，仅对**尾部**反复请求 `/api/lute/md2html`。

在典型示例（标题行 + GFM 围栏代码块）下，曾出现：

- 网络请求体将 **```** 拆成多段（例如 ``\n``、```` `` ````、`` `python\n... ``）；
- 预览 DOM 出现多个 `<p>`、残缺反引号，无法形成正常代码块。

说明：**封存切分落在 Markdown 词法不安全的位置**（例如围栏定界符中间），而非模型把「语言标识」换行输出。

---

## 2. 实现要点（`render/streamMdRender.ts`，已更新）

1. 用 Lute **`Md2BlockDOM(md, false)`** 得到 Block DOM HTML，统计**顶层子节点个数**。
2. 对当前 **`tail`**：若整段顶层块数 **≥ 2**，尝试封存「第一块」。
3. **`hi`**：仍用二分求 **`maxPrefixSingleTopBlockLen`**（最大 `L` 使 `tail.slice(0,L)` 顶层块数 ≤ 1）。
4. **对齐判据**：取整段 `tail` 的**第一块 `innerHTML`** 为基准；在 `L ∈ [1, hi]` 中从 **`hi` 向下**寻找满足「`tail.slice(0,L)` 顶层块数恰好为 1 且首块 `innerHTML` 与基准一致」的最大 `L`（先扫 `[max(1, hi - delta), hi]`，再扫余下区间；`delta` 来自缓存的 **`lastTailLen`** 与当前 `tail.length` 的差；同一次调用内第二轮及以后封存 **`lastTailLen` 视作 0** 以全区间扫描）。
5. 若无合法 **`L`**，本帧不封存；否则封存并 `md2html`，更新 **`lastTailLen`** 为当前剩余 `tail` 长度。
6. 循环可对多块连续封存；剩余部分始终做一次 `md2html` 作为尾部预览。

**重要**：封存不再仅凭「块数 ≤ 1」的边界，还须与整段 `tail` 的首块渲染内容一致，以避免围栏 ``` 未写完时的误切分。

---

## 3. 根因归纳

| 层面 | 说明 |
|------|------|
| 插件 | 「顶层块数 + 二分」是**启发式**：在**不完整** Markdown 上，块数从 1 变 2 的跳变点可落在 **```** 等多字符定界符**中间**，与「第一块已语法完整」不等价。 |
| 思源 `/api/lute/md2html` | 对**单次传入的字符串**按 Markdown 解析；若传入的是被锯断的片段，输出异常属于预期。 |
| Lute | `Md2BlockDOM` 内部为 **`parse.Parse` 全文 + 渲染**；**无**现成 API 给出「在原文中安全的切分下标」；解析结束后 lexer 不保留给调用方做增量边界查询。 |

因此：**问题主因在插件封存策略**，而非「完整文档一次性 md2html」的解析错误。

---

## 4. 错误切分过程（问题示例，概念链）

1. `tail` 逐步增长；某一帧停在类似 ``**标题**\n`` ``（仅两个反引号，第三个尚未到达）。
2. 该帧上 **`Md2BlockDOM(tail)`** 顶层块数 **≥ 2**，进入封存循环。
3. 二分得到最大的 **`L`**，使前缀仍只有 1 个顶层块；**`L` 落在 ``` 中间**。
4. **`tail.slice(0, L)`** 被永久封存并 `md2html`；剩余 `tail` 以残缺围栏开头，可能再次触发畸形封存或仅尾部渲染。
5. 多次请求体对应多段**不完整** Markdown，拼接后的 DOM 即用户所见错乱。

（时间轴上并非「模型把 ``` 与语言拆成两行」，而是**字符尚未到齐时已按块数切分**。）

---

## 5. 讨论形成的改进方案（已在 `render/streamMdRender.ts` 实现）

以下为已落地的**组合策略**，与原先「仅数块数 + 二分」相比更严、更贴近「前缀与整段解析一致」。

### 5.1 用「整段 `tail` 的渲染结果」作基准，而不是只比块数

- 对**当前完整** `tail` 调用 `Md2BlockDOM`，得到顶层块 HTML（或等价结构）。
- 寻找切分长度 **`L`**，使得 **`Md2BlockDOM(tail.slice(0, L))`** 的**前 k 个顶层块**（k 与当前策略一致，例如先对齐「第一块」则 k=1；若策略为一次封存多块再相应取 k）在**规范化后**与整段 `tail` 渲染结果中的**前 k 块**一致。

**注意**：Protyle 块根节点常带 **`id` / `updated`** 等不稳定属性，**不宜**直接整段外层 HTML 字符串相等比较。

**可行做法（讨论结论）**：将 HTML 插入**临时 DOM**，对每个顶层块比较 **`innerHTML`**（或克隆后去掉块壳上的属性再序列化），从而**忽略块根上的属性差异**，再比较内容结构。

### 5.2 搜索顺序：先窄区间二分，再向前线性回退

**目的**：在多数流式场景下，切点 `L` 靠近**本轮新追加的末尾**，先小范围尝试可省调用次数。

1. **优先**：在区间 `[max(1, hi - delta), hi]` 内从 **`hi` 向下线性扫描**（`delta = max(1, tail.length - lastTailLen)`，`hi` 仍为 `maxPrefixSingleTopBlockLen`），首个满足判据的 `L` 即为最大合法切点。
2. **若未找到**：再从 **`lo - 1` 递减到 `1`** 扫描；仍无则本帧不封存（`L = 0`，跳出封存循环）。

实现说明：判据「`innerHTML` 与整段首块一致」在 `L` 上未必单调，故未对「是否匹配」做二分，仅在 `hi` 的确定上沿用原 `maxPrefixSingleTopBlockLen` 的二分；窄区间优先扫描等价于文档中的「先在新增长度附近找，再向前回退」。

### 5.3 明确暂不纳入讨论的范围

| 项 | 结论 |
|----|------|
| **封存提交后不可回滚**（过早封存导致与后续 token 无法在同一解析里纠正） | 讨论中决定**先忽略**，不在首版方案中单独建模。 |
| **脚注** | 当前约定：**不考虑**（Lute / 业务侧不使用）。 |
| **链接引用定义**（文末 `[ref]: url` 影响前文 `[x][ref]` 的解析） | 未强制纳入；若日后开启相关语法，需知「前缀单独解析」可能与「整段解析」的前缀字节在呈现上不一致，届时再收紧判据。 |

### 5.4 与「行是否写完」类启发式的关系（背景）

讨论中曾区分：

- **仅顶层块数**：易在围栏中间切分；
- **「有换行就封上一行」**：易误伤 CommonMark 下**多行同属一段**的正文，不能简单等同块边界。

本文档记录的方案以 **DOM 规范化对齐** + **搜索区间启发式** 为主；若后续要叠加「末尾无换行且流未结束则不封存」等规则，可作为独立条款补充。

---

## 6. Lute 侧结论（查阅仓库后的摘要）

- `Md2BlockDOM` ≈ `parse.Parse` + Protyle 渲染；`Md2BlockDOMTree` 在 Go 中可返回 `*parse.Tree`，但**节点上无通用「原文绝对字节区间」**可直接作为封存下标。
- **无**面向插件的「流式安全切分点」官方 API；若在不动 Lute 的前提下要更准，应在**插件（或思源内核新 API）**用 AST/HTML 对比与附加约束实现。

---

## 7. 实现时可对照的文件

- `src/render/streamMdRender.ts`：`getStreamingAssistantMdParts`、`finalizeStreamingMdRemainder`、`findSealLenFirstBlockAligned`、`getFirstBlockInnerFromMd`、`maxPrefixSingleTopBlockLen`、`countTopLevelBlockDivs`。
- `src/render/lute.ts`：`getLute`、与思源 setLute 对齐的 Lute 开关（供 `Md2BlockDOM` 封存边界；`window.Lute.New` 单例）。
- `src/render/protyleBlockRender.ts`：`renderProtyleBlock(blocks, blocksRoot)`（多块块级渲染；子树含 `.code-block code` 时对 `blocksRoot` 调用一次 `highlightRender`）。
- `src/dock.ts`：`syncStreamingMdHost` 与封存 HTML 挂载逻辑。

---

## 8. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-05-15 | 初稿：根据对话整理问题、成因与待实现方案要点。 |
| 2026-05-15 | 在 `render/streamMdRender.ts` 实现首块 `innerHTML` 对齐 + `lastTailLen` 窄区间扫描；`finalize` 后重置 `lastTailLen`。 |
| 2026-05-15 | 目录调整：`streamMdRender` 等迁入 `src/render/`，Dock 逻辑迁至 `src/dock.ts`。 |
| 2026-05-15 | Lute 抽取为 `lute.ts`；`agentProcessRender` 更名为 `protyleBlockRender` / `renderProtyleBlock`。 |
| 2026-05-16 | `renderProtyleBlock` 合并原 `typographyPostRender`：参数 `blocks` + `blocksRoot`；仅当子树含 `.code-block code` 时 `highlightRender` 一次。 |
