/** Tool 返回内容最大字符数 */
export const MAX_TOOL_OUTPUT_CHARS = 14_000;

/** DeepSeek API 根地址（可在设置中覆盖，默认与此一致） */
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

/** 活动日志与 token 统计持久化键 */
export const STORAGE_KEY_ACTIVITY = "activity.jsonl";
export const STORAGE_KEY_TOKEN_STATS = "token-stats.json";
export const STORAGE_KEY_SESSIONS = "sessions.json";

/** 自动放行风险分上限（0–100，越高越危险） */
export const RISK_AUTO_APPROVE_MAX = 35;

/** 必须用户确认的风险分下限 */
export const RISK_MUST_CONFIRM_MIN = 72;
