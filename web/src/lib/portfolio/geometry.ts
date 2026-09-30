/**
 * 画布几何与命中测试。
 *
 * 渲染交给 leafer-ui，但命中和变换全部在这里自己算：一是拖动时的吸附、缩放锚点
 * 需要随时读取元素几何，走自己的模型比反查渲染层更直接；二是渲染层不承担交互，
 * 后续换渲染内核也不会影响交互逻辑。
 *
 * 坐标约定：元素以左上角 (x, y) 定位，旋转围绕自身中心，顺时针为正，单位为度。
 */

import type { PortfolioElement, PortfolioRect } from "./contracts";

export type Point = { x: number; y: number };

export type ViewTransform = { zoom: number; panX: number; panY: number };

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const RESIZE_HANDLES: readonly ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** 元素最小边长，避免拖到零尺寸后再也选不中。 */
export const MIN_ELEMENT_SIZE = 8;

export function pageToScreen(point: Point, transform: ViewTransform): Point {
    return { x: point.x * transform.zoom + transform.panX, y: point.y * transform.zoom + transform.panY };
}

export function screenToPage(point: Point, transform: ViewTransform): Point {
    return { x: (point.x - transform.panX) / transform.zoom, y: (point.y - transform.panY) / transform.zoom };
}

export function rotatePoint(point: Point, center: Point, degrees: number): Point {
    if (!degrees) return point;
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

export function rectCenter(rect: PortfolioRect): Point {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function elementCenter(element: PortfolioElement): Point {
    return { x: element.x + element.width / 2, y: element.y + element.height / 2 };
}

/** 四个角按 左上 → 右上 → 右下 → 左下 返回，已应用旋转。 */
export function elementCorners(element: PortfolioElement): [Point, Point, Point, Point] {
    const center = elementCenter(element);
    const raw: [Point, Point, Point, Point] = [
        { x: element.x, y: element.y },
        { x: element.x + element.width, y: element.y },
        { x: element.x + element.width, y: element.y + element.height },
        { x: element.x, y: element.y + element.height },
    ];
    if (!element.rotation) return raw;
    return raw.map((point) => rotatePoint(point, center, element.rotation)) as [Point, Point, Point, Point];
}

/** 旋转后的轴对齐包围盒；用于多选并集与吸附参考。 */
export function elementBounds(element: PortfolioElement): PortfolioRect {
    if (!element.rotation) return { x: element.x, y: element.y, width: element.width, height: element.height };
    const corners = elementCorners(element);
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

export function unionElementBounds(elements: readonly PortfolioElement[]): PortfolioRect | null {
    if (elements.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const element of elements) {
        const bounds = elementBounds(element);
        minX = Math.min(minX, bounds.x);
        minY = Math.min(minY, bounds.y);
        maxX = Math.max(maxX, bounds.x + bounds.width);
        maxY = Math.max(maxY, bounds.y + bounds.height);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 点是否落在元素内：先把点反向旋转回元素本地坐标，再做矩形判断。 */
export function pointInElement(element: PortfolioElement, point: Point): boolean {
    const local = element.rotation ? rotatePoint(point, elementCenter(element), -element.rotation) : point;
    return local.x >= element.x && local.x <= element.x + element.width && local.y >= element.y && local.y <= element.y + element.height;
}

/** 从上到下命中测试：zIndex 大的在上，先命中者返回。 */
export function hitTestElements(elements: readonly PortfolioElement[], point: Point): PortfolioElement | null {
    const ordered = [...elements].sort((a, b) => b.zIndex - a.zIndex);
    return ordered.find((element) => pointInElement(element, point)) ?? null;
}

export function rectsIntersect(left: PortfolioRect, right: PortfolioRect): boolean {
    return left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y;
}

/** 框选：与元素旋转后包围盒求交，符合用户对"框住即选中"的直觉。 */
export function marqueeSelect(elements: readonly PortfolioElement[], marquee: PortfolioRect): string[] {
    const normalized = normalizeRect(marquee);
    return elements.filter((element) => rectsIntersect(normalized, elementBounds(element))).map((element) => element.id);
}

export function normalizeRect(rect: PortfolioRect): PortfolioRect {
    return {
        x: rect.width < 0 ? rect.x + rect.width : rect.x,
        y: rect.height < 0 ? rect.y + rect.height : rect.y,
        width: Math.abs(rect.width),
        height: Math.abs(rect.height),
    };
}

/** 缩放手柄在页面坐标中的位置（含旋转），用于绘制手柄与做命中区。 */
export function resizeHandlePoint(element: PortfolioElement, handle: ResizeHandle): Point {
    const [topLeft, topRight, bottomRight, bottomLeft] = elementCorners(element);
    const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    switch (handle) {
        case "nw":
            return topLeft;
        case "n":
            return midpoint(topLeft, topRight);
        case "ne":
            return topRight;
        case "e":
            return midpoint(topRight, bottomRight);
        case "se":
            return bottomRight;
        case "s":
            return midpoint(bottomLeft, bottomRight);
        case "sw":
            return bottomLeft;
        case "w":
            return midpoint(topLeft, bottomLeft);
    }
}

/** 旋转手柄挂在顶部中点外侧，偏移由调用方按屏幕像素给出（会换算成页面单位）。 */
export function rotateHandlePoint(element: PortfolioElement, offset: number): Point {
    const [topLeft, topRight] = elementCorners(element);
    const top = { x: (topLeft.x + topRight.x) / 2, y: (topLeft.y + topRight.y) / 2 };
    const radians = (-element.rotation * Math.PI) / 180;
    // 沿元素"上方"法线方向外推，旋转后仍然贴着顶边。
    return { x: top.x + Math.sin(radians) * -offset, y: top.y + Math.cos(radians) * -offset };
}

/** 手柄对应的对角/对边锚点：缩放时锚点保持不动。 */
function anchorForHandle(rect: PortfolioRect, handle: ResizeHandle): Point {
    const left = rect.x;
    const right = rect.x + rect.width;
    const top = rect.y;
    const bottom = rect.y + rect.height;
    const midX = rect.x + rect.width / 2;
    const midY = rect.y + rect.height / 2;
    switch (handle) {
        case "nw":
            return { x: right, y: bottom };
        case "n":
            return { x: midX, y: bottom };
        case "ne":
            return { x: left, y: bottom };
        case "e":
            return { x: left, y: midY };
        case "se":
            return { x: left, y: top };
        case "s":
            return { x: midX, y: top };
        case "sw":
            return { x: right, y: top };
        case "w":
            return { x: right, y: midY };
    }
}

function affectsX(handle: ResizeHandle) {
    return handle.includes("w") || handle.includes("e");
}

function affectsY(handle: ResizeHandle) {
    return handle.includes("n") || handle.includes("s");
}

function directionSign(handle: ResizeHandle, axis: "x" | "y") {
    if (axis === "x") return handle.includes("e") ? 1 : -1;
    return handle.includes("s") ? 1 : -1;
}

/** 按住 Shift 等比缩放时使用的比例；宽高都为 0 时返回 1。 */
function uniformRatio(rect: PortfolioRect) {
    if (rect.width <= 0 || rect.height <= 0) return 1;
    return rect.width / rect.height;
}

/**
 * 由手柄拖动计算新矩形。
 *
 * 先把指针换算到元素的本地坐标系（旋转元素在本地就是正矩形），在本地做出新矩形后
 * 再按「锚点世界坐标不变」反推中心位移，这样旋转状态下缩放也不会漂移。
 */
export function resizeRectFromHandle(start: PortfolioRect, rotation: number, handle: ResizeHandle, pointer: Point, options: { keepRatio?: boolean; fromCenter?: boolean } = {}): PortfolioRect {
    const radians = (rotation * Math.PI) / 180;
    const axisX = { x: Math.cos(radians), y: Math.sin(radians) };
    const axisY = { x: -Math.sin(radians), y: Math.cos(radians) };
    const startCenter = rectCenter(start);
    const anchor = anchorForHandle(start, handle);
    const toLocal = (point: Point) => {
        const dx = point.x - startCenter.x;
        const dy = point.y - startCenter.y;
        return { x: dx * axisX.x + dy * axisX.y, y: dx * axisY.x + dy * axisY.y };
    };
    const localAnchor = toLocal(anchor);
    const localPointer = toLocal(pointer);

    let width = start.width;
    let height = start.height;
    if (affectsX(handle)) width = Math.max(MIN_ELEMENT_SIZE, Math.abs(localPointer.x - localAnchor.x));
    if (affectsY(handle)) height = Math.max(MIN_ELEMENT_SIZE, Math.abs(localPointer.y - localAnchor.y));

    if (options.keepRatio && (affectsX(handle) || affectsY(handle))) {
        // 角手柄等比：两个方向都跟着变；边手柄等比时另一维按原比例补出来。
        if (affectsX(handle) && affectsY(handle)) {
            const ratio = uniformRatio(start);
            if (width / height > ratio) height = Math.max(MIN_ELEMENT_SIZE, width / ratio);
            else width = Math.max(MIN_ELEMENT_SIZE, height * ratio);
        } else if (affectsX(handle)) {
            height = Math.max(MIN_ELEMENT_SIZE, width / uniformRatio(start));
        } else {
            width = Math.max(MIN_ELEMENT_SIZE, height * uniformRatio(start));
        }
    }

    // fromCenter：以元素中心为基准双向扩展，锚点退化为中心。
    let localCenterX: number;
    let localCenterY: number;
    if (options.fromCenter) {
        localCenterX = 0;
        localCenterY = 0;
    } else {
        const signX = affectsX(handle) ? directionSign(handle, "x") : 1;
        const signY = affectsY(handle) ? directionSign(handle, "y") : 1;
        localCenterX = affectsX(handle) ? localAnchor.x + (width / 2) * signX : 0;
        localCenterY = affectsY(handle) ? localAnchor.y + (height / 2) * signY : 0;
    }

    const center = {
        x: startCenter.x + localCenterX * axisX.x + localCenterY * axisY.x,
        y: startCenter.y + localCenterX * axisX.y + localCenterY * axisY.y,
    };
    return { x: center.x - width / 2, y: center.y - height / 2, width, height };
}

/** 拖动旋转手柄：以元素中心为圆心，指针角度即新角度；按住 Shift 吸附到 15°。 */
export function rotationFromPointer(center: Point, pointer: Point, options: { fromPointerStart?: number; snap?: boolean } = {}): number {
    const angle = (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI + 90;
    const normalized = ((angle % 360) + 360) % 360;
    if (!options.snap) return normalized;
    return Math.round(normalized / 15) * 15;
}

export function rectEquals(left: PortfolioRect, right: PortfolioRect) {
    return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

/** 视口变化时把内容居中：把页面等比缩放到可视区并居中。 */
export function fitViewTransform(pageWidth: number, pageHeight: number, viewportWidth: number, viewportHeight: number, padding = 64): ViewTransform {
    const availableWidth = Math.max(1, viewportWidth - padding * 2);
    const availableHeight = Math.max(1, viewportHeight - padding * 2);
    const zoom = Math.min(availableWidth / pageWidth, availableHeight / pageHeight, 4);
    return { zoom, panX: (viewportWidth - pageWidth * zoom) / 2, panY: (viewportHeight - pageHeight * zoom) / 2 };
}

/** 单选元素的手柄是否需要按旋转后的方向重新排列光标。 */
export function rotateHandleCursor(cursor: string, rotation: number): string {
    if (!rotation) return cursor;
    const basic = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    const index = basic.indexOf(cursor);
    if (index < 0) return cursor;
    const steps = Math.round(rotation / 45);
    return basic[(((index + steps) % 8) + 8) % 8];
}
