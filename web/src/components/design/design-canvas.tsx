/**
 * 设计工作台的画布。
 *
 * 自建于 leafer-ui 之上：元素类型（形状、文本、图片）、选中交互与坐标约束
 * 都按设计稿的需要实现。
 *
 * 职责边界：本组件只做「把文档画出来 + 把指针操作翻译成 store 动作」。
 * 不持有文档副本，所有改动都写回 store，撤销栈由 store 统一管理。
 */

import { Group, Leafer, Path, Rect, Text, type IRect, type IUI } from "leafer-ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { DesignElement, DesignImageElement, DesignPage, DesignTextElement } from "@/lib/design/contracts";
import { currentDesignPage, useDesignStore, useDesignStoreApi } from "@/lib/design/store-context";

export type DesignCanvasHandle = {
    /** 缩放并居中，让整页刚好落在视口内。 */
    fit: () => void;
};

export type DesignCanvasProps = {
    onReady?: (handle: DesignCanvasHandle) => void;
    onEditText?: (element: DesignTextElement | null) => void;
};

type Scene = {
    leafer: Leafer;
    world: Group;
    shadow: Rect;
    pageRect: Rect;
    content: Group;
    chrome: Group;
    nodes: Map<string, IUI>;
};

const EMPTY_ELEMENTS: readonly DesignElement[] = [];

export function DesignCanvas({ onReady, onEditText }: DesignCanvasProps) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const stageRef = useRef<HTMLDivElement | null>(null);
    const sceneRef = useRef<Scene | null>(null);
    const viewportRef = useRef({ zoom: 1, panX: 0, panY: 0 });
    const [stageSize, setStageSize] = useState({ width: 1, height: 1 });

    const storeApi = useDesignStoreApi();
    const page = useDesignStore(currentDesignPage);
    const selectedIds = useDesignStore((state) => state.selectedIds);
    const viewport = useDesignStore((state) => state.viewport);
    const snapEnabled = useDesignStore((state) => state.snapEnabled);
    viewportRef.current = viewport;

    const elements = page?.elements ?? EMPTY_ELEMENTS;

    // ---- 场景生命周期 ----
    useLayoutEffect(() => {
        const host = hostRef.current;
        const stage = stageRef.current;
        if (!host || !stage) return;
        const scene = createScene(host);
        sceneRef.current = scene;
        const resize = () => {
            const rect = stage.getBoundingClientRect();
            const size = { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
            setStageSize(size);
            scene.leafer.resize({ ...size, pixelRatio: pixelRatio() });
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(stage);
        window.addEventListener("resize", resize);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", resize);
            scene.leafer.destroy(true);
            sceneRef.current = null;
        };
    }, []);

    // ---- 视口同步 ----
    useLayoutEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;
        scene.world.set({ x: viewport.panX, y: viewport.panY, scaleX: viewport.zoom, scaleY: viewport.zoom });
    }, [viewport, stageSize]);

    // ---- 页面与元素同步 ----
    useLayoutEffect(() => {
        const scene = sceneRef.current;
        if (!scene || !page) return;
        scene.pageRect.set({ x: 0, y: 0, width: page.width, height: page.height, fill: page.background || "#ffffff" });
        scene.shadow.set({ x: 6, y: 8, width: page.width, height: page.height, fill: "rgba(15, 23, 42, 0.18)" });
        syncElements(scene, page);
    }, [page, elements]);

    // ---- 选中框 ----
    useLayoutEffect(() => {
        const scene = sceneRef.current;
        if (!scene || !page) return;
        const selected = page.elements.filter((element) => selectedIds.includes(element.id));
        scene.chrome.removeAll();
        if (selected.length === 0) return;
        for (const element of selected) {
            scene.chrome.add(new Rect({ x: element.x, y: element.y, width: element.width, height: element.height, fill: "transparent", stroke: "#2563eb", strokeWidth: 1.5, hittable: false, strokeAlign: "center" }));
        }
        if (selected.length === 1) {
            // 四角控制点：视觉提示可缩放，实际拖拽由指针逻辑处理。
            const target = selected[0];
            const size = 8;
            for (const [cx, cy] of [
                [target.x, target.y],
                [target.x + target.width, target.y],
                [target.x, target.y + target.height],
                [target.x + target.width, target.y + target.height],
            ]) {
                scene.chrome.add(new Rect({ x: cx - size / 2, y: cy - size / 2, width: size, height: size, fill: "#ffffff", stroke: "#2563eb", strokeWidth: 1.5, hittable: false }));
            }
        }
    }, [page, selectedIds]);

    // ---- 适应窗口 ----
    const fit = useCallback(() => {
        const current = currentDesignPage(storeApi.getState());
        const stage = stageRef.current;
        if (!current || !stage) return;
        const rect = stage.getBoundingClientRect();
        const padding = 48;
        const zoom = Math.min((rect.width - padding * 2) / current.width, (rect.height - padding * 2) / current.height, 2);
        const safeZoom = Math.max(0.05, Number.isFinite(zoom) ? zoom : 1);
        storeApi.getState().setViewport({
            zoom: safeZoom,
            panX: (rect.width - current.width * safeZoom) / 2,
            panY: (rect.height - current.height * safeZoom) / 2,
        });
    }, [storeApi]);

    useEffect(() => {
        if (page && stageSize.width > 1) fit();
        // 只在页面首次就绪时适配一次；后续改尺寸由尺寸预设自己触发 fit。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page?.id, stageSize.width > 1]);

    useEffect(() => {
        onReady?.({ fit });
    }, [fit, onReady]);

    // ---- 指针交互：选择 / 拖动 / 平移 / 缩放 ----
    const dragRef = useRef<{ mode: "none" | "move" | "pan" | "resize"; startX: number; startY: number; origin: Map<string, { x: number; y: number }>; pointerId: number }>({ mode: "none", startX: 0, startY: 0, origin: new Map(), pointerId: -1 });

    const toPagePoint = (clientX: number, clientY: number) => {
        const stage = stageRef.current;
        if (!stage) return { x: 0, y: 0 };
        const rect = stage.getBoundingClientRect();
        const { zoom, panX, panY } = viewportRef.current;
        return { x: (clientX - rect.left - panX) / zoom, y: (clientY - rect.top - panY) / zoom };
    };

    const hitTest = (point: { x: number; y: number }): DesignElement | null => {
        const current = currentDesignPage(storeApi.getState());
        if (!current) return null;
        // 从上层往下找，命中第一个未锁定元素。
        const ordered = [...current.elements].sort((a, b) => b.zIndex - a.zIndex);
        for (const element of ordered) {
            if (element.locked) continue;
            if (point.x >= element.x && point.x <= element.x + element.width && point.y >= element.y && point.y <= element.y + element.height) return element;
        }
        return null;
    };

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const point = toPagePoint(event.clientX, event.clientY);
        // 中键或空格拖拽 = 平移画布。
        if (event.button === 1 || event.altKey) {
            dragRef.current = { mode: "pan", startX: event.clientX, startY: event.clientY, origin: new Map(), pointerId: event.pointerId };
            event.currentTarget.setPointerCapture(event.pointerId);
            return;
        }
        const hit = hitTest(point);
        const store = storeApi.getState();
        if (!hit) {
            store.clearSelection();
            if (onEditText) onEditText(null);
            return;
        }
        if (!store.selectedIds.includes(hit.id)) store.select(hit.id);
        const origin = new Map<string, { x: number; y: number }>();
        const current = currentDesignPage(storeApi.getState());
        for (const element of current?.elements ?? []) {
            if (storeApi.getState().selectedIds.includes(element.id) && !element.locked) origin.set(element.id, { x: element.x, y: element.y });
        }
        dragRef.current = { mode: "move", startX: event.clientX, startY: event.clientY, origin, pointerId: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (drag.mode === "none") return;
        if (drag.mode === "pan") {
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            drag.startX = event.clientX;
            drag.startY = event.clientY;
            const view = viewportRef.current;
            storeApi.getState().setViewport({ panX: view.panX + dx, panY: view.panY + dy });
            return;
        }
        const dx = (event.clientX - drag.startX) / viewportRef.current.zoom;
        const dy = (event.clientY - drag.startY) / viewportRef.current.zoom;
        const store = storeApi.getState();
        for (const [id, origin] of drag.origin) {
            let x = origin.x + dx;
            let y = origin.y + dy;
            if (snapEnabled) {
                // 吸附到 8px 网格：海报排版里手调 1px 意义不大，网格让对齐变快。
                x = Math.round(x / 8) * 8;
                y = Math.round(y / 8) * 8;
            }
            store.updateElement(id, { x, y });
        }
    };

    const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
        if (dragRef.current.mode === "none") return;
        dragRef.current = { mode: "none", startX: 0, startY: 0, origin: new Map(), pointerId: -1 };
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const point = toPagePoint(event.clientX, event.clientY);
        const hit = hitTest(point);
        if (hit && hit.kind === "text") {
            storeApi.getState().setEditingText(hit.id);
            onEditText?.(hit as DesignTextElement);
        }
    };

    // 滚轮缩放：以指针位置为锚点，缩放后指针下的内容不跑。
    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const onWheel = (event: WheelEvent) => {
            if (!event.ctrlKey && !event.metaKey) {
                const view = viewportRef.current;
                storeApi.getState().setViewport({ panX: view.panX - event.deltaX, panY: view.panY - event.deltaY });
                event.preventDefault();
                return;
            }
            event.preventDefault();
            const rect = stage.getBoundingClientRect();
            const view = viewportRef.current;
            const factor = event.deltaY > 0 ? 1 / 1.1 : 1.1;
            const zoom = Math.min(4, Math.max(0.1, view.zoom * factor));
            const px = event.clientX - rect.left;
            const py = event.clientY - rect.top;
            storeApi.getState().setViewport({
                zoom,
                panX: px - (px - view.panX) * (zoom / view.zoom),
                panY: py - (py - view.panY) * (zoom / view.zoom),
            });
        };
        stage.addEventListener("wheel", onWheel, { passive: false });
        return () => stage.removeEventListener("wheel", onWheel);
    }, [storeApi]);

    return (
        <div ref={stageRef} className="design-stage" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onDoubleClick={onDoubleClick}>
            <div ref={hostRef} className="absolute inset-0" />
            {!page ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-white/45">正在准备画布</div>
            ) : null}
        </div>
    );
}

function pixelRatio() {
    if (typeof window === "undefined") return 1;
    return Math.min(2, Math.max(1, window.devicePixelRatio || 1));
}

function createScene(host: HTMLDivElement): Scene {
    const leafer = new Leafer({ view: host, width: 1, height: 1, pixelRatio: pixelRatio(), fill: "transparent", hittable: false, smooth: true });
    const world = new Group({ hittable: false });
    const shadow = new Rect({ hittable: false });
    const pageRect = new Rect({ hittable: false });
    const content = new Group({ hittable: false });
    const chrome = new Group({ hittable: false });
    world.add(shadow);
    world.add(pageRect);
    world.add(content);
    world.add(chrome);
    leafer.add(world);
    return { leafer, world, shadow, pageRect, content, chrome, nodes: new Map() };
}

/** 全量重建内容层。元素数量在单页海报量级（几十个），重建比增量 diff 更不容易出错。 */
function syncElements(scene: Scene, page: DesignPage) {
    scene.content.removeAll();
    scene.nodes.clear();
    const ordered = [...page.elements].sort((a, b) => a.zIndex - b.zIndex);
    for (const element of ordered) {
        const node = createNode(element);
        if (node) {
            scene.content.add(node as never);
            scene.nodes.set(element.id, node);
        }
    }
}

function createNode(element: DesignElement): IUI | null {
    const common = {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        rotation: element.rotation,
        opacity: element.opacity,
        hittable: false,
    } as IRect;

    if (element.kind === "text") {
        const text = element as DesignTextElement;
        return new Text({
            ...common,
            text: text.text,
            fontSize: text.fontSize,
            fontWeight: text.fontWeight as never,
            fill: text.color,
            textAlign: text.align,
            lineHeight: text.lineHeight,
            letterSpacing: text.letterSpacing,
            fontFamily: text.fontFamily,
            verticalAlign: "top",
            textWrap: "break",
        });
    }

    if (element.kind === "image") {
        const image = element as DesignImageElement;
        // 用 Path 承载图片：leafer 的 Image 需要按 URL 异步加载，这里直接走 URL
        // 让浏览器缓存接管；加载完成前该层为空，不影响其它元素。
        return new Path({
            ...common,
            path: `M0 0 H${image.width} V${image.height} H0 Z`,
            fill: { type: "image", url: image.src, mode: image.fit === "contain" ? "fit" : image.fit === "fill" ? "stretch" : "clip" } as never,
        });
    }

    if (element.kind === "ellipse") {
        return new Path({
            ...common,
            path: `M${element.width / 2} 0 A${element.width / 2} ${element.height / 2} 0 1 1 ${element.width / 2} ${element.height} A${element.width / 2} ${element.height / 2} 0 1 1 ${element.width / 2} 0 Z`,
            fill: element.fill,
            stroke: element.stroke,
            strokeWidth: element.strokeWidth,
        });
    }

    if (element.kind === "line") {
        return new Path({ ...common, path: `M0 ${element.height / 2} H${element.width}`, stroke: element.fill === "transparent" ? element.stroke : element.fill, strokeWidth: Math.max(1, element.strokeWidth || 2) });
    }

    return new Rect({
        ...common,
        fill: element.fill,
        stroke: element.stroke,
        strokeWidth: element.strokeWidth,
        cornerRadius: element.cornerRadius,
    });
}
