/**
 * 设计工作台的编辑状态。
 *
 * 单例 store 只由本工作台的 Provider 注入，不导出全局实例：撤销粒度、
 * 图层语义与形状编辑都按设计稿的需要定义。
 *
 * 历史合并窗口（HISTORY_MERGE_MS）：拖拽与连续输入会产生大量中间态，
 * 每步都进撤销栈会让「撤销一次」只退回 1px。窗口内的连续同类修改合并为一条。
 */

import { create } from "zustand";

import {
    DESIGN_DEFAULT_PRESET,
    DESIGN_MAX_ZOOM,
    DESIGN_MIN_ZOOM,
    type DesignDocument,
    type DesignElement,
    type DesignPage,
    type DesignShapeElement,
    type DesignTextElement,
} from "./contracts";
import { createDesignDocument, createDesignId, createImageElement, createShapeElement, createTextElement, nextZIndex, sortByZIndex } from "./document";

const HISTORY_MERGE_MS = 1200;
const HISTORY_LIMIT = 60;

export type DesignViewport = { zoom: number; panX: number; panY: number };

export type DesignStoreState = {
    document: DesignDocument | null;
    pageIndex: number;
    selectedIds: string[];
    editingTextId: string | null;
    viewport: DesignViewport;
    past: DesignDocument[];
    future: DesignDocument[];
    dirty: boolean;
    saving: boolean;
    loading: boolean;
    error: string;
    /** 服务端文档 ID：为空说明还没落库。 */
    remoteId: string | null;
    revision: number;
    snapEnabled: boolean;

    loadDocument: (document: DesignDocument, meta?: { remoteId?: string | null; revision?: number }) => void;
    closeDocument: () => void;
    setTitle: (title: string) => void;
    setPreset: (label: string, width: number, height: number) => void;
    setPageIndex: (index: number) => void;
    setViewport: (viewport: Partial<DesignViewport>) => void;
    zoomBy: (factor: number) => void;
    toggleSnap: () => void;

    select: (id: string | null) => void;
    selectMany: (ids: string[]) => void;
    selectAll: () => void;
    clearSelection: () => void;
    setEditingText: (id: string | null) => void;

    addText: (input: { text: string; x?: number; y?: number; width?: number; height?: number; fontSize?: number; color?: string; align?: DesignTextElement["align"] }) => string | null;
    addImage: (input: { src: string; naturalWidth?: number; naturalHeight?: number; assetId?: string }) => string | null;
    addShape: (kind: DesignShapeElement["kind"], input?: { fill?: string }) => string | null;

    updateElement: (id: string, patch: Partial<DesignElement>) => void;
    updateSelected: (patch: Partial<DesignElement>) => void;
    removeSelected: () => void;
    duplicateSelected: () => void;
    reorderSelected: (action: "front" | "back") => void;
    alignSelected: (mode: "left" | "center-x" | "right" | "top" | "center-y" | "bottom") => void;

    undo: () => void;
    redo: () => void;
    markSaved: (input: { remoteId: string; revision: number }) => void;
    setLoading: (loading: boolean) => void;
    setState: (partial: Partial<DesignStoreState>) => void;
};

/** 取当前页。文档不存在或页索引越界时返回 null。 */
export function currentDesignPage(state: { document: DesignDocument | null; pageIndex: number }): DesignPage | null {
    const document = state.document;
    if (!document) return null;
    return document.pages[state.pageIndex] ?? document.pages[0] ?? null;
}

export function selectedDesignElements(state: DesignStoreState): DesignElement[] {
    const page = currentDesignPage(state);
    if (!page) return [];
    return page.elements.filter((element) => state.selectedIds.includes(element.id));
}

/** 用已有的文档换掉当前页，同时记录撤销快照。 */
function withPage(document: DesignDocument, pageIndex: number, mutate: (page: DesignPage) => DesignPage): DesignDocument {
    const pages = document.pages.map((page, index) => (index === pageIndex ? mutate(page) : page));
    return { ...document, pages };
}

/** 序列化体积，用于配额判断（与后端同为 8MiB）。 */
export function designDocumentBytes(document: DesignDocument): number {
    try {
        return new TextEncoder().encode(JSON.stringify(document)).length;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

export function createDesignStore() {
    let lastCommitAt = 0;
    let lastCommitKind = "";
    let lastSnapshot: DesignDocument | null = null;

    return create<DesignStoreState>((set, get) => {
        /**
         * 统一的修改入口：写历史 + 打脏标记。
         * 同一类修改在合并窗口内只压一次快照，避免拖拽产生几十条撤销记录。
         */
        const commit = (kind: string, mutate: (document: DesignDocument, pageIndex: number) => DesignDocument | null) => {
            const state = get();
            const document = state.document;
            if (!document) return;
            const next = mutate(document, state.pageIndex);
            if (!next) return;
            const now = Date.now();
            const merge = kind === lastCommitKind && now - lastCommitAt < HISTORY_MERGE_MS;
            const past = merge ? state.past : [...state.past, document].slice(-HISTORY_LIMIT);
            lastCommitAt = now;
            lastCommitKind = kind;
            lastSnapshot = next;
            set({ document: next, past, future: [], dirty: true });
        };

        const patchElement = (id: string, patch: Partial<DesignElement>, kind = "element-patch") => {
            commit(kind, (document, pageIndex) =>
                withPage(document, pageIndex, (page) => ({
                    ...page,
                    elements: page.elements.map((element) => (element.id === id ? ({ ...element, ...patch } as DesignElement) : element)),
                })),
            );
        };

        return {
            document: null,
            pageIndex: 0,
            selectedIds: [],
            editingTextId: null,
            viewport: { zoom: 1, panX: 0, panY: 0 },
            past: [],
            future: [],
            dirty: false,
            saving: false,
            loading: false,
            error: "",
            remoteId: null,
            revision: 0,
            snapEnabled: true,

            loadDocument: (document, meta) => {
                lastSnapshot = document;
                set({
                    document,
                    pageIndex: 0,
                    selectedIds: [],
                    editingTextId: null,
                    past: [],
                    future: [],
                    dirty: false,
                    error: "",
                    loading: false,
                    remoteId: meta?.remoteId ?? null,
                    revision: meta?.revision ?? 0,
                });
            },

            closeDocument: () => set({ document: null, selectedIds: [], editingTextId: null, past: [], future: [], dirty: false, remoteId: null, revision: 0 }),

            setTitle: (title) => commit("title", (document) => ({ ...document, title })),

            setPreset: (label, width, height) =>
                commit("preset", (document, pageIndex) => {
                    const next = withPage(document, pageIndex, (page) => ({ ...page, width, height }));
                    return { ...next, preset: label };
                }),

            setPageIndex: (index) => {
                const document = get().document;
                if (!document) return;
                set({ pageIndex: Math.max(0, Math.min(index, document.pages.length - 1)), selectedIds: [], editingTextId: null });
            },

            setViewport: (viewport) => set((state) => ({ viewport: { ...state.viewport, ...viewport } })),

            zoomBy: (factor) =>
                set((state) => {
                    const zoom = Math.min(DESIGN_MAX_ZOOM, Math.max(DESIGN_MIN_ZOOM, state.viewport.zoom * factor));
                    return { viewport: { ...state.viewport, zoom } };
                }),

            toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),

            select: (id) => set({ selectedIds: id ? [id] : [], editingTextId: null }),
            selectMany: (ids) => set({ selectedIds: ids, editingTextId: null }),
            selectAll: () => {
                const page = currentDesignPage(get());
                set({ selectedIds: page ? page.elements.map((element) => element.id) : [], editingTextId: null });
            },
            clearSelection: () => set({ selectedIds: [], editingTextId: null }),
            setEditingText: (id) => set({ editingTextId: id }),

            addText: (input) => {
                const page = currentDesignPage(get());
                if (!page) return null;
                const element = createTextElement({ ...input, zIndex: nextZIndex(page.elements) });
                commit("add-element", (document, pageIndex) => withPage(document, pageIndex, (current) => ({ ...current, elements: [...current.elements, element] })));
                set({ selectedIds: [element.id] });
                return element.id;
            },

            addImage: (input) => {
                const page = currentDesignPage(get());
                if (!page) return null;
                // 图片按自然尺寸等比缩放，最大不超过页宽的 60%。
                const maxWidth = page.width * 0.6;
                const scale = input.naturalWidth && input.naturalWidth > maxWidth ? maxWidth / input.naturalWidth : 1;
                const width = Math.round((input.naturalWidth ?? 600) * scale);
                const height = Math.round((input.naturalHeight ?? 600) * scale);
                const element = createImageElement({
                    ...input,
                    width,
                    height,
                    x: Math.round((page.width - width) / 2),
                    y: Math.round((page.height - height) / 2),
                    zIndex: nextZIndex(page.elements),
                });
                commit("add-element", (document, pageIndex) => withPage(document, pageIndex, (current) => ({ ...current, elements: [...current.elements, element] })));
                set({ selectedIds: [element.id] });
                return element.id;
            },

            addShape: (kind, input) => {
                const page = currentDesignPage(get());
                if (!page) return null;
                const element = createShapeElement(kind, { ...input, zIndex: nextZIndex(page.elements) });
                commit("add-element", (document, pageIndex) => withPage(document, pageIndex, (current) => ({ ...current, elements: [...current.elements, element] })));
                set({ selectedIds: [element.id] });
                return element.id;
            },

            updateElement: (id, patch) => patchElement(id, patch),

            updateSelected: (patch) => {
                const ids = get().selectedIds;
                if (ids.length === 0) return;
                commit("element-patch", (document, pageIndex) =>
                    withPage(document, pageIndex, (page) => ({
                        ...page,
                        elements: page.elements.map((element) => (ids.includes(element.id) ? ({ ...element, ...patch } as DesignElement) : element)),
                    })),
                );
            },

            removeSelected: () => {
                const ids = get().selectedIds;
                if (ids.length === 0) return;
                commit("remove-element", (document, pageIndex) =>
                    withPage(document, pageIndex, (page) => ({ ...page, elements: page.elements.filter((element) => !ids.includes(element.id)) })),
                );
                set({ selectedIds: [], editingTextId: null });
            },

            duplicateSelected: () => {
                const page = currentDesignPage(get());
                const ids = get().selectedIds;
                if (!page || ids.length === 0) return;
                const originals = page.elements.filter((element) => ids.includes(element.id));
                if (originals.length === 0) return;
                let z = nextZIndex(page.elements);
                const copies = originals.map((element) => ({
                    ...element,
                    id: createDesignId("el"),
                    x: element.x + 24,
                    y: element.y + 24,
                    zIndex: z++,
                })) as DesignElement[];
                commit("duplicate-element", (document, pageIndex) => withPage(document, pageIndex, (current) => ({ ...current, elements: [...current.elements, ...copies] })));
                set({ selectedIds: copies.map((element) => element.id) });
            },

            reorderSelected: (action) => {
                const ids = get().selectedIds;
                if (ids.length === 0) return;
                commit("reorder-element", (document, pageIndex) =>
                    withPage(document, pageIndex, (page) => {
                        const sorted = sortByZIndex(page.elements).filter((element) => !ids.includes(element.id));
                        const moving = sortByZIndex(page.elements).filter((element) => ids.includes(element.id));
                        const ordered = action === "front" ? [...sorted, ...moving] : [...moving, ...sorted];
                        return { ...page, elements: ordered.map((element, index) => ({ ...element, zIndex: index + 1 })) };
                    }),
                );
            },

            alignSelected: (mode) => {
                const page = currentDesignPage(get());
                const ids = get().selectedIds;
                if (!page || ids.length === 0) return;
                const targets = page.elements.filter((element) => ids.includes(element.id) && !element.locked);
                if (targets.length === 0) return;
                const left = Math.min(...targets.map((element) => element.x));
                const right = Math.max(...targets.map((element) => element.x + element.width));
                const top = Math.min(...targets.map((element) => element.y));
                const bottom = Math.max(...targets.map((element) => element.y + element.height));
                commit("align-element", (document, pageIndex) =>
                    withPage(document, pageIndex, (current) => ({
                        ...current,
                        elements: current.elements.map((element) => {
                            if (!ids.includes(element.id) || element.locked) return element;
                            switch (mode) {
                                case "left":
                                    return { ...element, x: left };
                                case "right":
                                    return { ...element, x: right - element.width };
                                case "center-x":
                                    return { ...element, x: Math.round((left + right - element.width) / 2) };
                                case "top":
                                    return { ...element, y: top };
                                case "bottom":
                                    return { ...element, y: bottom - element.height };
                                case "center-y":
                                    return { ...element, y: Math.round((top + bottom - element.height) / 2) };
                                default:
                                    return element;
                            }
                        }),
                    })),
                );
            },

            undo: () => {
                const state = get();
                if (state.past.length === 0) return;
                const previous = state.past[state.past.length - 1];
                lastCommitKind = "";
                set({
                    document: previous,
                    past: state.past.slice(0, -1),
                    future: state.document ? [state.document, ...state.future].slice(0, HISTORY_LIMIT) : state.future,
                    dirty: true,
                    selectedIds: state.selectedIds.filter((id) => previous.pages[state.pageIndex]?.elements.some((element) => element.id === id)),
                });
            },

            redo: () => {
                const state = get();
                if (state.future.length === 0) return;
                const next = state.future[0];
                lastCommitKind = "";
                set({
                    document: next,
                    past: state.document ? [...state.past, state.document].slice(-HISTORY_LIMIT) : state.past,
                    future: state.future.slice(1),
                    dirty: true,
                });
            },

            markSaved: ({ remoteId, revision }) => set({ remoteId, revision, dirty: false, saving: false }),
            setLoading: (loading) => set({ loading }),
            setState: (partial) => set(partial),
        };
    });
}

export type DesignStore = ReturnType<typeof createDesignStore>;

/** 空白稿工厂，供页面与测试共用。 */
export function createBlankDesignDocument(title = "未命名设计稿", preset = DESIGN_DEFAULT_PRESET.label): DesignDocument {
    return createDesignDocument(title, preset);
}
