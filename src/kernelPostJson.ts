/**
 * 向内核 POST JSON，使用标准 fetch，不经过思源 `fetchSyncPost`（避免 `processMessage` 等副作用）。
 */

export interface KernelPostJsonResult<T = unknown> {
    code: number;
    msg: string;
    data: T | null;
}

/**
 * POST JSON 到给定 URL（通常为相对路径如 `/api/...`），解析 JSON 体为 `{ code, msg?, data? }`。
 * 网络或 JSON 解析失败时返回 `code !== 0`，由调用方处理。
 */
export async function postKernelJson<T = unknown>(
    url: string,
    body: Record<string, unknown> = {},
): Promise<KernelPostJsonResult<T>> {
    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(body),
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {code: -1, msg, data: null};
    }

    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
        const text = await res.text().catch(() => "");
        return {
            code: res.ok ? -1 : -res.status || -1,
            msg: text.trim() || res.statusText || `HTTP ${res.status}`,
            data: null,
        };
    }

    try {
        const json = (await res.json()) as {code?: unknown; msg?: unknown; data?: T | null};
        const code = typeof json.code === "number" ? json.code : -1;
        const msg = typeof json.msg === "string" ? json.msg : "";
        return {code, msg, data: json.data ?? null};
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {code: -1, msg, data: null};
    }
}
