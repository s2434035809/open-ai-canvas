/**
 * 自包含 HTML 导出。
 *
 * 「自包含」是硬要求：图片全部内联成 data URL，样式与自适应脚本内嵌，产出的单个
 * `.html` 双击即开、断网可看、也能直接丢到任意静态托管上。
 *
 * 版式语义采用「还原」而不是「重排」（见 types.ts 的 `htmlMode`）：每页是一个固定
 * 像素尺寸的容器，元素按文档坐标绝对定位，因此与画布看到的版式一致。窄屏下的等比
 * 缩放交给一小段内联脚本；即便脚本被禁用，页面也只是不能自动缩放，内容依然完整。
 *
 * 文字断行交给浏览器：`white-space: pre-wrap` + `word-break: break-all` 与 leafer 的
 * `textWrap: "break"` 是同一套规则（按字符断行），固定像素容器下结果一致。
 */

import type { PortfolioElement, PortfolioImageElement, PortfolioPage, PortfolioTextElement } from "@/lib/portfolio/contracts";
import { sortByZIndex } from "@/lib/portfolio/document";
import type { PortfolioAssetBundle } from "./assets";
import { captionBarHeight, captionFontSize, captionText } from "./text-layout";
import type { PortfolioExportOptions } from "./types";

export type PortfolioHtmlInput = {
    pages: readonly PortfolioPage[];
    title: string;
    description: string;
    assets: PortfolioAssetBundle;
    options: PortfolioExportOptions;
    generatedAt?: Date;
};

const STYLES = `:root{color-scheme:light}
*{box-sizing:border-box}
html,body{margin:0}
body{padding:28px 16px 56px;background:#f1f5f9;color:#1f2328;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column;align-items:center;gap:20px;overflow-x:hidden}
.pf-head{width:100%;max-width:1600px;padding:0 8px}
.pf-title{margin:0;font-size:26px;font-weight:700;line-height:1.3}
.pf-desc{margin:8px 0 0;color:#475569;font-size:15px;line-height:1.7;white-space:pre-wrap}
.pf-book{display:flex;flex-direction:column;align-items:center;gap:24px}
.pf-frame{overflow:hidden;flex:none}
.pf-page{position:relative;transform-origin:top left;overflow:hidden;box-shadow:0 12px 32px rgba(15,23,42,.14)}
.pf-el{position:absolute;margin:0;transform-origin:center center}
.pf-img{display:block;width:100%;height:100%}
.pf-caption{position:relative;display:block;margin-top:6px;color:#475569;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:500;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pf-text{white-space:pre-wrap;word-break:break-all;overflow:visible}
.pf-foot{color:#94a3b8;font-size:10px;letter-spacing:.14em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pf-pageno{position:absolute;top:10px;right:14px;z-index:9999;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;letter-spacing:.18em;color:rgba(15,23,42,.45)}`;

/** HTML 转义；所有来自文档的字符串都要经过它。 */
export function escapeHtml(value: string): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** 保留两位小数的数值，避免 inline style 里出现一长串浮点尾巴。 */
export function cssNumber(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 100) / 100;
}

function cssPx(value: number): string {
    return `${cssNumber(value)}px`;
}

function elementBoxStyle(element: PortfolioElement): string {
    return `left:${cssPx(element.x)};top:${cssPx(element.y)};width:${cssPx(element.width)};height:${cssPx(element.height)};transform:rotate(${cssNumber(element.rotation)}deg);opacity:${cssNumber(Math.min(1, Math.max(0, element.opacity)))};z-index:${element.zIndex}`;
}

function renderImageElement(element: PortfolioImageElement, assets: PortfolioAssetBundle, options: PortfolioExportOptions): string {
    const entry = assets.entries.get(element.src);
    // 读取失败的图片退回原始地址：至少在本机联网时仍能显示，而不是留一个破图占位。
    const src = entry?.dataUrl ?? element.src;
    const alt = element.caption || element.tags.join(" ") || "";
    const image = `<img class="pf-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" style="object-fit:${element.fit}" />`;

    const caption = captionText(element, options);
    if (!caption) return `<figure class="pf-el" style="${elementBoxStyle(element)}">${image}</figure>`;

    const barHeight = captionBarHeight(element.height);
    const fontSize = captionFontSize(barHeight);
    return `<figure class="pf-el" style="${elementBoxStyle(element)}">${image}<figcaption class="pf-caption" style="font-size:${cssPx(fontSize)}">${escapeHtml(caption)}</figcaption></figure>`;
}

function renderTextElement(element: PortfolioTextElement): string {
    const lineHeight = element.lineHeight > 0 ? element.lineHeight : 1;
    const style = [
        elementBoxStyle(element),
        `font-family:${element.fontFamily || "sans-serif"}`,
        `font-size:${cssPx(element.fontSize)}`,
        `font-weight:${Math.round(element.fontWeight) || 400}`,
        `line-height:${cssNumber(lineHeight)}`,
        `letter-spacing:${cssPx(element.letterSpacing || 0)}`,
        `color:${element.color || "#1f2328"}`,
        `text-align:${element.align}`,
    ].join(";");
    return `<div class="pf-el pf-text" style="${style}">${escapeHtml(element.text)}</div>`;
}

function renderPageHtml(page: PortfolioPage, assets: PortfolioAssetBundle, options: PortfolioExportOptions, index: number, pageCount: number): string {
    const elements = sortByZIndex(page.elements)
        .map((element) => (element.kind === "image" ? renderImageElement(element, assets, options) : renderTextElement(element)))
        .join("\n      ");
    const size = `width:${cssPx(page.width)};height:${cssPx(page.height)};background:${page.background || "#ffffff"}`;
    // 页码微标签：右上角等宽小字，Stitch 式的印刷台账感；不影响任何元素几何。
    const pageNumber = pageCount > 1 ? `      <span class="pf-pageno">${String(index + 1).padStart(2, "0")} / ${String(pageCount).padStart(2, "0")}</span>\n` : "";
    return `  <div class="pf-frame" data-w="${cssNumber(page.width)}" data-h="${cssNumber(page.height)}" style="width:${cssPx(page.width)};height:${cssPx(page.height)}">
    <section class="pf-page" aria-label="${escapeHtml(page.name || `第 ${index + 1} 页`)}" style="${size}">
${pageNumber}      ${elements}
    </section>
  </div>`;
}

/** 窄屏等比缩放：固定像素版面在手机上会溢出，这里按可视宽度整体缩放。 */
const FIT_SCRIPT = `(function(){var frames=[].slice.call(document.querySelectorAll(".pf-frame"));if(!frames.length)return;function fit(){var available=Math.max(240,document.documentElement.clientWidth-32);frames.forEach(function(frame){var width=parseFloat(frame.getAttribute("data-w"))||1;var height=parseFloat(frame.getAttribute("data-h"))||1;var scale=Math.min(1,available/width);var page=frame.firstElementChild;if(page)page.style.transform="scale("+scale+")";frame.style.width=width*scale+"px";frame.style.height=height*scale+"px";});}fit();window.addEventListener("resize",fit);})();`;

export function renderPortfolioHtml(input: PortfolioHtmlInput): string {
    const { pages, title, description, assets, options } = input;
    const generatedAt = input.generatedAt ?? new Date();
    const stamp = `${generatedAt.getFullYear()}-${String(generatedAt.getMonth() + 1).padStart(2, "0")}-${String(generatedAt.getDate()).padStart(2, "0")}`;
    const pageHtml = pages.map((page, index) => renderPageHtml(page, assets, options, index, pages.length)).join("\n");

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title || "作品集")}</title>
<meta name="generator" content="影策 · 作品集导出" />
<meta name="description" content="${escapeHtml(description || "")}" />
<style>
${STYLES}
</style>
</head>
<body>
<header class="pf-head">
  <h1 class="pf-title">${escapeHtml(title || "作品集")}</h1>
${description ? `  <p class="pf-desc">${escapeHtml(description)}</p>\n` : ""}</header>
<main class="pf-book">
${pageHtml}
</main>
<footer class="pf-foot">共 ${pages.length} 页 · 导出于 ${stamp}</footer>
<script>${FIT_SCRIPT}</script>
</body>
</html>
`;
}
