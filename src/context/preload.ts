import type {KernelExecutor} from "../agent/types";
import type {ContextAttachment} from "./types";
import {EXPORT_MD_BODY_OPTS, sliceMarkdownByLines} from "../tools/markdown";

/** 为附加的文档/块拉取预览文本，供系统提示使用 */
export async function preloadAttachmentPreviews(
    kernel: KernelExecutor,
    attachments: ContextAttachment[],
    maxChars = 3000,
): Promise<ContextAttachment[]> {
    const out: ContextAttachment[] = [];
    for (const a of attachments) {
        if (a.preview && a.preview.length > 50) {
            out.push(a);
            continue;
        }
        let preview = "";
        try {
            if (a.kind === "document" || a.kind === "block") {
                const r = await kernel.post("/api/export/exportMdContent", {
                    id: a.id,
                    ...EXPORT_MD_BODY_OPTS,
                });
                if (r.code === 0) {
                    const md = (r.data as {content?: string})?.content ?? "";
                    preview = sliceMarkdownByLines(md, 1, 80).content.slice(0, maxChars);
                }
            } else if (a.kind === "selection" && a.preview) {
                preview = a.preview.slice(0, maxChars);
            }
        } catch {
            preview = "";
        }
        out.push({...a, preview: preview || a.preview});
    }
    return out;
}
