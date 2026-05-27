# Agent — 思源笔记 AI Agent 插件

专用于思源笔记的 DeepSeek Agent：多轮对话、工具调用、流式 Markdown 预览、自动风险分级与 Kramdown 精准编辑。

## 配置

1. 在思源 **设置 → 插件 → Agent** 中填写 DeepSeek API Key。
2. 模型列表通过 `GET /models` 自动拉取。
3. 侧栏可切换模型、思考模式，并附带当前文档上下文。

## 数据目录

插件 `data` 目录会保存：

- `settings.json` — API Key 与模型
- `sessions.json` — 对话会话
- `activity.jsonl` — 运行审计日志
- `token-stats.json` — Token 用量统计

## 开发

```bash
pnpm install
pnpm dev    # 输出到插件根目录 index.js
pnpm build  # 打包 dist/
```
