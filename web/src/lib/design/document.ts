/**
 * 设计工作台的文档工厂与元素创建。
 *
 * 纯函数，不碰 store、不碰 DOM：这样单测能直接验证形状，也方便 Agent 返回的
 * 版式方案在应用前先在这里归一化。
 */

import {
    DESIGN_DEFAULT_PRESET,
    DESIGN_SCHEMA_VERSION,
    DESIGN_SIZE_PRESETS,
    type DesignDocument,
    type DesignElement,
    type DesignImageElement,
    type DesignPage,
    type DesignShapeElement,
    type DesignTextElement,
} from "./contracts";

export function createDesignId(prefix: string): string {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}_${random.replace(/-/g, "").slice(0, 24)}`;
}

export function createDesignPage(overrides: Partial<DesignPage> = {}): DesignPage {
    return {
        id: createDesignId("page"),
        name: "第 1 页",
        width: DESIGN_DEFAULT_PRESET.width,
        height: DESIGN_DEFAULT_PRESET.height,
        background: "#ffffff",
        elements: [],
        ...overrides,
    };
}

export function createDesignDocument(title = "未命名设计稿", preset = DESIGN_DEFAULT_PRESET.label): DesignDocument {
    const size = presetSize(preset);
    return {
        schemaVersion: DESIGN_SCHEMA_VERSION,
        title,
        preset,
        pages: [createDesignPage({ width: size.width, height: size.height })],
    };
}

function presetSize(label: string): { width: number; height: number } {
    const found = DESIGN_SIZE_PRESETS.find((preset) => preset.label === label);
    return found ?? DESIGN_DEFAULT_PRESET;
}

/** 元素公共默认值：所有类型共享的定位与外观。 */
function elementBase(input: { x: number; y: number; width: number; height: number; zIndex: number }): Omit<DesignTextElement, "kind" | "text" | "fontSize" | "fontWeight" | "lineHeight" | "letterSpacing" | "align" | "fontFamily" | "color"> {
    return {
        id: createDesignId("el"),
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        rotation: 0,
        opacity: 1,
        locked: false,
        zIndex: input.zIndex,
        fill: "transparent",
        stroke: "transparent",
        strokeWidth: 0,
        cornerRadius: 0,
    };
}

export function createTextElement(input: { text: string; x?: number; y?: number; width?: number; height?: number; zIndex?: number; fontSize?: number; fontWeight?: number; color?: string; align?: "left" | "center" | "right"; fontFamily?: string }): DesignTextElement {
    const fontSize = input.fontSize ?? 48;
    return {
        ...elementBase({ x: input.x ?? 80, y: input.y ?? 80, width: input.width ?? 600, height: input.height ?? Math.round(fontSize * 1.4), zIndex: input.zIndex ?? 1 }),
        kind: "text",
        text: input.text,
        fontSize,
        fontWeight: input.fontWeight ?? 400,
        lineHeight: 1.4,
        letterSpacing: 0,
        align: input.align ?? "left",
        fontFamily: input.fontFamily ?? "'Source Han Sans SC', 'Noto Sans SC', system-ui, sans-serif",
        color: input.color ?? "#1f2328",
    };
}

export function createImageElement(input: { src: string; x?: number; y?: number; width?: number; height?: number; zIndex?: number; assetId?: string; naturalWidth?: number; naturalHeight?: number }): DesignImageElement {
    const naturalWidth = input.naturalWidth ?? input.width ?? 600;
    const naturalHeight = input.naturalHeight ?? input.height ?? 600;
    return {
        ...elementBase({ x: input.x ?? 80, y: input.y ?? 80, width: input.width ?? 600, height: input.height ?? 600, zIndex: input.zIndex ?? 1 }),
        kind: "image",
        src: input.src,
        assetId: input.assetId ?? "",
        naturalWidth,
        naturalHeight,
        fit: "cover",
        // 图片自身不做填充，填充色只在形状上有意义。
        fill: "transparent",
    };
}

export function createShapeElement(kind: "rect" | "ellipse" | "line", input: { x?: number; y?: number; width?: number; height?: number; zIndex?: number; fill?: string; cornerRadius?: number } = {}): DesignShapeElement {
    return {
        ...elementBase({ x: input.x ?? 80, y: input.y ?? 80, width: input.width ?? 400, height: input.height ?? 300, zIndex: input.zIndex ?? 1 }),
        kind,
        fill: input.fill ?? "#2563eb",
        cornerRadius: input.cornerRadius ?? 0,
    };
}

export function nextZIndex(elements: readonly DesignElement[]): number {
    return elements.reduce((max, element) => Math.max(max, element.zIndex), 0) + 1;
}

/** 按图层顺序排序，渲染与命中测试都依赖这个顺序。 */
export function sortByZIndex(elements: readonly DesignElement[]): DesignElement[] {
    return [...elements].sort((a, b) => a.zIndex - b.zIndex);
}

/** 元素包围盒（未旋转的轴对齐盒），用于对齐、吸附与选择框。 */
export function elementBounds(element: DesignElement): { x: number; y: number; width: number; height: number } {
    return { x: element.x, y: element.y, width: element.width, height: element.height };
}

/** 把元素夹在页面内：Agent 给的坐标可能越界，应用前必须收敛。 */
export function clampToPage(element: DesignElement, page: { width: number; height: number }): DesignElement {
    const width = Math.max(1, Math.min(element.width, page.width));
    const height = Math.max(1, Math.min(element.height, page.height));
    const x = Math.max(0, Math.min(element.x, page.width - width));
    const y = Math.max(0, Math.min(element.y, page.height - height));
    if (x === element.x && y === element.y && width === element.width && height === element.height) return element;
    return { ...element, x, y, width, height };
}
