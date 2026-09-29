/**
 * 作品集编辑器会话状态。
 *
 * 只保存「正在编辑的这一篇」：文档、当前页、选中集、视口与撤销栈。文档操作全部
 * 走 document.ts 的纯函数，store 只负责把它们串成带撤销的历史；这样排版算法可以
 * 单独测试，而交互层不需要关心快照逻辑。
 */

import { create } from "zustand";

import { PORTFOLIO_MAX_DOC_BYTES, type PortfolioAlignMode, type PortfolioDocument, type PortfolioElementPatch, type PortfolioPage } from "./contracts";
import { arrangeInGrid, alignElements, createImageElement, createPortfolioPage, createTextElement, findPageIndexById, nextZIndex, normalizeZIndex, removeElements, reorderElements, updateElements, type PortfolioZOrderAction } from "./document";

/** 历史快照上限；作品集文档体积大，保留太多会明显吃内存。 */
const HISTORY_LIMIT = 40;

export const PORTFOLIO_MIN_ZOOM = 0.1;
export const PORTFOLIO_MAX_ZOOM = 4;

export type PortfolioViewport = { zoom: number; panX: number; panY: number };

export type PortfolioStoreState = {
    document: PortfolioDocument | null;
    /** 后端文档 ID；为空表示尚未保存过，仍在本地草稿。 */
    remoteId: string | null;
    revision: number;
    pageIndex: number;
    selectedIds: string[];
    dirty: boolean;
    saving: boolean;
    loading: boolean;
    error: string;
    viewport: PortfolioViewport;
    snapEnabled: boolean;
    /** 正在拖拽/缩放时置位，期间改动不进历史，交互结束时才落一次快照。 */
    interacting: boolean;
    /** 交互开始前的文档快照；交互结束且有实际变化时才压入撤销栈。 */
    interactionBaseline: PortfolioDocument | null;
    past: PortfolioDocument[];
    future: PortfolioDocument[];

    loadDocument: (document: PortfolioDocument, meta?: { remoteId?: string | null; revision?: number }) => void;
    closeDocument: () => void;
    setError: (error: string) => void;
    setLoading: (loading: boolean) => void;
    markSaved: (input: { remoteId: string; revision: number }) => void;

    setPageIndex: (index: number) => void;
    setTitle: (title: string) => void;
    setDescription: (description: string) => void;
    setCoverUrl: (coverUrl: string) => void;

    addPage: () => void;
    duplicatePage: (pageId: string) => void;
    removePage: (pageId: string) => void;
    movePage: (from: number, to: number) => void;
    updatePage: (pageId: string, patch: Partial<Pick<PortfolioPage, "name" | "width" | "height" | "background">>) => void;

    addImage: (input: { src: string; assetId?: string; naturalWidth?: number; naturalHeight?: number; x?: number; y?: number; width?: number; height?: number }) => string | null;
    addText: (input?: { text?: string; x?: number; y?: number }) => string | null;

    updateElement: (elementId: string, patch: PortfolioElementPatch) => void;
    updateSelected: (patch: PortfolioElementPatch) => void;
    /** 一次性套用多个元素的补丁，只产生一条撤销记录（Agent 批量回写用）。 */
    applyElementPatches: (patches: ReadonlyMap<string, PortfolioElementPatch>) => void;
    removeSelected: () => void;
    duplicateSelected: () => void;
    reorderSelected: (action: PortfolioZOrderAction) => void;
    alignSelected: (mode: PortfolioAlignMode) => void;
    arrangeSelected: (columns: number, gap?: number, padding?: number) => void;

    setSelection: (ids: string[]) => void;
    toggleSelection: (id: string, additive: boolean) => void;
    selectAll: () => void;
    clearSelection: () => void;

    beginInteraction: () => void;
    endInteraction: () => void;
    /** 拖拽过程中直接替换文档，不写历史（历史在 beginInteraction 时已落点）。 */
    applyDocumentLive: (document: PortfolioDocument) => void;

    undo: () => void;
    redo: () => void;

    setViewport: (viewport: Partial<PortfolioViewport>) => void;
    zoomBy: (factor: number, anchor?: { x: number; y: number }) => void;
    resetViewport: () => void;
    toggleSnap: () => void;
};

function currentPage(document: PortfolioDocument | null, pageIndex: number): PortfolioPage | null {
    if (!document) return null;
    return document.pages[pageIndex] ?? document.pages[0] ?? null;
}

/** 供选择器使用：返回文档里的页面对象本身，引用稳定，不会触发多余渲染。 */
export function currentPortfolioPage(state: PortfolioStoreState): PortfolioPage | null {
    return currentPage(state.document, state.pageIndex);
}

/** 页码与选中集都可能越界（删页、撤销），统一在这里收敛。 */
function reconcile(document: PortfolioDocument, pageIndex: number, selectedIds: readonly string[]) {
    const index = Math.min(Math.max(pageIndex, 0), Math.max(document.pages.length - 1, 0));
    const ids = new Set(document.pages.flatMap((page) => page.elements.map((element) => element.id)));
    return { pageIndex: index, selectedIds: selectedIds.filter((id) => ids.has(id)) };
}

function replacePage(document: PortfolioDocument, pageIndex: number, page: PortfolioPage): PortfolioDocument {
    return { ...document, pages: document.pages.map((item, index) => (index === pageIndex ? page : item)) };
}

export const usePortfolioStore = create<PortfolioStoreState>((set, get) => {
    /**
     * 连续输入（拖动数值框、连打字）会产生大量微改动，如果每次都压栈，撤销就会
     * 退化成"一个字一个字退"。相同合并键在窗口期内的连续修改只保留最早那份快照。
     */
    let lastCommit: { key: string; at: number } | null = null;
    const COALESCE_WINDOW_MS = 1200;

    /** 一次离散修改：落历史 → 替换文档 → 标记脏。 */
    const commit = (mutate: (document: PortfolioDocument, pageIndex: number) => { document: PortfolioDocument; selectedIds?: string[] }, coalesceKey?: string) =>
        set((state) => {
            if (!state.document) return state;
            const result = mutate(state.document, state.pageIndex);
            if (result.document === state.document) return state;
            const reconciled = reconcile(result.document, state.pageIndex, result.selectedIds ?? state.selectedIds);
            const now = Date.now();
            const coalesced = Boolean(coalesceKey && lastCommit && lastCommit.key === coalesceKey && now - lastCommit.at < COALESCE_WINDOW_MS);
            lastCommit = coalesceKey ? { key: coalesceKey, at: now } : null;
            return {
                document: result.document,
                dirty: true,
                past: coalesced ? state.past : [...state.past, state.document].slice(-HISTORY_LIMIT),
                future: [],
                error: "",
                ...reconciled,
            };
        });

    /** 用补丁字段名自动生成合并键，调用方不需要关心。 */
    const patchKey = (scope: string, patch: PortfolioElementPatch) =>
        `${scope}:${Object.keys(patch)
            .filter((key) => key !== "zIndex")
            .sort()
            .join(",")}`;

    const mutateCurrentPage = (mutate: (page: PortfolioPage, pageIndex: number) => PortfolioPage, coalesceKey?: string) =>
        commit((document, pageIndex) => {
            const page = currentPage(document, pageIndex);
            if (!page) return { document };
            const next = mutate(page, pageIndex);
            if (next === page) return { document };
            return { document: replacePage(document, pageIndex, next) };
        }, coalesceKey);

    return {
        document: null,
        remoteId: null,
        revision: 0,
        pageIndex: 0,
        selectedIds: [],
        dirty: false,
        saving: false,
        loading: false,
        error: "",
        viewport: { zoom: 1, panX: 0, panY: 0 },
        snapEnabled: true,
        interacting: false,
        interactionBaseline: null,
        past: [],
        future: [],

        loadDocument: (document, meta) =>
            set({
                document,
                remoteId: meta?.remoteId ?? null,
                revision: meta?.revision ?? 0,
                pageIndex: 0,
                selectedIds: [],
                dirty: false,
                loading: false,
                error: "",
                interacting: false,
                interactionBaseline: null,
                past: [],
                future: [],
            }),

        closeDocument: () => set({ document: null, remoteId: null, revision: 0, selectedIds: [], past: [], future: [], dirty: false, error: "", interacting: false, interactionBaseline: null }),
        setError: (error) => set({ error, loading: false, saving: false }),
        setLoading: (loading) => set({ loading }),
        markSaved: ({ remoteId, revision }) => set({ remoteId, revision, dirty: false, saving: false }),

        setPageIndex: (index) =>
            set((state) => {
                if (!state.document) return state;
                const next = reconcile(state.document, index, []);
                return { pageIndex: next.pageIndex, selectedIds: [] };
            }),

        setTitle: (title) => commit((document) => ({ document: { ...document, title } }), "document:title"),
        setDescription: (description) => commit((document) => ({ document: { ...document, description } }), "document:description"),
        setCoverUrl: (coverUrl) => commit((document) => ({ document: { ...document, coverUrl } }), "document:coverUrl"),

        addPage: () =>
            set((state) => {
                if (!state.document) return state;
                const page = createPortfolioPage(state.document.pages.length + 1);
                const document = { ...state.document, pages: [...state.document.pages, page] };
                return {
                    document,
                    pageIndex: document.pages.length - 1,
                    selectedIds: [],
                    dirty: true,
                    error: "",
                    past: [...state.past, state.document].slice(-HISTORY_LIMIT),
                    future: [],
                };
            }),

        duplicatePage: (pageId) =>
            set((state) => {
                if (!state.document) return state;
                const index = findPageIndexById(state.document, pageId);
                if (index < 0) return state;
                const source = state.document.pages[index];
                const copy: PortfolioPage = {
                    ...source,
                    id: createPortfolioPage(index + 1).id,
                    name: `${source.name} 副本`,
                    // 元素必须换新 ID，否则同一元素会同时存在于两页，选中与更新都会串页。
                    elements: normalizeZIndex(source.elements).map((element) => ({ ...element, id: `${element.id}_copy_${Math.random().toString(36).slice(2, 8)}` })),
                };
                const pages = [...state.document.pages];
                pages.splice(index + 1, 0, copy);
                return {
                    document: { ...state.document, pages },
                    pageIndex: index + 1,
                    selectedIds: [],
                    dirty: true,
                    error: "",
                    past: [...state.past, state.document].slice(-HISTORY_LIMIT),
                    future: [],
                };
            }),

        removePage: (pageId) =>
            set((state) => {
                if (!state.document || state.document.pages.length <= 1) return state;
                const index = findPageIndexById(state.document, pageId);
                if (index < 0) return state;
                const pages = state.document.pages.filter((page) => page.id !== pageId);
                return {
                    document: { ...state.document, pages },
                    pageIndex: Math.min(index, pages.length - 1),
                    selectedIds: [],
                    dirty: true,
                    error: "",
                    past: [...state.past, state.document].slice(-HISTORY_LIMIT),
                    future: [],
                };
            }),

        movePage: (from, to) =>
            set((state) => {
                if (!state.document) return state;
                const pages = [...state.document.pages];
                if (from < 0 || from >= pages.length || to < 0 || to >= pages.length || from === to) return state;
                const [moved] = pages.splice(from, 1);
                pages.splice(to, 0, moved);
                return {
                    document: { ...state.document, pages },
                    pageIndex: to,
                    dirty: true,
                    error: "",
                    past: [...state.past, state.document].slice(-HISTORY_LIMIT),
                    future: [],
                };
            }),

        updatePage: (pageId, patch) =>
            commit(
                (document) => {
                    const pages = document.pages.map((page) => (page.id === pageId ? { ...page, ...patch } : page));
                    return { document: { ...document, pages } };
                },
                `page:${pageId}:${Object.keys(patch).sort().join(",")}`,
            ),

        addImage: (input) => {
            const state = get();
            const page = currentPage(state.document, state.pageIndex);
            if (!state.document || !page) return null;
            const naturalWidth = input.naturalWidth || 0;
            const naturalHeight = input.naturalHeight || 0;
            // 未给出尺寸时按原图比例适配到页面的一半宽度，避免超大图直接铺满整页。
            const width = input.width ?? (naturalWidth > 0 ? Math.min(naturalWidth, page.width * 0.5) : page.width * 0.4);
            const height = input.height ?? (naturalHeight > 0 ? width * (naturalHeight / naturalWidth) : width * 0.66);
            const x = input.x ?? Math.max(0, (page.width - width) / 2);
            const y = input.y ?? Math.max(0, (page.height - height) / 2);
            const element = createImageElement({
                src: input.src,
                assetId: input.assetId,
                naturalWidth,
                naturalHeight,
                x,
                y,
                width,
                height,
                zIndex: nextZIndex(page.elements),
            });
            commit((document, pageIndex) => {
                const target = currentPage(document, pageIndex);
                if (!target) return { document };
                return {
                    document: replacePage(document, pageIndex, { ...target, elements: [...target.elements, element] }),
                    selectedIds: [element.id],
                };
            });
            return element.id;
        },

        addText: (input) => {
            const state = get();
            const page = currentPage(state.document, state.pageIndex);
            if (!state.document || !page) return null;
            const width = Math.min(560, page.width * 0.4);
            const element = createTextElement({
                text: input?.text ?? "双击编辑文字",
                x: input?.x ?? page.width * 0.1,
                y: input?.y ?? page.height * 0.1,
                width,
                height: 56,
                zIndex: nextZIndex(page.elements),
            });
            commit((document, pageIndex) => {
                const target = currentPage(document, pageIndex);
                if (!target) return { document };
                return {
                    document: replacePage(document, pageIndex, { ...target, elements: [...target.elements, element] }),
                    selectedIds: [element.id],
                };
            });
            return element.id;
        },

        updateElement: (elementId, patch) =>
            mutateCurrentPage((page) => ({ ...page, elements: page.elements.map((element) => (element.id === elementId ? ({ ...element, ...patch } as typeof element) : element)) }), patchKey(`element:${elementId}`, patch)),

        updateSelected: (patch) => {
            const ids = get().selectedIds;
            if (ids.length === 0) return;
            const patches = new Map(ids.map((id) => [id, patch]));
            mutateCurrentPage((page) => updateElements(page, patches), patchKey("selection", patch));
        },

        applyElementPatches: (patches) => {
            if (patches.size === 0) return;
            mutateCurrentPage((page) => updateElements(page, patches));
        },

        removeSelected: () => {
            const ids = get().selectedIds;
            if (ids.length === 0) return;
            commit((document, pageIndex) => {
                const page = currentPage(document, pageIndex);
                if (!page) return { document };
                return { document: replacePage(document, pageIndex, removeElements(page, ids)), selectedIds: [] };
            });
        },

        duplicateSelected: () => {
            const ids = get().selectedIds;
            if (ids.length === 0) return;
            commit((document, pageIndex) => {
                const page = currentPage(document, pageIndex);
                if (!page) return { document };
                const selected = page.elements.filter((element) => ids.includes(element.id));
                let zIndex = nextZIndex(page.elements);
                const copies = selected.map((element) => {
                    // 偏移一点避免和原件完全重叠，用户一眼能看出复制成功。
                    const copy = { ...element, id: `${element.id}_copy_${Math.random().toString(36).slice(2, 8)}`, x: element.x + 24, y: element.y + 24, zIndex: zIndex++ };
                    return copy;
                });
                return {
                    document: replacePage(document, pageIndex, { ...page, elements: [...page.elements, ...copies] }),
                    selectedIds: copies.map((copy) => copy.id),
                };
            });
        },

        reorderSelected: (action) => {
            const ids = get().selectedIds;
            if (ids.length === 0) return;
            mutateCurrentPage((page) => reorderElements(page, ids, action));
        },

        alignSelected: (mode) => {
            const ids = get().selectedIds;
            if (ids.length === 0) return;
            mutateCurrentPage((page) => alignElements(page, ids, mode));
        },

        arrangeSelected: (columns, gap = 24, padding = 48) => {
            const ids = get().selectedIds;
            if (ids.length === 0) return;
            mutateCurrentPage((page) => arrangeInGrid(page, ids, columns, gap, padding));
        },

        setSelection: (ids) => set({ selectedIds: ids }),
        toggleSelection: (id, additive) =>
            set((state) => {
                if (!additive) return { selectedIds: [id] };
                return { selectedIds: state.selectedIds.includes(id) ? state.selectedIds.filter((item) => item !== id) : [...state.selectedIds, id] };
            }),
        selectAll: () =>
            set((state) => {
                const page = currentPage(state.document, state.pageIndex);
                return { selectedIds: page ? page.elements.map((element) => element.id) : [] };
            }),
        clearSelection: () => set({ selectedIds: [] }),

        beginInteraction: () =>
            set((state) => {
                if (!state.document || state.interacting) return state;
                // 只记基线，不立刻压栈：用户可能只是点一下，没有真正改动。
                return { interacting: true, interactionBaseline: state.document };
            }),

        endInteraction: () =>
            set((state) => {
                if (!state.interacting) return state;
                const baseline = state.interactionBaseline;
                if (!baseline || baseline === state.document) return { interacting: false, interactionBaseline: null };
                return {
                    interacting: false,
                    interactionBaseline: null,
                    dirty: true,
                    past: [...state.past, baseline].slice(-HISTORY_LIMIT),
                    future: [],
                };
            }),

        applyDocumentLive: (document) => set((state) => (state.document ? { document } : state)),

        undo: () =>
            set((state) => {
                if (state.past.length === 0 || !state.document) return state;
                const previous = state.past[state.past.length - 1];
                const reconciled = reconcile(previous, state.pageIndex, state.selectedIds);
                return {
                    document: previous,
                    past: state.past.slice(0, -1),
                    future: [state.document, ...state.future].slice(0, HISTORY_LIMIT),
                    dirty: true,
                    ...reconciled,
                };
            }),

        redo: () =>
            set((state) => {
                if (state.future.length === 0 || !state.document) return state;
                const next = state.future[0];
                const reconciled = reconcile(next, state.pageIndex, state.selectedIds);
                return {
                    document: next,
                    past: [...state.past, state.document].slice(-HISTORY_LIMIT),
                    future: state.future.slice(1),
                    dirty: true,
                    ...reconciled,
                };
            }),

        setViewport: (viewport) => set((state) => ({ viewport: { ...state.viewport, ...viewport } })),

        zoomBy: (factor, anchor) =>
            set((state) => {
                const zoom = Math.min(PORTFOLIO_MAX_ZOOM, Math.max(PORTFOLIO_MIN_ZOOM, state.viewport.zoom * factor));
                if (zoom === state.viewport.zoom) return state;
                const focus = anchor ?? { x: 0, y: 0 };
                // 以锚点为中心缩放：锚点下的页面坐标在缩放前后保持不变。
                const pageX = (focus.x - state.viewport.panX) / state.viewport.zoom;
                const pageY = (focus.y - state.viewport.panY) / state.viewport.zoom;
                return { viewport: { zoom, panX: focus.x - pageX * zoom, panY: focus.y - pageY * zoom } };
            }),

        resetViewport: () => set({ viewport: { zoom: 1, panX: 0, panY: 0 } }),
        toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),
    };
});

/** 当前页的选中元素；选择器返回新数组，调用方应配合 useMemo 或只读使用。 */
export function selectedElements(state: PortfolioStoreState) {
    const page = currentPage(state.document, state.pageIndex);
    if (!page) return [];
    return page.elements.filter((element) => state.selectedIds.includes(element.id));
}

/** 保存前把文档序列化，用于体积校验与提交后端。 */
export function serializePortfolioDocument(document: PortfolioDocument): string {
    return JSON.stringify(document);
}

export function portfolioDocumentBytes(document: PortfolioDocument): number {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(serializePortfolioDocument(document)).length;
    return serializePortfolioDocument(document).length;
}

export function isPortfolioDocumentTooLarge(document: PortfolioDocument): boolean {
    return portfolioDocumentBytes(document) > PORTFOLIO_MAX_DOC_BYTES;
}
