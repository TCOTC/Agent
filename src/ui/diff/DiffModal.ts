import {confirmPromise} from "../../util";

/** 非阻塞 Diff 预览弹窗；返回用户是否继续 */
export function showDiffPreviewModal(html: string, title: string): Promise<boolean> {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "agent-diff-modal-overlay";
        overlay.innerHTML = `<div class="agent-diff-modal">
  <header class="agent-diff-modal__head fn__flex">
    <span class="fn__flex-1 fn__ellipsis">${escape(title)}</span>
    <button type="button" class="b3-button b3-button--text" data-close>✕</button>
  </header>
  <div class="agent-diff-modal__body agent-diff">${html}</div>
  <footer class="agent-diff-modal__foot fn__flex">
    <span class="fn__flex-1 b3-label__text">绿色为新增，红色为删除</span>
    <button type="button" class="b3-button b3-button--cancel" data-reject>取消</button>
    <button type="button" class="b3-button b3-button--text" data-accept>知道了</button>
  </footer>
</div>`;
        const close = (ok: boolean) => {
            overlay.remove();
            resolve(ok);
        };
        overlay.querySelector("[data-close]")?.addEventListener("click", () => close(false));
        overlay.querySelector("[data-reject]")?.addEventListener("click", () => close(false));
        overlay.querySelector("[data-accept]")?.addEventListener("click", () => close(true));
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) {
                close(false);
            }
        });
        document.body.appendChild(overlay);
    });
}

export async function confirmWithDiff(
    title: string,
    detail: string,
    diffHtml?: string,
): Promise<boolean> {
    if (diffHtml) {
        await showDiffPreviewModal(diffHtml, title);
    }
    return confirmPromise(title, detail);
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
