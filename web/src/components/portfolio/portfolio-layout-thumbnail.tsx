/**
 * 版式方案缩略预览：把「当前页 + 该方案」离屏渲染到一块小 canvas。
 *
 * 规则与导出通道（export/text-layout、render-canvas）保持一致：同一套换行/图注/裁切，
 * 用户在小图上看到的排版就是应用后页面上会出现的排版。图片加载失败时画占位灰块，
 * 不让整个预览卡住。
 */

import { useEffect, useRef } from "react";

import { type PortfolioImageElement, type PortfolioPage, type PortfolioTextElement } from "@/lib/portfolio/contracts";
import type { PortfolioLayoutOption } from "@/lib/portfolio/agent-run";
import { imageDrawParams } from "@/lib/portfolio/export/render-canvas";
import { canvasFont, textFirstBaseline, textAlignOffset, textRunWidth, wrapTextToWidth } from "@/lib/portfolio/export/text-layout";

type DrawElement = PortfolioImageElement | PortfolioTextElement;

function loadImage(source: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
        const image = new Image();
        if (!source.startsWith("data:")) image.crossOrigin = "anonymous";
        const timer = window.setTimeout(() => resolve(null), 4000);
        image.onload = () => {
            window.clearTimeout(timer);
            resolve(image);
        };
        image.onerror = () => {
            window.clearTimeout(timer);
            resolve(null);
        };
        image.src = source;
    });
}

/** 把方案套到页面上，得到预览元素列表：既有元素打补丁 + 新增文本。 */
function elementsWithOption(page: PortfolioPage, option: PortfolioLayoutOption): DrawElement[] {
    const byId = new Map<string, DrawElement>();
    for (const element of page.elements) byId.set(element.id, { ...element });
    const additions: DrawElement[] = [];
    let nextZ = page.elements.reduce((max, element) => Math.max(max, element.zIndex), 0) + 1;
    for (const item of option.elements) {
        if (item.elementId) {
            const target = byId.get(item.elementId);
            if (!target) continue;
            const patch: Record<string, unknown> = {};
            if (item.x !== undefined) Object.assign(patch, { x: item.x, y: item.y, width: item.width, height: item.height });
            if (item.caption !== undefined && target.kind === "image") patch.caption = item.caption;
            if (item.tags !== undefined && target.kind === "image") patch.tags = item.tags;
            if (item.text !== undefined && target.kind === "text") patch.text = item.text;
            if (item.fontSize !== undefined) patch.fontSize = item.fontSize;
            if (item.color !== undefined) patch.color = item.color;
            if (item.align !== undefined) patch.align = item.align;
            if (item.lineHeight !== undefined) patch.lineHeight = item.lineHeight;
            if (item.letterSpacing !== undefined) patch.letterSpacing = item.letterSpacing;
            if (Object.keys(patch).length > 0) byId.set(target.id, { ...target, ...patch });
            continue;
        }
        if (item.kind !== "text" || !item.text || item.x === undefined || item.y === undefined || !item.width || !item.height) continue;
        additions.push({
            id: `option-text-${nextZ}`,
            kind: "text",
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
            rotation: 0,
            zIndex: nextZ++,
            locked: false,
            opacity: 1,
            text: item.text,
            fontSize: item.fontSize ?? 40,
            fontFamily: "Inter, system-ui, sans-serif",
            fontWeight: item.role === "title" ? 600 : 400,
            color: item.color ?? "#1f2328",
            align: item.align ?? "left",
            lineHeight: item.lineHeight ?? 1.4,
            letterSpacing: item.letterSpacing ?? 0,
        });
    }
    return [...byId.values(), ...additions].sort((a, b) => a.zIndex - b.zIndex);
}

function drawTextElement(ctx: CanvasRenderingContext2D, element: PortfolioTextElement) {
    if (!(element.width > 0) || !(element.height > 0) || !element.text.trim()) return;
    ctx.font = canvasFont(element);
    ctx.fillStyle = element.color || "#1f2328";
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    const measure = (value: string) => ctx.measureText(value).width;
    const lines = wrapTextToWidth(element.text, element, element.width, measure);
    const lineHeight = (element.lineHeight > 0 ? element.lineHeight : 1) * (element.fontSize > 0 ? element.fontSize : 16);
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
        let cursor = x;
        for (const character of Array.from(line)) {
            ctx.fillText(character, cursor, y);
            cursor += measure(character) + letterSpacing;
        }
    });
}

function drawImageElement(ctx: CanvasRenderingContext2D, element: PortfolioImageElement, image: HTMLImageElement | null, captionOn: boolean) {
    if (!(element.width > 0) || !(element.height > 0)) return;
    const naturalWidth = element.naturalWidth || image?.naturalWidth || 0;
    const naturalHeight = element.naturalHeight || image?.naturalHeight || 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(element.x, element.y, element.width, element.height);
    ctx.clip();
    if (image && naturalWidth > 0 && naturalHeight > 0) {
        const params = imageDrawParams(element.fit, naturalWidth, naturalHeight, { x: element.x, y: element.y, width: element.width, height: element.height });
        if (params) ctx.drawImage(image, params.sx, params.sy, params.sw, params.sh, params.dx, params.dy, params.dw, params.dh);
    } else {
        ctx.fillStyle = "rgba(148, 163, 184, 0.35)";
        ctx.fillRect(element.x, element.y, element.width, element.height);
    }
    ctx.restore();
    if (captionOn && element.caption.trim()) {
        const fontSize = Math.max(8, Math.min(14, element.height * 0.09));
        ctx.font = `500 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.fillStyle = "#475569";
        ctx.textBaseline = "top";
        const label = element.caption.length > 28 ? `${element.caption.slice(0, 28)}…` : element.caption;
        ctx.fillText(label, element.x + 4, element.y + element.height + 3);
    }
}

export function PortfolioLayoutThumbnail({ page, option, width = 224 }: { page: PortfolioPage; option: PortfolioLayoutOption; width?: number }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        let cancelled = false;
        const scale = width / (page.width > 0 ? page.width : 1);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(page.height * scale * dpr);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.scale(dpr * scale, dpr * scale);

        const elements = elementsWithOption(page, option);
        const imageSources = Array.from(new Set(elements.filter((element) => element.kind === "image").map((element) => element.src)));
        void Promise.all(imageSources.map((source) => loadImage(source))).then((images) => {
            if (cancelled) return;
            const bySource = new Map<string, HTMLImageElement | null>();
            imageSources.forEach((source, index) => bySource.set(source, images[index]));
            ctx.fillStyle = page.background || "#ffffff";
            ctx.fillRect(0, 0, page.width, page.height);
            for (const element of elements) {
                if (element.kind === "image") drawImageElement(ctx, element, bySource.get(element.src) ?? null, true);
                else drawTextElement(ctx, element);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [page, option, width]);

    return <canvas ref={canvasRef} style={{ width: "100%", aspectRatio: `${page.width} / ${page.height}` }} className="block rounded-[var(--r-sm)] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.45)]" />;
}
