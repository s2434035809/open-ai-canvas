/**
 * 作品集导出对外入口。
 *
 * 一次导出固定走同一条链路：准备字体 → 读取图片 → 渲染 → 编码 → 落盘。图片读取失败
 * 只记录不中断，长图超限只降级不静默——两条异常路径都在返回值里说清楚，由 UI 汇总提示。
 */

import { zipSync } from "fflate";

import type { PortfolioDocument, PortfolioPage } from "@/lib/portfolio/contracts";
import { collectImageSources, loadPortfolioAssets, type PortfolioAssetBundle, type PortfolioAssetDeps } from "./assets";
import { savePortfolioBlob, savePortfolioText } from "./download";
import { portfolioExportFilename } from "./filename";
import { canvasToPngBlob, PortfolioCanvasLimitError, renderDocumentToCanvas, renderPageToCanvas } from "./render-canvas";
import { renderPortfolioHtml } from "./render-html";
import { defaultExportOptions, type PortfolioExportDependencies, type PortfolioExportOptions, type PortfolioExportOutcome, type PortfolioExportProgressHandler, type PortfolioExportTarget } from "./types";

export type PortfolioExportRequest = {
    target: PortfolioExportTarget;
    document: PortfolioDocument;
    /** 单页导出用；缺省取文档第一页。 */
    page?: PortfolioPage | null;
    /** 覆盖默认选项（倍率、图注开关等）。 */
    options?: Partial<PortfolioExportOptions>;
};

const ASSET_CONCURRENCY = 4;
const ASSET_TIMEOUT_MS = 15_000;

export type PortfolioExportRunOptions = PortfolioExportDependencies & {
    /** 覆盖图片读取行为（并发、超时、替身实现），测试与自定义来源用。 */
    assetLoader?: PortfolioAssetDeps;
};

export type PortfolioExportRunner = (request: PortfolioExportRequest, deps?: PortfolioExportRunOptions) => Promise<PortfolioExportOutcome>;

/** 字体未就绪时 `measureText` 会按回退字体计算，断行结果会和画布不一致。 */
async function waitForFonts(): Promise<void> {
    const fonts = (globalThis as { document?: Document }).document?.fonts;
    if (!fonts?.ready) return;
    try {
        await fonts.ready;
    } catch {
        // 字体加载失败不是导出失败：回退字体已经可用，继续走。
    }
}

function describeOutcome(base: string, failures: PortfolioAssetBundle["failures"], degraded: boolean): string {
    const parts = [base];
    if (degraded) parts.push("长图超出浏览器位图上限，已自动改为分页 zip");
    if (failures.length > 0) parts.push(`${failures.length} 张图片无法读取，已跳过`);
    return parts.join("；");
}

/** 主动清空画布尺寸，让大位图尽快被回收（长图与分页 zip 都可能连续创建多张）。 */
function releaseCanvas(canvas: HTMLCanvasElement) {
    canvas.width = 1;
    canvas.height = 1;
}

async function exportPagePng(request: PortfolioExportRequest, pages: readonly PortfolioPage[], assets: PortfolioAssetBundle, options: PortfolioExportOptions, progress: PortfolioExportProgressHandler): Promise<PortfolioExportOutcome> {
    const page = pages[0];
    progress({ phase: "render", done: 0, total: 1, label: "正在渲染当前页" });
    const canvas = renderPageToCanvas(page, assets, options);
    progress({ phase: "encode", done: 0, total: 1, label: "正在编码 PNG" });
    const blob = await canvasToPngBlob(canvas);
    const filename = portfolioExportFilename(request.document.title, page.name || "当前页", "png");
    savePortfolioBlob(blob, filename);
    const width = canvas.width;
    const height = canvas.height;
    releaseCanvas(canvas);
    return { filename, mimeType: "image/png", width, height, failures: assets.failures, degraded: false, note: describeOutcome(`已导出位图 ${width}×${height}`, assets.failures, false) };
}

/** 超限降级：每页一张 PNG 打成 zip，总尺寸不再受单张位图上限约束。 */
async function exportDocumentZip(request: PortfolioExportRequest, pages: readonly PortfolioPage[], assets: PortfolioAssetBundle, options: PortfolioExportOptions, progress: PortfolioExportProgressHandler, reason: string): Promise<PortfolioExportOutcome> {
    const entries: Record<string, Uint8Array> = {};
    for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index];
        progress({ phase: "render", done: index, total: pages.length, label: `正在渲染第 ${index + 1}/${pages.length} 页` });
        const canvas = renderPageToCanvas(page, assets, options);
        const blob = await canvasToPngBlob(canvas);
        const name = `${String(index + 1).padStart(2, "0")}-${page.name || "页"}`.replace(/[\\/:*?"<>|]/g, "");
        entries[`${name}.png`] = new Uint8Array(await blob.arrayBuffer());
        releaseCanvas(canvas);
    }
    progress({ phase: "package", done: 0, total: 1, label: "正在打包 zip" });
    // PNG 已自带压缩，这里再压一遍只会白费时间。
    const zipped = zipSync(entries, { level: 0 });
    const filename = portfolioExportFilename(request.document.title, "分页", "zip");
    savePortfolioBlob(new Blob([zipped], { type: "application/zip" }), filename);
    return { filename, mimeType: "application/zip", failures: assets.failures, degraded: true, note: describeOutcome(`已导出 ${pages.length} 页 PNG 压缩包`, assets.failures, true) + `（${reason}）` };
}

async function exportDocumentPng(
    request: PortfolioExportRequest,
    pages: readonly PortfolioPage[],
    assets: PortfolioAssetBundle,
    options: PortfolioExportOptions,
    progress: PortfolioExportProgressHandler,
    allowZipFallback: boolean,
): Promise<PortfolioExportOutcome> {
    progress({ phase: "render", done: 0, total: 1, label: `正在渲染 ${pages.length} 页长图` });
    let canvas: HTMLCanvasElement;
    try {
        canvas = renderDocumentToCanvas(pages, assets, options);
    } catch (error) {
        if (!(error instanceof PortfolioCanvasLimitError) || !allowZipFallback) throw error;
        return exportDocumentZip(request, pages, assets, options, progress, `目标尺寸 ${error.width}×${error.height}`);
    }
    progress({ phase: "encode", done: 0, total: 1, label: "正在编码 PNG" });
    const blob = await canvasToPngBlob(canvas);
    const width = canvas.width;
    const height = canvas.height;
    const filename = portfolioExportFilename(request.document.title, "长图", "png");
    savePortfolioBlob(blob, filename);
    releaseCanvas(canvas);
    return { filename, mimeType: "image/png", width, height, failures: assets.failures, degraded: false, note: describeOutcome(`已导出长图 ${width}×${height}`, assets.failures, false) };
}

function exportHtml(request: PortfolioExportRequest, pages: readonly PortfolioPage[], assets: PortfolioAssetBundle, options: PortfolioExportOptions, progress: PortfolioExportProgressHandler): PortfolioExportOutcome {
    progress({ phase: "encode", done: 0, total: 1, label: "正在生成自包含 HTML" });
    const html = renderPortfolioHtml({ pages, title: request.document.title, description: request.document.description, assets, options });
    const filename = portfolioExportFilename(request.document.title, "", "html");
    savePortfolioText(html, filename);
    const size = Math.max(1, Math.round(html.length / 1024));
    return { filename, mimeType: "text/html", failures: assets.failures, degraded: false, note: describeOutcome(`已导出 ${pages.length} 页自包含 HTML（约 ${size}KB）`, assets.failures, false) };
}

/**
 * 执行一次导出。
 *
 * `page-png` 只处理当前页；其余目标处理整册。返回值为导出结果摘要，UI 据此展示
 * 「失败图片数」与「是否降级」。
 */
export const runPortfolioExport: PortfolioExportRunner = async (request, deps = {}) => {
    const options: PortfolioExportOptions = { ...defaultExportOptions(request.target), ...request.options };
    const progress: PortfolioExportProgressHandler = deps.onProgress ?? (() => undefined);
    const allowZipFallback = deps.allowZipFallback !== false;

    const pages = request.target === "page-png" ? [request.page ?? request.document.pages[0]].filter((page): page is PortfolioPage => Boolean(page)) : request.document.pages;
    if (pages.length === 0) throw new Error("没有可导出的页面");

    progress({ phase: "collect", done: 0, total: 1, label: "正在准备导出" });
    await waitForFonts();

    const sources = collectImageSources(pages);
    progress({ phase: "assets", done: 0, total: sources.length, label: sources.length > 0 ? `正在读取 ${sources.length} 张图片` : "没有需要读取的图片" });
    const loader = deps.assetLoader ?? {};
    const assets = await loadPortfolioAssets(pages, {
        ...loader,
        concurrency: loader.concurrency ?? ASSET_CONCURRENCY,
        timeoutMs: loader.timeoutMs ?? ASSET_TIMEOUT_MS,
        onProgress: (done, total) => {
            loader.onProgress?.(done, total);
            progress({ phase: "assets", done, total, label: `正在读取图片 ${done}/${total}` });
        },
    });

    if (request.target === "document-html") return exportHtml(request, pages, assets, options, progress);
    if (request.target === "page-png") return exportPagePng(request, pages, assets, options, progress);
    return exportDocumentPng(request, pages, assets, options, progress, allowZipFallback);
};

/** 便于测试与自定义资源来源：把资源依赖显式暴露出来。 */
export type { PortfolioAssetDeps };
