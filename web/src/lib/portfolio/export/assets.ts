/**
 * 导出用的图片解析。
 *
 * 文档里只存资源引用或地址，不内联二进制（见 contracts.ts 的文件头注释），所以导出
 * 前必须把每张图「取回来」变成可绘制、可内联的东西。这是整条导出链路上最容易被卡住
 * 的一环，策略如下：
 *
 * - 内联地址（`data:`）：直接交给 `Image` 解码，没有跨域与鉴权问题；
 * - 其它地址：统一 `fetch → blob → dataURL`。走这一步有两个好处——一是绕开「跨域图片
 *   污染 canvas」导致 `toBlob` 抛安全错误，二是 HTML 导出本来就需要内联副本，一次读取
 *   同时满足两条通道；
 * - 单张失败**不阻断整册导出**：记进 failures 由调用方汇总提示，画面上该图位置留白。
 *
 * 解析结果按 `src` 缓存，同一张图在多页重复出现时只读一次；并发限制 4，避免把连接打满。
 */

import type { PortfolioPage } from "@/lib/portfolio/contracts";
import type { PortfolioExportFailure } from "./types";

export type PortfolioAssetEntry = {
    src: string;
    image: HTMLImageElement;
    /** 内联副本，HTML 导出直接嵌进单文件，不依赖任何外链。 */
    dataUrl: string;
    naturalWidth: number;
    naturalHeight: number;
};

export type PortfolioAssetBundle = {
    /** key 为元素上的原始 `src`，与文档模型一一对应。 */
    entries: Map<string, PortfolioAssetEntry>;
    failures: PortfolioExportFailure[];
};

export type PortfolioAssetDeps = {
    loadImage?: (src: string) => Promise<HTMLImageElement>;
    readBlobAsDataUrl?: (blob: Blob) => Promise<string>;
    fetchImpl?: (input: string) => Promise<Response>;
    /** 同时读取的图片数量上限。 */
    concurrency?: number;
    /** 单张图片的读取超时（毫秒）。 */
    timeoutMs?: number;
    onProgress?: (done: number, total: number) => void;
};

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 15_000;

/** `data:` / `blob:` 都是自带内容的地址，不需要再发一次请求。 */
export function isInlineImageSrc(src: string): boolean {
    return /^(?:data|blob):/i.test(src.trim());
}

/** 从页面集合里取出需要读取的图片地址，按首次出现顺序去重。 */
export function collectImageSources(pages: readonly PortfolioPage[]): string[] {
    const sources: string[] = [];
    const seen = new Set<string>();
    for (const page of pages) {
        for (const element of page.elements) {
            if (element.kind !== "image") continue;
            const src = element.src?.trim();
            if (!src || seen.has(src)) continue;
            seen.add(src);
            sources.push(src);
        }
    }
    return sources;
}

function defaultLoadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片解码失败"));
        image.src = src;
    });
}

function defaultReadBlobAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败")));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(blob);
    });
}

/**
 * 同源地址带 cookie 是必须的：`/api/resources/{id}/file` 依赖会话鉴权。
 * 部署时若把后端配到外域，这里退化为跨域请求，失败会被记进 failures 而不是静默出错。
 */
function defaultFetch(input: string): Promise<Response> {
    return fetch(input, { credentials: "include", mode: "cors" });
}

function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    return fallback;
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    if (!(timeoutMs > 0)) return task;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`读取超时：${label}`)), timeoutMs);
        task.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

/** 固定并发的小任务池；保持结果顺序无关（每个任务自己写结果）。 */
async function runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const size = Math.max(1, Math.min(Math.floor(limit) || 1, queue.length || 1));
    const runners = Array.from({ length: size }, async () => {
        for (;;) {
            if (queue.length === 0) return;
            const item = queue.shift() as T;
            await worker(item);
        }
    });
    await Promise.all(runners);
}

async function resolveAsset(src: string, deps: Required<Pick<PortfolioAssetDeps, "loadImage" | "readBlobAsDataUrl" | "fetchImpl">>): Promise<PortfolioAssetEntry> {
    const build = (image: HTMLImageElement, dataUrl: string): PortfolioAssetEntry => {
        const naturalWidth = image.naturalWidth || 0;
        const naturalHeight = image.naturalHeight || 0;
        if (naturalWidth <= 0 || naturalHeight <= 0) throw new Error("图片尺寸无效");
        return { src, image, dataUrl, naturalWidth, naturalHeight };
    };

    if (isInlineImageSrc(src)) {
        return build(await deps.loadImage(src), src);
    }

    const response = await deps.fetchImpl(src);
    if (!response.ok) throw new Error(`图片请求失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    if (blob.size === 0) throw new Error("图片内容为空");
    const dataUrl = await deps.readBlobAsDataUrl(blob);
    return build(await deps.loadImage(dataUrl), dataUrl);
}

/**
 * 读取页面集合里出现的全部图片。
 *
 * 返回的 bundle 在两次导出之间不要复用：它的 `image` 引用可能被浏览器回收。
 */
export async function loadPortfolioAssets(pages: readonly PortfolioPage[], deps: PortfolioAssetDeps = {}): Promise<PortfolioAssetBundle> {
    const loadImage = deps.loadImage ?? defaultLoadImage;
    const readBlobAsDataUrl = deps.readBlobAsDataUrl ?? defaultReadBlobAsDataUrl;
    const fetchImpl = deps.fetchImpl ?? defaultFetch;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const sources = collectImageSources(pages);
    const entries = new Map<string, PortfolioAssetEntry>();
    const failures: PortfolioExportFailure[] = [];
    let done = 0;
    deps.onProgress?.(0, sources.length);

    await runWithConcurrency(sources, deps.concurrency ?? DEFAULT_CONCURRENCY, async (src) => {
        try {
            entries.set(src, await withTimeout(resolveAsset(src, { loadImage, readBlobAsDataUrl, fetchImpl }), timeoutMs, src));
        } catch (error) {
            failures.push({ src, reason: errorMessage(error, "图片读取失败") });
        } finally {
            done += 1;
            deps.onProgress?.(done, sources.length);
        }
    });

    return { entries, failures };
}
