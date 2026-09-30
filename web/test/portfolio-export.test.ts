/**
 * 作品集导出的纯函数单测。
 *
 * 覆盖三类最容易出错、又最难在浏览器里肉眼发现的地方：
 * 1. 文字断行与基线（决定导出物与画布是否一致）；
 * 2. 图片 fit 的九参数换算与长图尺寸/上限（算错就是整张图错位或空白）；
 * 3. HTML 生成与转义、图片解析的失败路径（异常路径不测就等于没实现）。
 */

import { describe, expect, test } from "bun:test";

import type { PortfolioElement, PortfolioPage } from "@/lib/portfolio/contracts";
import { createImageElement, createTextElement } from "@/lib/portfolio/document";
import { collectImageSources, isInlineImageSrc, loadPortfolioAssets } from "@/lib/portfolio/export/assets";
import { portfolioExportFilename, sanitizeFilename } from "@/lib/portfolio/export/filename";
import { canvasWithinLimits, imageDrawParams, measureDocumentCanvas } from "@/lib/portfolio/export/render-canvas";
import { cssNumber, escapeHtml, renderPortfolioHtml } from "@/lib/portfolio/export/render-html";
import { canvasFont, captionBarHeight, captionFontSize, captionText, layoutText, textAlignOffset, textFirstBaseline, textLineHeight, textRunWidth, wrapTextToWidth } from "@/lib/portfolio/export/text-layout";
import { defaultExportOptions, PORTFOLIO_EXPORT_MAX_AREA, PORTFOLIO_EXPORT_MAX_EDGE } from "@/lib/portfolio/export/types";

/** 单字符固定宽 10px 的假度量，让断行结果可以直接用眼睛核对。 */
const measure = (value: string) => Array.from(value).length * 10;

const textStyle = { fontSize: 16, fontFamily: "sans-serif", fontWeight: 400, letterSpacing: 0, lineHeight: 1, align: "left" as const };

function pageWith(elements: PortfolioElement[], overrides: Partial<PortfolioPage> = {}): PortfolioPage {
    return { id: "page-1", name: "第 1 页", width: 1600, height: 1000, background: "#ffffff", elements, ...overrides };
}

function fakeImage(width: number, height: number): HTMLImageElement {
    return { naturalWidth: width, naturalHeight: height } as unknown as HTMLImageElement;
}

function okResponse(blob: Blob): Response {
    return { ok: true, status: 200, blob: async () => blob } as unknown as Response;
}

describe("portfolio text layout", () => {
    test("breaks lines by character, matching leafer's textWrap break", () => {
        expect(wrapTextToWidth("abcdef", textStyle, 30, measure)).toEqual(["abc", "def"]);
        expect(wrapTextToWidth("中文字符", textStyle, 20, measure)).toEqual(["中文", "字符"]);
    });

    test("keeps explicit newlines and repeated newlines as empty lines", () => {
        expect(wrapTextToWidth("ab\ncd", textStyle, 30, measure)).toEqual(["ab", "cd"]);
        expect(wrapTextToWidth("a\n\nb", textStyle, 30, measure)).toEqual(["a", "", "b"]);
        expect(wrapTextToWidth("", textStyle, 30, measure)).toEqual([""]);
    });

    test("gives an over-wide single character its own line instead of looping", () => {
        expect(wrapTextToWidth("ab", textStyle, 5, measure)).toEqual(["a", "b"]);
    });

    test("counts letter spacing between characters when measuring", () => {
        expect(textRunWidth("abc", 0, measure)).toBe(30);
        expect(textRunWidth("abc", 5, measure)).toBe(40);
        expect(textRunWidth("", 5, measure)).toBe(0);
        expect(wrapTextToWidth("abc", { ...textStyle, letterSpacing: 5 }, 30, measure)).toEqual(["ab", "c"]);
    });

    test("derives line height, first baseline and alignment offsets", () => {
        expect(textLineHeight({ fontSize: 20, lineHeight: 1.5 })).toBe(30);
        expect(textFirstBaseline({ fontSize: 20, lineHeight: 1.5 })).toBe(21);
        expect(textFirstBaseline({ fontSize: 20, lineHeight: 0 })).toBe(16);
        expect(textAlignOffset("left", 40, 100)).toBe(0);
        expect(textAlignOffset("center", 40, 100)).toBe(30);
        expect(textAlignOffset("right", 40, 100)).toBe(60);
    });

    test("falls back to a safe font weight and size for damaged documents", () => {
        expect(canvasFont({ fontSize: 0, fontFamily: "", fontWeight: 0 })).toBe("400 16px sans-serif");
        expect(canvasFont({ fontSize: 24, fontFamily: "Inter", fontWeight: 600 })).toBe("600 24px Inter");
    });

    test("reports content height so overflow is visible to callers", () => {
        const layout = layoutText("abcdef", { ...textStyle, width: 30, height: 100 }, measure);
        expect(layout.lines).toEqual(["abc", "def"]);
        expect(layout.lineHeight).toBe(16);
        expect(layout.contentHeight).toBe(32);
        expect(layout.firstBaseline).toBe(12.8);
    });

    test("builds caption bars and text from captions and tags", () => {
        expect(captionBarHeight(0)).toBe(24);
        expect(captionBarHeight(100)).toBe(24);
        expect(captionBarHeight(1000)).toBe(96);
        expect(captionFontSize(60)).toBe(27);
        expect(captionText({ caption: "海边日落", tags: ["风景", "人像"] }, { includeCaptions: true, includeTags: true })).toBe("海边日落　#风景 #人像");
        expect(captionText({ caption: "海边日落", tags: ["风景"] }, { includeCaptions: false, includeTags: false })).toBe("");
        expect(captionText({ caption: "  ", tags: [] }, { includeCaptions: true, includeTags: true })).toBe("");
    });
});

describe("portfolio bitmap geometry", () => {
    const box = { x: 100, y: 200, width: 100, height: 100 };

    test("stretches the whole image for fill", () => {
        expect(imageDrawParams("fill", 200, 100, box)).toEqual({ sx: 0, sy: 0, sw: 200, sh: 100, dx: 100, dy: 200, dw: 100, dh: 100 });
    });

    test("letterboxes the whole image for contain", () => {
        expect(imageDrawParams("contain", 200, 100, box)).toEqual({ sx: 0, sy: 0, sw: 200, sh: 100, dx: 100, dy: 225, dw: 100, dh: 50 });
    });

    test("crops the source rectangle from the center for cover", () => {
        expect(imageDrawParams("cover", 200, 100, box)).toEqual({ sx: 50, sy: 0, sw: 100, sh: 100, dx: 100, dy: 200, dw: 100, dh: 100 });
        expect(imageDrawParams("cover", 100, 200, box)).toEqual({ sx: 0, sy: 50, sw: 100, sh: 100, dx: 100, dy: 200, dw: 100, dh: 100 });
    });

    test("returns null instead of drawing wrong when sizes are unusable", () => {
        expect(imageDrawParams("cover", 0, 100, box)).toBeNull();
        expect(imageDrawParams("cover", 200, 100, { ...box, width: 0 })).toBeNull();
    });

    test("sums page heights and takes the widest page for the long image", () => {
        const pages = [pageWith([], { height: 1000 }), pageWith([], { width: 1200, height: 800 })];
        expect(measureDocumentCanvas(pages, 2, 0)).toEqual({ width: 3200, height: 3600 });
        expect(measureDocumentCanvas(pages, 1, 24)).toEqual({ width: 1600, height: 1824 });
    });

    test("rejects bitmaps beyond the browser limits", () => {
        expect(canvasWithinLimits(3200, 2000)).toBe(true);
        expect(canvasWithinLimits(PORTFOLIO_EXPORT_MAX_EDGE + 1, 100)).toBe(false);
        expect(canvasWithinLimits(10000, Math.ceil(PORTFOLIO_EXPORT_MAX_AREA / 10000) + 1)).toBe(false);
        expect(canvasWithinLimits(0, 100)).toBe(false);
    });
});

describe("portfolio html export", () => {
    const image = { ...createImageElement({ src: "asset-1", x: 10, y: 20, width: 400, height: 300, zIndex: 2, caption: "图注 <一>", tags: ["风景"] }), id: "image-1" };
    const text = { ...createTextElement({ text: "标题 & 副标题", x: 0, y: 0, width: 600, height: 80, zIndex: 5 }), id: "text-1" };
    const page = pageWith([text, image]);

    function build(options = defaultExportOptions("document-html")) {
        return renderPortfolioHtml({
            pages: [page],
            title: "我的 <作品集>",
            description: "描述 & 说明",
            assets: { entries: new Map([["asset-1", { src: "asset-1", image: fakeImage(400, 300), dataUrl: "data:image/png;base64,AAAA", naturalWidth: 400, naturalHeight: 300 }]]), failures: [] },
            options,
            generatedAt: new Date(2026, 8, 30),
        });
    }

    test("produces a self-contained document with inlined images", () => {
        const html = build();
        expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
        expect(html).toContain('<html lang="zh-CN">');
        expect(html).toContain("data:image/png;base64,AAAA");
        expect(html).toContain("我的 &lt;作品集&gt;");
        expect(html).toContain("描述 &amp; 说明");
        expect(html).toContain('data-w="1600"');
        expect(html).toContain("共 1 页");
        // 自适应脚本必须内嵌，否则窄屏下固定像素版面会溢出。
        expect(html).toContain("pf-frame");
        expect(html).not.toContain("<link");
    });

    test("keeps element order, geometry and layer order from the document", () => {
        const html = build();
        // zIndex 升序输出：图片(2) 在前、文字(5) 在后，靠后的元素显示在上层。
        expect(html.indexOf('<img class="pf-img"')).toBeLessThan(html.indexOf('class="pf-el pf-text"'));
        expect(html).toContain("left:10px;top:20px;width:400px;height:300px");
        expect(html).toContain("z-index:2");
        expect(html).toContain("object-fit:cover");
        expect(html).toContain("text-align:left");
    });

    test("switches captions and tags by option", () => {
        expect(build({ ...defaultExportOptions("document-html"), includeCaptions: false, includeTags: false })).not.toContain('<figcaption class="pf-caption"');
        expect(build({ ...defaultExportOptions("document-html"), includeCaptions: true, includeTags: false })).toContain("图注 &lt;一&gt;");
        expect(build({ ...defaultExportOptions("document-html"), includeTags: true })).toContain("#风景");
    });

    test("always keeps the caption in alt text for accessibility", () => {
        expect(build({ ...defaultExportOptions("document-html"), includeCaptions: false, includeTags: false })).toContain('alt="图注 &lt;一&gt;"');
    });

    test("escapes markup and trims float noise in inline styles", () => {
        expect(escapeHtml("<img src=\"x\" onerror='y'>&")).toBe("&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;");
        expect(cssNumber(1.23456)).toBe(1.23);
        expect(cssNumber(Number.NaN)).toBe(0);
    });

    test("defaults keep bitmaps clean and html semantic", () => {
        expect(defaultExportOptions("page-png")).toMatchObject({ scale: 2, includeCaptions: false, includeTags: false, htmlMode: "layout" });
        expect(defaultExportOptions("document-html")).toMatchObject({ includeCaptions: true, includeTags: true });
    });
});

describe("portfolio export filenames", () => {
    test("strips characters that break downloads on Windows", () => {
        expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
        expect(sanitizeFilename("  ..hidden  ")).toBe("hidden");
        expect(sanitizeFilename("x".repeat(80))).toHaveLength(60);
    });

    test("composes title, suffix and extension with a safe fallback", () => {
        expect(portfolioExportFilename("我的作品集", "长图", "png")).toBe("我的作品集-长图.png");
        expect(portfolioExportFilename("", "", "html")).toBe("作品集.html");
        expect(portfolioExportFilename("草稿", "", ".PDF")).toBe("草稿.PDF");
    });
});

describe("portfolio asset loading", () => {
    test("detects inline sources and collects unique image references", () => {
        expect(isInlineImageSrc("data:image/png;base64,AA")).toBe(true);
        expect(isInlineImageSrc("blob:http://x/y")).toBe(true);
        expect(isInlineImageSrc("/api/resources/1/file")).toBe(false);

        const pages = [
            pageWith([
                { ...createImageElement({ src: "/api/resources/1/file", x: 0, y: 0, width: 10, height: 10, zIndex: 1 }), id: "a" },
                { ...createImageElement({ src: "", x: 0, y: 0, width: 10, height: 10, zIndex: 2 }), id: "b" },
                { ...createTextElement({ text: "t", x: 0, y: 0, width: 10, height: 10, zIndex: 3 }), id: "c" },
            ]),
            pageWith([{ ...createImageElement({ src: "/api/resources/1/file", x: 0, y: 0, width: 10, height: 10, zIndex: 1 }), id: "d" }]),
        ];
        expect(collectImageSources(pages)).toEqual(["/api/resources/1/file"]);
    });

    test("loads inline sources without touching the network", async () => {
        const pages = [pageWith([{ ...createImageElement({ src: "data:image/png;base64,AA", x: 0, y: 0, width: 10, height: 10, zIndex: 1 }), id: "a" }])];
        let fetchCalls = 0;
        const bundle = await loadPortfolioAssets(pages, {
            loadImage: async () => fakeImage(80, 60),
            fetchImpl: async () => {
                fetchCalls += 1;
                return okResponse(new Blob(["x"]));
            },
        });
        expect(fetchCalls).toBe(0);
        expect(bundle.failures).toEqual([]);
        expect(bundle.entries.get("data:image/png;base64,AA")?.naturalWidth).toBe(80);
    });

    test("fetches remote sources once and reuses the decoded data url", async () => {
        const src = "/api/resources/9/file";
        const pages = [pageWith([{ ...createImageElement({ src, x: 0, y: 0, width: 10, height: 10, zIndex: 1 }), id: "a" }]), pageWith([{ ...createImageElement({ src, x: 0, y: 0, width: 10, height: 10, zIndex: 1 }), id: "b" }])];
        const fetched: string[] = [];
        const decoded: string[] = [];
        const bundle = await loadPortfolioAssets(pages, {
            fetchImpl: async (input) => {
                fetched.push(input);
                return okResponse(new Blob(["bytes"]));
            },
            readBlobAsDataUrl: async () => "data:image/png;base64,BBBB",
            loadImage: async (input) => {
                decoded.push(input);
                return fakeImage(120, 90);
            },
        });
        expect(fetched).toEqual([src]);
        expect(decoded).toEqual(["data:image/png;base64,BBBB"]);
        expect(bundle.entries.get(src)?.dataUrl).toBe("data:image/png;base64,BBBB");
    });

    test("reports failures without aborting the whole export", async () => {
        const pages = [
            pageWith([
                { ...createImageElement({ src: "/missing.png", x: 0, y: 0, width: 10, height: 10, zIndex: 1 }), id: "a" },
                { ...createImageElement({ src: "data:image/png;base64,AA", x: 0, y: 0, width: 10, height: 10, zIndex: 2 }), id: "b" },
            ]),
        ];
        const bundle = await loadPortfolioAssets(pages, {
            fetchImpl: async () => ({ ok: false, status: 404, blob: async () => new Blob([]) }) as unknown as Response,
            loadImage: async () => fakeImage(80, 60),
        });
        expect(bundle.failures).toHaveLength(1);
        expect(bundle.failures[0].src).toBe("/missing.png");
        expect(bundle.failures[0].reason).toContain("404");
        expect(bundle.entries.size).toBe(1);
    });

    test("treats an undecodable image as a failure", async () => {
        const pages = [pageWith([{ ...createImageElement({ src: "data:image/png;base64,AA", x: 0, y: 0, width: 10, height: 10, zIndex: 1 }), id: "a" }])];
        const bundle = await loadPortfolioAssets(pages, {
            loadImage: async () => {
                throw new Error("图片解码失败");
            },
        });
        expect(bundle.failures[0].reason).toBe("图片解码失败");
        expect(bundle.entries.size).toBe(0);
    });

    test("keeps concurrency bounded and reports progress to the end", async () => {
        const sources = Array.from({ length: 8 }, (_, index) => `data:image/png;base64,${index}`);
        const pages = [pageWith(sources.map((src, index) => ({ ...createImageElement({ src, x: 0, y: 0, width: 10, height: 10, zIndex: index + 1 }), id: `i${index}` })))];
        let active = 0;
        let peak = 0;
        const progress: Array<[number, number]> = [];
        const bundle = await loadPortfolioAssets(pages, {
            concurrency: 2,
            onProgress: (done, total) => progress.push([done, total]),
            loadImage: async () => {
                active += 1;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active -= 1;
                return fakeImage(10, 10);
            },
        });
        expect(peak).toBe(2);
        expect(bundle.entries.size).toBe(8);
        expect(progress[0]).toEqual([0, 8]);
        expect(progress[progress.length - 1]).toEqual([8, 8]);
    });
});
