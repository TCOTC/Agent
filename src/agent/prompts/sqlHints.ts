/** 常用只读 SQL 模板，注入系统提示供模型参考 */
export const SQL_TEMPLATES = `
## SQL 参考（只读）
- 最近更新文档：SELECT id, content, hpath, updated FROM blocks WHERE type='d' ORDER BY updated DESC LIMIT 20
- 按路径查文档：SELECT id, content, hpath FROM blocks WHERE hpath LIKE '/笔记本名/%' AND type='d' LIMIT 32
- 查某文档下块：SELECT id, type, content FROM blocks WHERE root_id='文档根ID' LIMIT 64
- 标签：SELECT * FROM tags LIMIT 50
`.trim();
