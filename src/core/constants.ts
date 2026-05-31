/** Tool 返回内容最大字符数 */
export const MAX_TOOL_OUTPUT_CHARS = 14_000;

/** DeepSeek API 根地址（可在设置中覆盖，默认与此一致） */
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

/** token 统计与会话持久化键 */
export const STORAGE_KEY_TOKEN_STATS = "token-stats.json";
export const STORAGE_KEY_SESSIONS = "sessions.json";

/** 自动放行风险分上限（0–100，越高越危险；与设置项 riskAutoApproveMax 默认值一致） */
export const RISK_AUTO_APPROVE_MAX = 35;
