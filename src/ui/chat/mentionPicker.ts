import type {KernelExecutor} from "../../agent/types";

export interface MentionHit {
    id: string;
    label: string;
    sub?: string;
}

export async function searchMentionHits(
    kernel: KernelExecutor,
    query: string,
    limit = 12,
): Promise<MentionHit[]> {
    const q = query.trim();
    if (!q) {
        return [];
    }
    const r = await kernel.post("/api/search/fullTextSearchBlock", {
        query: q,
        paths: [],
        page: 1,
        pageSize: limit,
        method: 0,
    });
    if (r.code !== 0 || !Array.isArray(r.data)) {
        return [];
    }
    return (r.data as Record<string, unknown>[]).map((b) => ({
        id: String(b.id ?? ""),
        label: typeof b.content === "string" ? b.content.slice(0, 48) : String(b.id),
        sub: typeof b.hPath === "string" ? b.hPath : undefined,
    }));
}

export function renderMentionMenu(hits: MentionHit[]): HTMLElement {
    const menu = document.createElement("div");
    menu.className = "agent-mention-menu";
    if (!hits.length) {
        menu.innerHTML = `<div class="agent-mention-menu__empty">无匹配块</div>`;
        return menu;
    }
    for (const h of hits) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "agent-mention-menu__item";
        btn.dataset.id = h.id;
        btn.innerHTML = `<span class="agent-mention-menu__label">${esc(h.label)}</span>${
            h.sub ? `<span class="agent-mention-menu__sub">${esc(h.sub)}</span>` : ""
        }`;
        menu.appendChild(btn);
    }
    return menu;
}

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
