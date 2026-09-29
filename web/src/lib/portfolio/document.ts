/**
 * 作品集文档的纯函数操作层。
 *
 * 这里只做「给定文档 → 返回新文档」的不可变变换，不触碰 React、不读写存储，
 * 页面与 store 都通过它修改文档，方便单测覆盖排版与吸附算法。
 */

import {
    PORTFOLIO_DEFAULT_PAGE_HEIGHT,
    PORTFOLIO_DEFAULT_PAGE_WIDTH,
    PORTFOLIO_SCHEMA_VERSION,
    type PortfolioAlignMode,
    type PortfolioDocument,
    type PortfolioElement,
    type PortfolioElementPatch,
    type PortfolioImageElement,
    type PortfolioPage,
    type PortfolioRect,
    type PortfolioSnapGuide,
    type PortfolioSnapResult,
    type PortfolioTextElement,
} from "./contracts";

export function createPortfolioId(prefix: string): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function createPortfolioPage(index: number, background = "#ffffff"): PortfolioPage {
    return {
        id: createPortfolioId("page"),
        name: `第 ${index} 页`,
        width: PORTFOLIO_DEFAULT_PAGE_WIDTH,
        height: PORTFOLIO_DEFAULT_PAGE_HEIGHT,
        background,
        elements: [],
    };
}

/** 创建空白作品集；首屏不是空白页，避免用户进来只看到一块画布却不知道怎么开始。 */
export function createPortfolioDocument(title = "未命名作品集"): PortfolioDocument {
    return {
        schemaVersion: PORTFOLIO_SCHEMA_VERSION,
        title,
        description: "",
        coverUrl: "",
        pages: [createPortfolioPage(1)],
    };
}

export function nextZIndex(elements: readonly PortfolioElement[]): number {
    return elements.reduce((max, element) => Math.max(max, element.zIndex), 0) + 1;
}

export function createImageElement(input: { src: string; x: number; y: number; width: number; height: number; assetId?: string; naturalWidth?: number; naturalHeight?: number; zIndex: number; caption?: string; tags?: string[] }): PortfolioImageElement {
    return {
        id: createPortfolioId("image"),
        kind: "image",
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        rotation: 0,
        zIndex: input.zIndex,
        locked: false,
        opacity: 1,
        assetId: input.assetId ?? "",
        src: input.src,
        fit: "cover",
        naturalWidth: input.naturalWidth ?? 0,
        naturalHeight: input.naturalHeight ?? 0,
        caption: input.caption ?? "",
        tags: input.tags ?? [],
    };
}

export function createTextElement(input: { text: string; x: number; y: number; width: number; height: number; zIndex: number; fontSize?: number; fontWeight?: number; color?: string }): PortfolioTextElement {
    return {
        id: createPortfolioId("text"),
        kind: "text",
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        rotation: 0,
        zIndex: input.zIndex,
        locked: false,
        opacity: 1,
        text: input.text,
        fontSize: input.fontSize ?? 32,
        fontFamily: "Inter, system-ui, sans-serif",
        fontWeight: input.fontWeight ?? 400,
        color: input.color ?? "#1f2328",
        align: "left",
        lineHeight: 1.5,
        letterSpacing: 0,
    };
}

/** 渲染与命中都依赖 zIndex 升序；文档数组顺序本身不保证有序。 */
export function sortByZIndex(elements: readonly PortfolioElement[]): PortfolioElement[] {
    return [...elements].sort((a, b) => a.zIndex - b.zIndex);
}

/** 删除元素后重排 zIndex，避免长期编辑后数值无限增长并保留相对层级。 */
export function normalizeZIndex(elements: readonly PortfolioElement[]): PortfolioElement[] {
    return sortByZIndex(elements).map((element, index) => ({ ...element, zIndex: index + 1 }));
}

/**
 * 按"数组当前顺序"重新编号 zIndex，不做排序。
 *
 * 层级调整已经决定好新顺序，此时若再按元素身上残留的旧 zIndex 排序，就会把刚调好的
 * 顺序原样还原回去——这正是之前层级按钮点了没反应的原因。
 */
function reindexInArrayOrder(elements: readonly PortfolioElement[]): PortfolioElement[] {
    return elements.map((element, index) => ({ ...element, zIndex: index + 1 }));
}

export function updateElement(page: PortfolioPage, elementId: string, patch: PortfolioElementPatch): PortfolioPage {
    return {
        ...page,
        elements: page.elements.map((element) => (element.id === elementId ? ({ ...element, ...patch } as PortfolioElement) : element)),
    };
}

export function updateElements(page: PortfolioPage, patches: ReadonlyMap<string, PortfolioElementPatch>): PortfolioPage {
    if (patches.size === 0) return page;
    return {
        ...page,
        elements: page.elements.map((element) => {
            const patch = patches.get(element.id);
            return patch ? ({ ...element, ...patch } as PortfolioElement) : element;
        }),
    };
}

export function removeElements(page: PortfolioPage, elementIds: readonly string[]): PortfolioPage {
    const removing = new Set(elementIds);
    if (removing.size === 0) return page;
    return { ...page, elements: normalizeZIndex(page.elements.filter((element) => !removing.has(element.id))) };
}

export type PortfolioZOrderAction = "front" | "back" | "forward" | "backward";

/**
 * 调整选中元素的层级。多选时按当前相对顺序整体移动，避免一次点击把多个元素的
 * 内部顺序打乱。
 */
export function reorderElements(page: PortfolioPage, elementIds: readonly string[], action: PortfolioZOrderAction): PortfolioPage {
    const selected = new Set(elementIds);
    if (selected.size === 0) return page;
    const ordered = sortByZIndex(page.elements);
    if (action === "front") {
        const rest = ordered.filter((element) => !selected.has(element.id));
        const moved = ordered.filter((element) => selected.has(element.id));
        return { ...page, elements: reindexInArrayOrder([...rest, ...moved]) };
    }
    if (action === "back") {
        const rest = ordered.filter((element) => !selected.has(element.id));
        const moved = ordered.filter((element) => selected.has(element.id));
        return { ...page, elements: reindexInArrayOrder([...moved, ...rest]) };
    }
    const shift = action === "forward" ? 1 : -1;
    const next = [...ordered];
    // 沿移动方向遍历，先把“前方空位”腾出来，保证多选块整体平移一格而不是互相顶掉。
    const indexes = action === "forward" ? [...next.keys()].reverse() : [...next.keys()];
    for (const index of indexes) {
        if (!selected.has(next[index].id)) continue;
        const target = index + shift;
        if (target < 0 || target >= next.length) continue;
        if (selected.has(next[target].id)) continue;
        [next[index], next[target]] = [next[target], next[index]];
    }
    return { ...page, elements: reindexInArrayOrder(next) };
}

export function elementBounds(element: PortfolioElement): PortfolioRect {
    return { x: element.x, y: element.y, width: element.width, height: element.height };
}

/** 多选元素的并集包围盒；空集合返回零矩形，调用方需自行判断选中是否为空。 */
export function unionBounds(elements: readonly PortfolioElement[]): PortfolioRect {
    if (elements.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const element of elements) {
        minX = Math.min(minX, element.x);
        minY = Math.min(minY, element.y);
        maxX = Math.max(maxX, element.x + element.width);
        maxY = Math.max(maxY, element.y + element.height);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 对齐选中元素。单个元素对齐时以页面为参考，避免只有一项时按钮点了没反应。
 */
export function alignElements(page: PortfolioPage, elementIds: readonly string[], mode: PortfolioAlignMode): PortfolioPage {
    const selected = page.elements.filter((element) => elementIds.includes(element.id));
    if (selected.length === 0) return page;
    const reference: PortfolioRect = selected.length === 1 ? { x: 0, y: 0, width: page.width, height: page.height } : unionBounds(selected);
    const patches = new Map<string, PortfolioElementPatch>();
    for (const element of selected) {
        switch (mode) {
            case "left":
                patches.set(element.id, { x: reference.x });
                break;
            case "right":
                patches.set(element.id, { x: reference.x + reference.width - element.width });
                break;
            case "center-x":
                patches.set(element.id, { x: reference.x + (reference.width - element.width) / 2 });
                break;
            case "top":
                patches.set(element.id, { y: reference.y });
                break;
            case "bottom":
                patches.set(element.id, { y: reference.y + reference.height - element.height });
                break;
            case "center-y":
                patches.set(element.id, { y: reference.y + (reference.height - element.height) / 2 });
                break;
        }
    }
    return updateElements(page, patches);
}

/**
 * 拖拽吸附：把被拖元素的左/中/右与上/中/下三组候选位置，同其他元素与页面边界比较，
 * 取阈值内最近的一条参考线。返回吸附后的坐标和应当绘制的参考线。
 */
export function snapRect(rect: PortfolioRect, targets: readonly PortfolioRect[], bounds: PortfolioRect, threshold: number): PortfolioSnapResult {
    const candidatesX: PortfolioSnapGuide[] = [];
    const candidatesY: PortfolioSnapGuide[] = [];
    const verticals = [rect.x, rect.x + rect.width / 2, rect.x + rect.width];
    const horizontals = [rect.y, rect.y + rect.height / 2, rect.y + rect.height];

    const referenceRects: PortfolioRect[] = [...targets, bounds];
    for (const target of referenceRects) {
        const targetVerticals = [target.x, target.x + target.width / 2, target.x + target.width];
        const targetHorizontals = [target.y, target.y + target.height / 2, target.y + target.height];
        for (const source of verticals) {
            for (const destination of targetVerticals) {
                if (Math.abs(source - destination) > threshold) continue;
                candidatesX.push({
                    axis: "x",
                    position: destination,
                    from: Math.min(target.y, rect.y),
                    to: Math.max(target.y + target.height, rect.y + rect.height),
                });
            }
        }
        for (const source of horizontals) {
            for (const destination of targetHorizontals) {
                if (Math.abs(source - destination) > threshold) continue;
                candidatesY.push({
                    axis: "y",
                    position: destination,
                    from: Math.min(target.x, rect.x),
                    to: Math.max(target.x + target.width, rect.x + rect.width),
                });
            }
        }
    }

    const bestX = nearestGuide(candidatesX, rect.x, rect.width, "x");
    const bestY = nearestGuide(candidatesY, rect.y, rect.height, "y");
    const guides: PortfolioSnapGuide[] = [];
    let x = rect.x;
    let y = rect.y;
    if (bestX) {
        x += bestX.position - bestX.anchor;
        guides.push({ axis: "x", position: bestX.position, from: bestX.from, to: bestX.to });
    }
    if (bestY) {
        y += bestY.position - bestY.anchor;
        guides.push({ axis: "y", position: bestY.position, from: bestY.from, to: bestY.to });
    }
    return { x, y, guides };
}

type ResolvedGuide = { position: number; anchor: number; from: number; to: number };

function nearestGuide(guides: readonly PortfolioSnapGuide[], origin: number, size: number, axis: "x" | "y"): ResolvedGuide | null {
    const anchors = [origin, origin + size / 2, origin + size];
    let best: ResolvedGuide | null = null;
    let bestDistance = Infinity;
    for (const guide of guides) {
        for (const anchor of anchors) {
            const distance = Math.abs(anchor - guide.position);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = { position: guide.position, anchor, from: guide.from, to: guide.to };
            }
        }
    }
    return best;
}

/**
 * 把元素按网格自动排布，用于「一键整理」和一键生成初始版式。
 * 保持元素原有先后顺序，尺寸按单元格等比缩放并居中。
 */
export function arrangeInGrid(page: PortfolioPage, elementIds: readonly string[], columns: number, gap: number, padding: number): PortfolioPage {
    const selected = sortByZIndex(page.elements).filter((element) => elementIds.includes(element.id));
    if (selected.length === 0) return page;
    const columnCount = Math.max(1, Math.floor(columns));
    const rowCount = Math.ceil(selected.length / columnCount);
    const cellWidth = (page.width - padding * 2 - gap * (columnCount - 1)) / columnCount;
    const cellHeight = (page.height - padding * 2 - gap * (rowCount - 1)) / rowCount;
    if (cellWidth <= 0 || cellHeight <= 0) return page;

    const patches = new Map<string, PortfolioElementPatch>();
    selected.forEach((element, index) => {
        const column = index % columnCount;
        const row = Math.floor(index / columnCount);
        const scale = Math.min(cellWidth / element.width, cellHeight / element.height);
        const width = Math.max(1, element.width * scale);
        const height = Math.max(1, element.height * scale);
        patches.set(element.id, {
            x: padding + column * (cellWidth + gap) + (cellWidth - width) / 2,
            y: padding + row * (cellHeight + gap) + (cellHeight - height) / 2,
            width,
            height,
        });
    });
    return updateElements(page, patches);
}

/** 按元素 id 找出所在页；页面内元素唯一，因此不需要回传页码。 */
export function findPageIndexById(document: PortfolioDocument, pageId: string): number {
    return document.pages.findIndex((page) => page.id === pageId);
}

export function pageElementCount(page: PortfolioPage): number {
    return page.elements.length;
}
