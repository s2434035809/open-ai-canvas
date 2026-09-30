/**
 * 文字排版度量与图注度量（纯函数，不依赖 DOM）。
 *
 * 画布用 leafer 的 `textWrap: "break"` 断行——那是「按字符断行」，中英文一视同仁、
 * 任意字符位置都能断开。canvas 的 `fillText` 不会自动断行，导出必须复刻这套规则，
 * 否则版式会与编辑时看到的差一行、差一片。
 *
 * 度量函数由调用方注入（canvas 传 `ctx.measureText`），因此这里可以脱离浏览器单测；
 * 同一份换行结果也供 HTML 导出复用，避免两套规则各自漂移。
 */

import type { PortfolioTextAlign } from "@/lib/portfolio/contracts";

export type PortfolioTextMetricsStyle = {
    fontSize: number;
    fontFamily: string;
    fontWeight: number;
    letterSpacing: number;
    lineHeight: number;
    align: PortfolioTextAlign;
};

/** 文字度量函数：输入一段文字、返回它的绘制宽度。 */
export type TextMeasure = (text: string) => number;

/** CSS font 简写。canvas 的 `ctx.font` 与 HTML 的字体声明共用同一份描述，避免两处漂移。 */
export function canvasFont(style: Pick<PortfolioTextMetricsStyle, "fontSize" | "fontFamily" | "fontWeight">): string {
    const weight = Number.isFinite(style.fontWeight) && style.fontWeight > 0 ? Math.round(style.fontWeight) : 400;
    const size = style.fontSize > 0 ? style.fontSize : 16;
    return `${weight} ${size}px ${style.fontFamily || "sans-serif"}`;
}

/** 行盒高度（页面像素）。`lineHeight` 是倍数，缺省与异常值一律按 1 处理。 */
export function textLineHeight(style: Pick<PortfolioTextMetricsStyle, "fontSize" | "lineHeight">): number {
    const ratio = style.lineHeight > 0 ? style.lineHeight : 1;
    const size = style.fontSize > 0 ? style.fontSize : 16;
    return size * ratio;
}

/**
 * 一段文字的实际绘制宽度。
 *
 * 没有字间距时按整串度量，保留字体的 kerning；一旦设置了字间距就退化为逐字符求和，
 * 因为 canvas 没有原生的 letterSpacing（`ctx.letterSpacing` 兼容性不足），绘制时也只能
 * 逐字符推进——度量口径必须与绘制口径完全一致，否则最后一行会多出或少掉一个字。
 */
export function textRunWidth(text: string, letterSpacing: number, measure: TextMeasure): number {
    const characters = Array.from(text);
    if (characters.length === 0) return 0;
    if (!letterSpacing) return measure(text);
    return characters.reduce((total, character) => total + measure(character), 0) + letterSpacing * (characters.length - 1);
}

/** 行内水平偏移：left / center / right 在给定框宽内对齐。 */
export function textAlignOffset(align: PortfolioTextAlign, lineWidth: number, boxWidth: number): number {
    if (align === "center") return (boxWidth - lineWidth) / 2;
    if (align === "right") return boxWidth - lineWidth;
    return 0;
}

/**
 * 首行基线相对元素顶部的偏移（页面像素）。
 *
 * 行盒高 = `fontSize × lineHeight`，字形在行盒里竖直居中，所以先有半行距
 * `(lineHeight - fontSize) / 2`，再加基线到字形的距离（拉丁字体的 ascent 约 0.8em）。
 * leafer 的 `verticalAlign: "top"` 与此一致。
 */
export function textFirstBaseline(style: Pick<PortfolioTextMetricsStyle, "fontSize" | "lineHeight">): number {
    const size = style.fontSize > 0 ? style.fontSize : 16;
    const lineHeight = textLineHeight(style);
    return (lineHeight - size) / 2 + size * 0.8;
}

/**
 * 按字符断行。
 *
 * 规则与 leafer 的 `break` 对齐：显式 `\n` 强制换行；其余按字符累加宽度，超框即断。
 * 单字符本身就超框时（框极窄或字号极大）仍独占一行，否则会陷入死循环。
 */
export function wrapTextToWidth(text: string, style: Pick<PortfolioTextMetricsStyle, "fontSize" | "fontFamily" | "fontWeight" | "letterSpacing">, maxWidth: number, measure: TextMeasure): string[] {
    const paragraphs = String(text ?? "").split("\n");
    const letterSpacing = style.letterSpacing || 0;
    if (!(maxWidth > 0)) return paragraphs;

    const lines: string[] = [];
    for (const paragraph of paragraphs) {
        const characters = Array.from(paragraph);
        if (characters.length === 0) {
            lines.push("");
            continue;
        }
        let current = "";
        for (const character of characters) {
            const candidate = current + character;
            if (current !== "" && textRunWidth(candidate, letterSpacing, measure) > maxWidth) {
                lines.push(current);
                current = character;
                continue;
            }
            current = candidate;
        }
        lines.push(current);
    }
    return lines;
}

export type PortfolioTextLayout = {
    lines: string[];
    /** 行盒高度，绘制与 HTML 行高共用。 */
    lineHeight: number;
    /** 全部行占用的高度；大于元素高度说明文字溢出了元素框。 */
    contentHeight: number;
    /** 首行基线相对元素顶部的偏移。 */
    firstBaseline: number;
};

export function layoutText(text: string, style: PortfolioTextMetricsStyle & { width: number; height: number }, measure: TextMeasure): PortfolioTextLayout {
    const lines = wrapTextToWidth(text, style, style.width, measure);
    const lineHeight = textLineHeight(style);
    return {
        lines,
        lineHeight,
        contentHeight: lines.length * lineHeight,
        firstBaseline: textFirstBaseline(style),
    };
}

/** 图注条的高度（页面像素）：随图片高度自适应，并限制在 24–96 之间以免喧宾夺主。 */
export function captionBarHeight(elementHeight: number): number {
    if (!(elementHeight > 0)) return 24;
    return Math.round(Math.min(96, Math.max(24, elementHeight * 0.18)));
}

/** 图注字号：始终略小于条高，保证单行可读。 */
export function captionFontSize(barHeight: number): number {
    return Math.max(11, Math.round(barHeight * 0.45));
}

/**
 * 图注条文案：把图注与标签拼成一行，供位图与 HTML 两条通道共用。
 * 两者都为空时返回空串，调用方据此跳过整条绘制。
 */
export function captionText(element: { caption: string; tags: readonly string[] }, options: { includeCaptions: boolean; includeTags: boolean }): string {
    const parts: string[] = [];
    const caption = element.caption?.trim();
    if (options.includeCaptions && caption) parts.push(caption);
    const tags = options.includeTags ? (element.tags ?? []).filter((tag) => tag && tag.trim().length > 0) : [];
    if (tags.length > 0) parts.push(tags.map((tag) => `#${tag.trim()}`).join(" "));
    return parts.join("　");
}
