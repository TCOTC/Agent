/**
 * 流式 Markdown 封存边界用的 Lute：`Md2BlockDOM` 通过 `window.Lute.New` 创建，开关与思源 setLute 对齐；实例见 `getLuteResult`（单例延迟初始化）。
 * HTML 预览仍走内核 `md2html`（见 `streamMdRender.ts`）。
 */

interface LuteGlobalNs {
    New(options?: unknown): LuteEngine;
}

/** 与编辑器 Protyle 中 Lute 实例对齐的最小类型，供 `Md2BlockDOM` 与开关方法使用。 */
export interface LuteEngine {
    Md2BlockDOM(markdown: string, reserveEmptyParagraph?: boolean): string;
    SetSpin?(v: boolean): void;
    SetProtyleWYSIWYG?(v: boolean): void;
    SetProtyleMarkNetImg?(v: boolean): void;
    SetHeadingID?(v: boolean): void;
    SetYamlFrontMatter?(v: boolean): void;
    SetFootnotes?(v: boolean): void;
    SetToC?(v: boolean): void;
    SetIndentCodeBlock?(v: boolean): void;
    SetParagraphBeginningSpace?(v: boolean): void;
    SetSetext?(v: boolean): void;
    SetLinkRef?(v: boolean): void;
    SetSanitize?(v: boolean): void;
    SetKramdownIAL?(v: boolean): void;
    SetTag?(v: boolean): void;
    SetSuperBlock?(v: boolean): void;
    SetImgPathAllowSpace?(v: boolean): void;
    SetBlockRef?(v: boolean): void;
    SetFileAnnotationRef?(v: boolean): void;
    SetMark?(v: boolean): void;
    SetSup?(v: boolean): void;
    SetSub?(v: boolean): void;
    SetInlineMathAllowDigitAfterOpenMarker?(v: boolean): void;
    SetHTMLTag2TextMark?(v: boolean): void;
    SetTextMark?(v: boolean): void;
    SetUnorderedListMarker?(m: string): void;
    SetDataTask?(v: boolean): void;
    SetExportNormalizeTaskListMarker?(v: boolean): void;
    SetArbitraryTaskListItemMarker?(v: boolean): void;
    SetCallout?(v: boolean): void;
    SetSpellcheck?(v: boolean): void;
    SetInlineAsterisk?(v: boolean): void;
    SetInlineUnderscore?(v: boolean): void;
    SetInlineMath?(v: boolean): void;
    SetGFMStrikethrough1?(v: boolean): void;
    SetGFMStrikethrough?(v: boolean): void;
}

function configureLute(engine: LuteEngine): void {
    // 与思源 setLute 对齐的主要开关，使 `window.Lute.New` 实例的 `Md2BlockDOM` 与编辑器块边界一致（此处不做任何 HTML 渲染）
    engine.SetSpin?.(true);
    engine.SetProtyleWYSIWYG?.(true);
    engine.SetFileAnnotationRef?.(true);
    engine.SetHTMLTag2TextMark?.(true);
    engine.SetTextMark?.(true);
    engine.SetHeadingID?.(false);
    engine.SetYamlFrontMatter?.(false);
    engine.SetInlineMathAllowDigitAfterOpenMarker?.(true);
    engine.SetToC?.(false);
    engine.SetIndentCodeBlock?.(false);
    engine.SetParagraphBeginningSpace?.(true);
    engine.SetSetext?.(false);
    engine.SetFootnotes?.(false);
    engine.SetLinkRef?.(false);
    engine.SetSanitize?.(true);
    engine.SetKramdownIAL?.(true);
    engine.SetTag?.(true);
    engine.SetSuperBlock?.(true);
    engine.SetCallout?.(true);
    engine.SetBlockRef?.(true);
    engine.SetImgPathAllowSpace?.(true);
    engine.SetUnorderedListMarker?.("-");
    engine.SetDataTask?.(true);
    engine.SetExportNormalizeTaskListMarker?.(true);
    engine.SetArbitraryTaskListItemMarker?.(true);
    const cfg = (window as unknown as {siyuan?: {config?: {editor?: {
        spellcheck?: boolean;
        displayNetImgMark?: boolean;
        markdown?: Record<string, boolean>;
    }}}}).siyuan?.config?.editor;
    if (cfg) {
        engine.SetSpellcheck?.(Boolean(cfg.spellcheck));
        engine.SetProtyleMarkNetImg?.(Boolean(cfg.displayNetImgMark));
        const md = cfg.markdown ?? {};
        engine.SetInlineAsterisk?.(Boolean(md.inlineAsterisk));
        engine.SetInlineUnderscore?.(Boolean(md.inlineUnderscore));
        engine.SetSup?.(Boolean(md.inlineSup));
        engine.SetSub?.(Boolean(md.inlineSub));
        engine.SetTag?.(Boolean(md.inlineTag));
        engine.SetInlineMath?.(Boolean(md.inlineMath));
        engine.SetGFMStrikethrough1?.(false);
        engine.SetGFMStrikethrough?.(Boolean(md.inlineStrikethrough));
        engine.SetMark?.(Boolean(md.inlineMark));
    } else {
        engine.SetInlineMath?.(true);
    }
}

let cachedLute: LuteEngine | undefined;

export type GetLuteResult =
    | {ok: true; lute: LuteEngine}
    | {ok: false; message: string};

/** 获取与 Protyle 对齐的 Lute 单例；不可用时返回 `ok: false`（非异常路径） */
export function getLuteResult(): GetLuteResult {
    if (cachedLute) {
        return {ok: true, lute: cachedLute};
    }
    const LuteNs = (window as unknown as {Lute?: LuteGlobalNs}).Lute;
    if (!LuteNs?.New) {
        return {
            ok: false,
            message: "Lute 不可用：请在思源笔记客户端中使用本插件。",
        };
    }
    const engine = LuteNs.New(undefined) as LuteEngine;
    configureLute(engine);
    cachedLute = engine;
    return {ok: true, lute: engine};
}

/** 插件 onunload 时丢弃本模块缓存的 Lute 实例，便于热重载后再由 `getLuteResult` 懒建。 */
export function destroyCachedLute(): void {
    cachedLute = undefined;
}
