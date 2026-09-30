/**
 * 作品集导出的公共契约。
 *
 * 导出层只读文档模型、不写回，所以这里描述的都是「输入选项」与「输出结果」。所有
 * 选项都给出显式默认值并按目标区分，避免调用方各自拍脑袋决定图注是否要带。
 */

import type { PortfolioPage } from "@/lib/portfolio/contracts";

/** 可选倍率：1x 用于快速预览，2x 用于交付。位图边长随倍率线性放大。 */
export const PORTFOLIO_EXPORT_SCALES = [1, 2] as const;
export type PortfolioExportScale = (typeof PORTFOLIO_EXPORT_SCALES)[number];
export const PORTFOLIO_EXPORT_DEFAULT_SCALE: PortfolioExportScale = 2;

/**
 * 位图上限。取各浏览器能力的保守交集再留一档余量：
 * 单边 16384 像素、总面积 6400 万像素（约等于 3200×20000 的长图）。
 * 超出时不再硬出图，而是降级为分页 zip——浏览器超限时只会静默产出空白图，比报错更难排查。
 */
export const PORTFOLIO_EXPORT_MAX_EDGE = 16384;
export const PORTFOLIO_EXPORT_MAX_AREA = 64_000_000;

/**
 * HTML 导出的语义。
 *
 * - `layout`：像素级复刻画布版式（本轮实现），适合提案交付；
 * - `semantic`：图片 + 图注 + 按标签分组的响应式作品集（预留，见契约里的 `caption`/`tags` 注释）。
 */
export type PortfolioHtmlMode = "layout" | "semantic";

export type PortfolioExportTarget = "page-png" | "document-png" | "document-html";

export type PortfolioExportOptions = {
    /** 位图倍率，仅对 PNG 导出生效。 */
    scale: number;
    /** 图注是否进入导出物。 */
    includeCaptions: boolean;
    /** 分类标签是否进入导出物。 */
    includeTags: boolean;
    /** 长图页间留白，单位为页面像素（会随倍率一同放大）。 */
    pageGap: number;
    htmlMode: PortfolioHtmlMode;
};

/** 各目标的默认选项：PNG 保持版式干净，HTML 保留图注与标签作为语义信息。 */
export function defaultExportOptions(target: PortfolioExportTarget): PortfolioExportOptions {
    const semantic = target === "document-html";
    return {
        scale: PORTFOLIO_EXPORT_DEFAULT_SCALE,
        includeCaptions: semantic,
        includeTags: semantic,
        pageGap: 0,
        htmlMode: "layout",
    };
}

export type PortfolioExportPhase = "collect" | "assets" | "render" | "encode" | "package";

export type PortfolioExportProgress = {
    phase: PortfolioExportPhase;
    done: number;
    total: number;
    /** 可直接展示给用户的中文短句。 */
    label: string;
};

export type PortfolioExportProgressHandler = (progress: PortfolioExportProgress) => void;

export type PortfolioExportFailure = {
    src: string;
    reason: string;
};

export type PortfolioExportOutcome = {
    filename: string;
    mimeType: string;
    /** 位图导出的实际像素尺寸；HTML 导出为空。 */
    width?: number;
    height?: number;
    /** 读取失败的图片清单；导出不因个别图片失败而中断，只在这里报告。 */
    failures: PortfolioExportFailure[];
    /** 长图超出位图上限、已自动降级为分页 zip。 */
    degraded: boolean;
    /** 给用户看的一句中文化说明（含降级与失败汇总）。 */
    note: string;
};

export type PortfolioExportDependencies = {
    onProgress?: PortfolioExportProgressHandler;
    /** 长图超限时是否允许降级为分页 zip，默认允许。 */
    allowZipFallback?: boolean;
};

export type PortfolioExportInput = {
    /** 导出范围：单页 PNG 传 `page`，整册导出传全部页面。 */
    pages: readonly PortfolioPage[];
    /** 文档标题，用于生成文件名与 HTML 标题。 */
    title: string;
    description: string;
    options: PortfolioExportOptions;
};
