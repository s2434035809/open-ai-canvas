/**
 * 作品集文档契约。
 *
 * 文档是纯结构数据：图片只保存资源引用或可访问 URL，不内联二进制；这样同一份
 * 文档既能作为本地草稿、也能整体提交给后端保存，导出时再按需把图片解析出来。
 *
 * 所有坐标与尺寸都以「页面像素」为单位，原点在页面左上角、y 轴向下，与 leafer-ui
 * 的坐标系一致，避免渲染层再做一次翻转。
 */

export const PORTFOLIO_SCHEMA_VERSION = 1;

/** 默认页面尺寸按 16:10 横版出图，适合作品集/提案版式；每页仍可单独覆盖。 */
export const PORTFOLIO_DEFAULT_PAGE_WIDTH = 1600;
export const PORTFOLIO_DEFAULT_PAGE_HEIGHT = 1000;

/** 后端单篇文档的配额与前端保持一致，避免用户编辑到一半才被拒绝。 */
export const PORTFOLIO_MAX_DOC_BYTES = 8 << 20;

export type PortfolioElementKind = "image" | "text";

export type PortfolioElementBase = {
    id: string;
    /** 相对页面左上角的横坐标。 */
    x: number;
    /** 相对页面左上角的纵坐标。 */
    y: number;
    width: number;
    height: number;
    /** 顺时针旋转角度，单位为度。 */
    rotation: number;
    /** 排序键；渲染与命中都按升序处理，数值大的在上层。 */
    zIndex: number;
    /** 锁定后不可拖动，用于固定已排好的底图或标题。 */
    locked: boolean;
    opacity: number;
};

export type PortfolioImageFit = "cover" | "contain" | "fill";

export type PortfolioImageElement = PortfolioElementBase & {
    kind: "image";
    /** 宿主资源 ID；为空表示 src 是外部地址或 data URL。 */
    assetId: string;
    src: string;
    fit: PortfolioImageFit;
    naturalWidth: number;
    naturalHeight: number;
    /** 图注，导出 HTML/PDF 时作为图下文字。 */
    caption: string;
    /** Agent 分类结果，用于分组、筛选与导出分组。 */
    tags: string[];
};

export type PortfolioTextAlign = "left" | "center" | "right";

export type PortfolioTextElement = PortfolioElementBase & {
    kind: "text";
    text: string;
    fontSize: number;
    fontFamily: string;
    fontWeight: number;
    color: string;
    align: PortfolioTextAlign;
    lineHeight: number;
    letterSpacing: number;
};

export type PortfolioElement = PortfolioImageElement | PortfolioTextElement;

export type PortfolioPage = {
    id: string;
    name: string;
    width: number;
    height: number;
    background: string;
    elements: PortfolioElement[];
};

export type PortfolioDocument = {
    schemaVersion: number;
    title: string;
    description: string;
    coverUrl: string;
    pages: PortfolioPage[];
};

/** 元素的可变字段集合；更新元素时只接受这些键。 */
export type PortfolioElementPatch = Partial<Omit<PortfolioElementBase, "id" | "zIndex">> &
    Partial<Pick<PortfolioImageElement, "src" | "assetId" | "fit" | "caption" | "tags" | "naturalWidth" | "naturalHeight">> &
    Partial<Pick<PortfolioTextElement, "text" | "fontSize" | "fontFamily" | "fontWeight" | "color" | "align" | "lineHeight" | "letterSpacing">>;

export type PortfolioRect = { x: number; y: number; width: number; height: number };

export type PortfolioAlignMode = "left" | "center-x" | "right" | "top" | "center-y" | "bottom";

/** 吸附参考线：position 是吸附后元素边/中心应当对齐到的坐标。 */
export type PortfolioSnapGuide = {
    axis: "x" | "y";
    position: number;
    /** 参考线在页面上的可视范围，便于前端画出对齐提示线。 */
    from: number;
    to: number;
};

export type PortfolioSnapResult = {
    x: number;
    y: number;
    guides: PortfolioSnapGuide[];
};

/** 判断文档是否为一个可安全渲染的作品集结构，用于读取外部/历史数据时的兜底。 */
export function isPortfolioDocument(value: unknown): value is PortfolioDocument {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<PortfolioDocument>;
    if (!Array.isArray(candidate.pages)) return false;
    return candidate.pages.every((page) => Array.isArray(page?.elements));
}
