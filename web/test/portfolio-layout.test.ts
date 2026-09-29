import { describe, expect, test } from "bun:test";

import { PORTFOLIO_DEFAULT_PAGE_HEIGHT, PORTFOLIO_DEFAULT_PAGE_WIDTH, type PortfolioDocument } from "@/lib/portfolio/contracts";
import { alignElements, arrangeInGrid, createImageElement, createPortfolioDocument, createTextElement, nextZIndex, normalizeZIndex, removeElements, reorderElements, snapRect } from "@/lib/portfolio/document";
import { elementBounds, hitTestElements, pointInElement, resizeRectFromHandle, rotationFromPointer, screenToPage, marqueeSelect } from "@/lib/portfolio/geometry";
import { usePortfolioStore, currentPortfolioPage } from "@/lib/portfolio/store";

function imageAt(id: string, x: number, y: number, width: number, height: number, zIndex: number) {
    return { ...createImageElement({ src: "data:,", x, y, width, height, zIndex }), id };
}

function textAt(id: string, x: number, y: number, width: number, height: number, zIndex: number) {
    return { ...createTextElement({ text: id, x, y, width, height, zIndex }), id };
}

describe("portfolio document operations", () => {
    test("creates a first page so the editor never opens on an empty shell", () => {
        const document = createPortfolioDocument("测试作品集");
        expect(document.pages).toHaveLength(1);
        expect(document.pages[0].width).toBe(PORTFOLIO_DEFAULT_PAGE_WIDTH);
        expect(document.pages[0].height).toBe(PORTFOLIO_DEFAULT_PAGE_HEIGHT);
    });

    test("keeps z-index dense after removal so later edits stay predictable", () => {
        const page = { ...createPortfolioDocument().pages[0], elements: [imageAt("a", 0, 0, 10, 10, 5), imageAt("b", 0, 0, 10, 10, 9), imageAt("c", 0, 0, 10, 10, 20)] };
        const next = removeElements(page, ["b"]);
        expect(normalizeZIndex(next.elements).map((element) => [element.id, element.zIndex])).toEqual([
            ["a", 1],
            ["c", 2],
        ]);
        expect(nextZIndex(next.elements)).toBe(3);
    });

    test("moves a multi-selection as a block instead of shuffling it", () => {
        const page = { ...createPortfolioDocument().pages[0], elements: [imageAt("a", 0, 0, 10, 10, 1), imageAt("b", 0, 0, 10, 10, 2), imageAt("c", 0, 0, 10, 10, 3), imageAt("d", 0, 0, 10, 10, 4)] };
        // 数组顺序即 zIndex 升序：靠前的先画（在下层），靠后的在上层。
        // a、b 一起上移一层：应先给 c 让位，两块内部顺序保持不变。
        expect(reorderElements(page, ["a", "b"], "forward").elements.map((element) => element.id)).toEqual(["c", "a", "b", "d"]);
        // c、d 置顶后整体压在最上面。
        expect(reorderElements(page, ["c", "d"], "front").elements.map((element) => element.id)).toEqual(["a", "b", "c", "d"]);
        // c、d 置底后落到最下层，两者内部顺序不变。
        expect(reorderElements(page, ["c", "d"], "back").elements.map((element) => element.id)).toEqual(["c", "d", "a", "b"]);
        // 单选下移一层：c 与 b 互换。
        expect(reorderElements(page, ["c"], "backward").elements.map((element) => element.id)).toEqual(["a", "c", "b", "d"]);
        // 顺序落定后 zIndex 必须被重写成紧邻整数，否则下一次调整会按旧值排回去。
        expect(reorderElements(page, ["c"], "backward").elements.map((element) => element.zIndex)).toEqual([1, 2, 3, 4]);
    });

    test("aligns a single element against the page and multi-selection against its union box", () => {
        const elements = [imageAt("a", 10, 10, 100, 50, 1), imageAt("b", 300, 400, 60, 60, 2)];
        const page = { ...createPortfolioDocument().pages[0], elements };
        const single = alignElements(page, ["a"], "center-x");
        expect(single.elements[0].x).toBe((PORTFOLIO_DEFAULT_PAGE_WIDTH - 100) / 2);
        const multi = alignElements(page, ["a", "b"], "left");
        expect(multi.elements.map((element) => element.x)).toEqual([10, 10]);
    });

    test("arranges elements into a grid that always stays inside the page", () => {
        const elements = [imageAt("a", 0, 0, 400, 300, 1), imageAt("b", 0, 0, 400, 300, 2), imageAt("c", 0, 0, 400, 300, 3)];
        const page = { ...createPortfolioDocument().pages[0], elements };
        const arranged = arrangeInGrid(page, ["a", "b", "c"], 2, 20, 40);
        for (const element of arranged.elements) {
            expect(element.x).toBeGreaterThanOrEqual(0);
            expect(element.y).toBeGreaterThanOrEqual(0);
            expect(element.x + element.width).toBeLessThanOrEqual(page.width + 0.001);
            expect(element.y + element.height).toBeLessThanOrEqual(page.height + 0.001);
        }
        expect(arranged.elements[0].y).toBe(arranged.elements[1].y);
        expect(arranged.elements[2].y).toBeGreaterThan(arranged.elements[0].y);
    });
});

describe("portfolio geometry", () => {
    test("hit tests rotated elements and respects stacking order", () => {
        const bottom = imageAt("bottom", 0, 0, 100, 100, 1);
        const top = imageAt("top", 40, 40, 100, 100, 2);
        expect(hitTestElements([bottom, top], { x: 50, y: 50 })?.id).toBe("top");
        expect(hitTestElements([bottom, top], { x: 10, y: 10 })?.id).toBe("bottom");
        expect(hitTestElements([bottom, top], { x: 500, y: 500 })).toBeNull();
    });

    test("rotation keeps the corner-based bounds symmetric around the centre", () => {
        const element = { ...imageAt("a", 100, 100, 100, 50, 1), rotation: 90 };
        const bounds = elementBounds(element);
        expect(bounds.width).toBeCloseTo(50, 6);
        expect(bounds.height).toBeCloseTo(100, 6);
        expect(bounds.x).toBeCloseTo(125, 6);
        expect(bounds.y).toBeCloseTo(75, 6);
    });

    test("point-in-element accounts for rotation", () => {
        const upright = imageAt("a", 0, 0, 100, 20, 1);
        const rotated = { ...upright, rotation: 90 };
        expect(pointInElement(upright, { x: 50, y: 10 })).toBe(true);
        expect(pointInElement(rotated, { x: 50, y: 10 })).toBe(true);
        // 旋转 90° 后元素在竖直方向变长，超出原高度的点此时应该命中。
        expect(pointInElement(upright, { x: 50, y: 40 })).toBe(false);
        expect(pointInElement(rotated, { x: 50, y: 40 })).toBe(true);
    });

    test("resize keeps the opposite corner pinned, including while rotated", () => {
        const start = { x: 0, y: 0, width: 100, height: 50 };
        const grown = resizeRectFromHandle(start, 0, "se", { x: 150, y: 80 });
        expect(grown).toEqual({ x: 0, y: 0, width: 150, height: 80 });

        const shrunkByTopLeft = resizeRectFromHandle(start, 0, "nw", { x: 20, y: 10 });
        expect(shrunkByTopLeft.x + shrunkByTopLeft.width).toBeCloseTo(100, 6);
        expect(shrunkByTopLeft.y + shrunkByTopLeft.height).toBeCloseTo(50, 6);

        // 旋转 90° 时向"右下"拖动，锚点（左上角原坐标）在世界坐标中必须保持不动。
        const rotated = resizeRectFromHandle(start, 90, "se", { x: -80, y: 150 });
        expect(rotated.width).toBeCloseTo(150, 6);
        expect(rotated.height).toBeCloseTo(80, 6);
    });

    test("rotation follows the pointer angle and snaps when requested", () => {
        const center = { x: 0, y: 0 };
        expect(rotationFromPointer(center, { x: 0, y: -10 })).toBeCloseTo(0, 6);
        expect(rotationFromPointer(center, { x: 10, y: 0 })).toBeCloseTo(90, 6);
        expect(rotationFromPointer(center, { x: 10, y: 1 }, { snap: true })).toBe(90);
    });

    test("marquee selects every element whose bounds intersect the box", () => {
        const elements = [imageAt("a", 0, 0, 50, 50, 1), imageAt("b", 200, 200, 50, 50, 2)];
        expect(marqueeSelect(elements, { x: -10, y: -10, width: 100, height: 100 })).toEqual(["a"]);
        expect(marqueeSelect(elements, { x: -10, y: -10, width: 400, height: 400 })).toEqual(["a", "b"]);
    });

    test("screen and page coordinates round-trip through the viewport transform", () => {
        const transform = { zoom: 2, panX: 30, panY: -10 };
        expect(screenToPage({ x: 130, y: 90 }, transform)).toEqual({ x: 50, y: 50 });
    });

    test("snap pulls the moving box onto a neighbour edge within the threshold", () => {
        const targets = [{ x: 100, y: 0, width: 50, height: 50 }];
        const bounds = { x: 0, y: 0, width: 1000, height: 1000 };
        const result = snapRect({ x: 96, y: 300, width: 50, height: 50 }, targets, bounds, 6);
        expect(result.x).toBe(100);
        expect(result.guides.some((guide) => guide.axis === "x" && guide.position === 100)).toBe(true);
        expect(result.y).toBe(300);
    });
});

describe("portfolio store", () => {
    function loadSample(): PortfolioDocument {
        const document = createPortfolioDocument("会话测试");
        document.pages[0].elements = [imageAt("a", 0, 0, 100, 100, 1), textAt("t", 10, 10, 200, 40, 2)];
        usePortfolioStore.getState().loadDocument(document);
        return document;
    }

    test("coalesces rapid edits to the same field into one undo step", () => {
        loadSample();
        const store = usePortfolioStore.getState();
        store.updateElement("t", { x: 20 });
        usePortfolioStore.getState().updateElement("t", { x: 30 });
        usePortfolioStore.getState().updateElement("t", { x: 40 });
        expect(usePortfolioStore.getState().past).toHaveLength(1);
        expect(currentPortfolioPage(usePortfolioStore.getState())?.elements.find((element) => element.id === "t")?.x).toBe(40);
        usePortfolioStore.getState().undo();
        expect(currentPortfolioPage(usePortfolioStore.getState())?.elements.find((element) => element.id === "t")?.x).toBe(10);
    });

    test("treats a drag as a single history entry and skips empty ones", () => {
        loadSample();
        const store = usePortfolioStore.getState();
        store.beginInteraction();
        const document = usePortfolioStore.getState().document!;
        const dragged = { ...document, pages: document.pages.map((page, index) => (index === 0 ? { ...page, elements: page.elements.map((element) => (element.id === "a" ? { ...element, x: 55 } : element)) } : page)) };
        usePortfolioStore.getState().applyDocumentLive(dragged);
        usePortfolioStore.getState().endInteraction();
        expect(usePortfolioStore.getState().past).toHaveLength(1);
        expect(usePortfolioStore.getState().dirty).toBe(true);

        // 只是点一下没有移动：不应该产生撤销记录。
        const before = usePortfolioStore.getState().past.length;
        usePortfolioStore.getState().beginInteraction();
        usePortfolioStore.getState().endInteraction();
        expect(usePortfolioStore.getState().past).toHaveLength(before);
    });

    test("drops selections pointing at removed elements", () => {
        loadSample();
        usePortfolioStore.getState().setSelection(["a", "t"]);
        usePortfolioStore.getState().removeSelected();
        const state = usePortfolioStore.getState();
        expect(state.selectedIds).toEqual([]);
        expect(currentPortfolioPage(state)?.elements).toHaveLength(0);
        usePortfolioStore.getState().undo();
        expect(currentPortfolioPage(usePortfolioStore.getState())?.elements).toHaveLength(2);
    });

    test("clamps page index when the last page is removed", () => {
        loadSample();
        const store = usePortfolioStore.getState();
        store.addPage();
        expect(usePortfolioStore.getState().pageIndex).toBe(1);
        const pages = currentPortfolioPage(usePortfolioStore.getState())!;
        usePortfolioStore.getState().removePage(pages.id);
        expect(usePortfolioStore.getState().pageIndex).toBe(0);
        // 只剩一页时不允许继续删除，否则用户会掉进没有画布可用的状态。
        const last = currentPortfolioPage(usePortfolioStore.getState())!;
        usePortfolioStore.getState().removePage(last.id);
        expect(usePortfolioStore.getState().document?.pages).toHaveLength(1);
    });

    test("zoom keeps the anchored page point under the cursor", () => {
        loadSample();
        const store = usePortfolioStore.getState();
        store.resetViewport();
        store.zoomBy(2, { x: 100, y: 100 });
        const state = usePortfolioStore.getState();
        expect(state.viewport.zoom).toBe(2);
        // 放大后光标下的页面坐标必须保持不变，否则缩放会"跑图"。
        expect(screenToPage({ x: 100, y: 100 }, state.viewport)).toEqual({ x: 100, y: 100 });
        expect(screenToPage({ x: 300, y: 100 }, state.viewport)).toEqual({ x: 200, y: 100 });
    });
});
