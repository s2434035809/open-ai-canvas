/**
 * 作品集位图渲染（离屏重绘）。
 *
 * 为什么不复用画布实例：画布绑定视口（zoom / pan）且只渲染当前页，而导出要按页面
 * 原始尺寸出图、一次输出多页；再加上 leafer 的图片导出在未安装的 `@leafer-in/export`
 * 里，核心里的 `toCanvasData` 只是路径序列化工具，帮不上忙。所以这里按文档模型重绘。
 *
 * 坐标约定与 leafer 侧完全一致（见 portfolio-canvas.ts 的注释）：
 * 元素以左上角定位、绕自身中心旋转、zIndex 升序即绘制在上层。
 */

import type { PortfolioElement, PortfolioImageElement, PortfolioPage, PortfolioRect, PortfolioTextElement } from "@/lib/portfolio/contracts";
import { sortByZIndex } from "@/lib/portfolio/document";
import type { PortfolioAssetBundle } from "./assets";
import { canvasFont, captionBarHeight, captionFontSize, captionText, textAlignOffset, textFirstBaseline, textRunWidth, wrapTextToWidth } from "./text-layout";
import { PORTFOLIO_EXPORT_MAX_AREA, PORTFOLIO_EXPORT_MAX_EDGE, type PortfolioExportOptions } from "./types";

/** canvas 工厂，便于在无 DOM 环境注入替身。 */
export type CanvasFactory = () => HTMLCanvasElement;

/** 图注条的字体：图片元素没有自己的字体设置，统一用文档默认字体栈。 */
const CAPTION_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const CAPTION_PADDING = 12;

export class PortfolioCanvasLimitError extends Error {
    readonly width: number;
    readonly height: number;

    constructor(width: number, height: number) {
        super(`导出尺寸 ${width}×${height} 超出浏览器位图上限`);
        this.name = "PortfolioCanvasLimitError";
        this.width = width;
        this.height = height;
    }
}

export type PortfolioImageDrawParams = {
    sx: number;
    sy: number;
    sw: number;
    sh: number;
    dx: number;
    dy: number;
    dw: number;
    dh: number;
};

function defaultCanvasFactory(): HTMLCanvasElement {
    return globalThis.document.createElement("canvas");
}

/**
 * 图片在给定框内的 9 参数绘制方案。
 *
 * 三种 fit 与 leafer 的 `mode` 一一对应：`fill` ↔ `stretch`、`contain` ↔ `fit`、
 * `cover` ↔ `cover`。源图尺寸缺失时返回 null，调用方跳过该图（不画错，只留白）。
 */
export function imageDrawParams(fit: PortfolioImageElement["fit"], naturalWidth: number, naturalHeight: number, box: PortfolioRect): PortfolioImageDrawParams | null {
    if (!(naturalWidth > 0) || !(naturalHeight > 0) || !(box.width > 0) || !(box.height > 0)) return null;

    const target = { dx: box.x, dy: box.y, dw: box.width, dh: box.height };
    if (fit === "fill") {
        return { sx: 0, sy: 0, sw: naturalWidth, sh: naturalHeight, ...target };
    }
    if (fit === "contain") {
        const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
        const dw = naturalWidth * scale;
        const dh = naturalHeight * scale;
        return { sx: 0, sy: 0, sw: naturalWidth, sh: naturalHeight, dx: box.x + (box.width - dw) / 2, dy: box.y + (box.height - dh) / 2, dw, dh };
    }
    // cover：等比放大到铺满，多出来的部分从中心裁掉，因此裁的是「源矩形」。
    const boxRatio = box.width / box.height;
    const imageRatio = naturalWidth / naturalHeight;
    if (imageRatio > boxRatio) {
        const sw = naturalHeight * boxRatio;
        return { sx: (naturalWidth - sw) / 2, sy: 0, sw, sh: naturalHeight, ...target };
    }
    const sh = naturalWidth / boxRatio;
    return { sx: 0, sy: (naturalHeight - sh) / 2, sw: naturalWidth, sh, ...target };
}

/** 整册长图的像素尺寸：宽取所有页的最大宽度（页面尺寸可逐页覆盖），高为各页高度之和。 */
export function measureDocumentCanvas(pages: readonly PortfolioPage[], scale: number, gap = 0): { width: number; height: number } {
    const safeScale = scale > 0 ? scale : 1;
    const safeGap = gap > 0 ? gap : 0;
    let width = 0;
    let totalHeight = 0;
    pages.forEach((page, index) => {
        width = Math.max(width, page.width);
        totalHeight += page.height + (index > 0 ? safeGap : 0);
    });
    return { width: Math.round(width * safeScale), height: Math.round(totalHeight * safeScale) };
}

/** 位图是否在浏览器能力范围内；超限时只能降级，硬出图会得到静默的空白图。 */
export function canvasWithinLimits(width: number, height: number): boolean {
    if (!(width > 0) || !(height > 0)) return false;
    if (width > PORTFOLIO_EXPORT_MAX_EDGE || height > PORTFOLIO_EXPORT_MAX_EDGE) return false;
    return width * height <= PORTFOLIO_EXPORT_MAX_AREA;
}

function drawImageElement(ctx: CanvasRenderingContext2D, element: PortfolioImageElement, assets: PortfolioAssetBundle, options: PortfolioExportOptions) {
    const entry = assets.entries.get(element.src);
    const naturalWidth = element.naturalWidth > 0 ? element.naturalWidth : (entry?.naturalWidth ?? 0);
    const naturalHeight = element.naturalHeight > 0 ? element.naturalHeight : (entry?.naturalHeight ?? 0);
    const params = imageDrawParams(element.fit, naturalWidth, naturalHeight, { x: element.x, y: element.y, width: element.width, height: element.height });
    if (entry && params) {
        ctx.drawImage(entry.image, params.sx, params.sy, params.sw, params.sh, params.dx, params.dy, params.dw, params.dh);
    }
    drawCaptionText(ctx, element, options);
}

/** 图注是图片下方的等宽小字（画廊版式），不再压深色条盖住画面。 */
function drawCaptionText(ctx: CanvasRenderingContext2D, element: PortfolioImageElement, options: PortfolioExportOptions) {
    const text = captionText(element, options);
    if (!text || !(element.width > 0)) return;
    const barHeight = captionBarHeight(element.height);
    const fontSize = captionFontSize(barHeight);
    const top = element.y + element.height + 4;

    ctx.save();
    ctx.font = `500 ${fontSize}px ${CAPTION_FONT_FAMILY}`;
    ctx.fillStyle = "#475569";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";

    const available = element.width - CAPTION_PADDING * 2;
    let label = text;
    if (ctx.measureText(label).width > available) {
        // 逐字符回退到放得下的最长前缀，避免把文字压到图片外面。
        const characters = Array.from(text);
        while (characters.length > 0 && ctx.measureText(`${characters.join("")}…`).width > available) characters.pop();
        label = characters.length > 0 ? `${characters.join("")}…` : "";
    }
    if (label) ctx.fillText(label, element.x + CAPTION_PADDING, top);
    ctx.restore();
}

function drawTextElement(ctx: CanvasRenderingContext2D, element: PortfolioTextElement) {
    const color = element.color || "#1f2328";
    ctx.font = canvasFont(element);
    ctx.fillStyle = color;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    const measure = (value: string) => ctx.measureText(value).width;
    const lines = wrapTextToWidth(element.text, element, element.width, measure);
    const lineHeight = element.lineHeight > 0 ? element.fontSize * element.lineHeight : element.fontSize;
    const firstBaseline = textFirstBaseline(element);
    const letterSpacing = element.letterSpacing || 0;

    lines.forEach((line, index) => {
        if (line === "") return;
        const lineWidth = textRunWidth(line, letterSpacing, measure);
        const x = element.x + textAlignOffset(element.align, lineWidth, element.width);
        const y = element.y + index * lineHeight + firstBaseline;
        if (!letterSpacing) {
            ctx.fillText(line, x, y);
            return;
        }
        // canvas 没有可靠的 letterSpacing，逐字符推进；度量口径与断行时保持一致。
        let cursor = x;
        for (const character of Array.from(line)) {
            ctx.fillText(character, cursor, y);
            cursor += measure(character) + letterSpacing;
        }
    });
}

function drawElement(ctx: CanvasRenderingContext2D, element: PortfolioElement, assets: PortfolioAssetBundle, options: PortfolioExportOptions) {
    if (!(element.opacity > 0) || !(element.width > 0) || !(element.height > 0)) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, element.opacity));
    if (element.rotation) {
        const centerX = element.x + element.width / 2;
        const centerY = element.y + element.height / 2;
        ctx.translate(centerX, centerY);
        ctx.rotate((element.rotation * Math.PI) / 180);
        ctx.translate(-centerX, -centerY);
    }
    if (element.kind === "image") drawImageElement(ctx, element, assets, options);
    else drawTextElement(ctx, element);
    ctx.restore();
}

/**
 * 绘制单页。调用前 ctx 必须已经按倍率缩放，这里的坐标全部是「页面像素」。
 *
 * 页面边界会裁剪内容：导出物是「页面」，拖到页面外的元素不属于任何一页，长图拼接时
 * 让它溢出到相邻页只会更难解释。这与 Figma 导出 frame 的行为一致。
 */
function drawPage(ctx: CanvasRenderingContext2D, page: PortfolioPage, assets: PortfolioAssetBundle, options: PortfolioExportOptions) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, page.width, page.height);
    ctx.clip();
    ctx.fillStyle = page.background || "#ffffff";
    ctx.fillRect(0, 0, page.width, page.height);
    for (const element of sortByZIndex(page.elements)) {
        drawElement(ctx, element, assets, options);
    }
    ctx.restore();
}

function createScaledCanvas(page: PortfolioPage, scale: number, createCanvas: CanvasFactory): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    const canvas = createCanvas();
    canvas.width = Math.max(1, Math.round(page.width * scale));
    canvas.height = Math.max(1, Math.round(page.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前环境不支持画布渲染");
    ctx.scale(scale, scale);
    return { canvas, ctx };
}

/** 单页导出。 */
export function renderPageToCanvas(page: PortfolioPage, assets: PortfolioAssetBundle, options: PortfolioExportOptions, createCanvas: CanvasFactory = defaultCanvasFactory): HTMLCanvasElement {
    const scale = options.scale > 0 ? options.scale : 1;
    const { canvas, ctx } = createScaledCanvas(page, scale, createCanvas);
    drawPage(ctx, page, assets, options);
    return canvas;
}

/**
 * 整册长图：多页纵向拼接。
 *
 * 超限时抛 `PortfolioCanvasLimitError`，由编排层降级为「每页一张 PNG 打 zip」，
 * 而不是静默产出一张空白图。
 */
export function renderDocumentToCanvas(pages: readonly PortfolioPage[], assets: PortfolioAssetBundle, options: PortfolioExportOptions, createCanvas: CanvasFactory = defaultCanvasFactory): HTMLCanvasElement {
    const scale = options.scale > 0 ? options.scale : 1;
    const size = measureDocumentCanvas(pages, scale, options.pageGap);
    if (!canvasWithinLimits(size.width, size.height)) throw new PortfolioCanvasLimitError(size.width, size.height);

    const canvas = createCanvas();
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前环境不支持画布渲染");
    ctx.scale(scale, scale);

    let offsetY = 0;
    for (const page of pages) {
        ctx.save();
        ctx.translate(0, offsetY);
        drawPage(ctx, page, assets, options);
        ctx.restore();
        offsetY += page.height + (options.pageGap > 0 ? options.pageGap : 0);
    }
    return canvas;
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("位图编码失败"))), "image/png");
    });
}
