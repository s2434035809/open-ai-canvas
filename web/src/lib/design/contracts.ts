/**
 * 设计工作台的数据契约。
 *
 * 设计工作台是单页精确版式（自由形状、图层、社媒尺寸、单张位图导出），
 * 契约因此独立于画布：画布面向自由摆放的无限节点，设计稿面向固定页面内的
 * 精确排版，共用一套类型会让每加一个设计能力都要在画布节点模型里开洞。
 *
 * 文档形状保持最小且自洽：一个文档 → 一页（设计稿极少有多页）→ 元素数组。
 * 多页能力预留在 `pages` 数组里，但产品上默认只有一页。
 */

/** 元素类型。设计工作台从一开始就含形状，不止图片与文字。 */
export type DesignElementKind = "text" | "image" | "rect" | "ellipse" | "line";

export type DesignTextAlign = "left" | "center" | "right";

export type DesignImageFit = "cover" | "contain" | "fill";

type DesignElementBase = {
    id: string;
    kind: DesignElementKind;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    opacity: number;
    locked: boolean;
    /** 图层顺序：数字越大越靠上。 */
    zIndex: number;
    /** 填充色，形状与文字共用。 */
    fill: string;
    stroke: string;
    strokeWidth: number;
    cornerRadius: number;
};

export type DesignTextElement = DesignElementBase & {
    kind: "text";
    text: string;
    fontSize: number;
    fontWeight: number;
    lineHeight: number;
    letterSpacing: number;
    align: DesignTextAlign;
    fontFamily: string;
    color: string;
};

export type DesignImageElement = DesignElementBase & {
    kind: "image";
    src: string;
    /** 账号资源 ID：Agent 看图与再次引用都靠它。 */
    assetId: string;
    naturalWidth: number;
    naturalHeight: number;
    fit: DesignImageFit;
};

export type DesignShapeElement = DesignElementBase & {
    kind: "rect" | "ellipse" | "line";
};

export type DesignElement = DesignTextElement | DesignImageElement | DesignShapeElement;

export type DesignPage = {
    id: string;
    name: string;
    width: number;
    height: number;
    background: string;
    elements: DesignElement[];
};

export const DESIGN_SCHEMA_VERSION = 1;

export type DesignDocument = {
    schemaVersion: number;
    title: string;
    /** 社媒尺寸预设标签，如 "1:1"；仅用于回显，真实尺寸在 page 上。 */
    preset: string;
    pages: DesignPage[];
};

/** 社媒常用尺寸。 */
export type DesignSizePreset = { label: string; width: number; height: number };

export const DESIGN_SIZE_PRESETS: readonly DesignSizePreset[] = [
    { label: "1:1", width: 1080, height: 1080 },
    { label: "3:4", width: 1080, height: 1440 },
    { label: "4:5", width: 1080, height: 1350 },
    { label: "9:16", width: 1080, height: 1920 },
    { label: "16:9", width: 1920, height: 1080 },
];

export const DESIGN_DEFAULT_PRESET = DESIGN_SIZE_PRESETS[0];

/** 单篇设计稿上限，与后端 `designMaxDocBytes` 对齐（8MiB）。 */
export const DESIGN_MAX_DOC_BYTES = 8 << 20;
/** 画布缩放边界。 */
export const DESIGN_MIN_ZOOM = 0.1;
export const DESIGN_MAX_ZOOM = 4;

export function isDesignDocument(value: unknown): value is DesignDocument {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return typeof record.title === "string" && Array.isArray(record.pages);
}
