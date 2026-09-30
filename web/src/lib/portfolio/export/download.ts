/**
 * 导出物落盘。
 *
 * 只用 `file-saver` 一个现成依赖：它处理了各浏览器触发下载的差异（Blob URL 的生命
 * 周期、Safari 的点击时序），比自己写 anchor 更稳。命名规则在 filename.ts 里，与
 * 这里分开以便单测。
 */

import { saveAs } from "file-saver";

export function savePortfolioBlob(blob: Blob, filename: string): void {
    saveAs(blob, filename);
}

export function savePortfolioText(text: string, filename: string, mimeType = "text/html;charset=utf-8"): void {
    savePortfolioBlob(new Blob([text], { type: mimeType }), filename);
}
