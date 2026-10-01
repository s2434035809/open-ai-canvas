/**
 * 作品集画布。
 *
 * 分工：leafer-ui 只负责渲染（页面底图、图片、文字），选中框/手柄/参考线用 DOM 叠层，
 * 因为它们需要固定屏幕尺寸与真实光标，交给渲染层反而要做坐标补偿。交互全在 DOM 层，
 * 直接读写作品集 store，落盘的是同一份文档模型。
 */

import { Group, Leafer, Path, Rect, Text, type IFontWeight } from "leafer-ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { PortfolioDocument, PortfolioElement, PortfolioImageElement, PortfolioRect, PortfolioSnapGuide, PortfolioTextElement } from "@/lib/portfolio/contracts";
import { sortByZIndex } from "@/lib/portfolio/document";
import {
    elementBounds,
    elementCenter,
    fitViewTransform,
    hitTestElements,
    marqueeSelect,
    normalizeRect,
    pageToScreen,
    RESIZE_HANDLES,
    resizeRectFromHandle,
    rotateHandleCursor,
    rotationFromPointer,
    screenToPage,
    unionElementBounds,
    type Point,
    type ResizeHandle,
    type ViewTransform,
} from "@/lib/portfolio/geometry";
import { currentPortfolioPage, usePortfolioStore } from "@/lib/portfolio/store";
import { snapRect } from "@/lib/portfolio/document";

/** 吸附阈值按屏幕像素给，缩放后手感一致。 */
const SNAP_THRESHOLD_SCREEN = 6;
/** 拖动超过这个屏幕距离才算"移动过"，用于区分点选与拖动。 */
const DRAG_THRESHOLD_SCREEN = 3;
const HANDLE_SIZE = 10;
const ROTATE_OFFSET = 26;

/** 空页面时给一个稳定引用，避免每次渲染都制造新数组导致下游 memo 失效。 */
const EMPTY_ELEMENTS: readonly PortfolioElement[] = [];

const HANDLE_STYLE: Record<ResizeHandle, { left: string; top: string }> = {
    nw: { left: "0%", top: "0%" },
    n: { left: "50%", top: "0%" },
    ne: { left: "100%", top: "0%" },
    e: { left: "100%", top: "50%" },
    se: { left: "100%", top: "100%" },
    s: { left: "50%", top: "100%" },
    sw: { left: "0%", top: "100%" },
    w: { left: "0%", top: "50%" },
};

const HANDLE_CURSOR: Record<ResizeHandle, string> = {
    nw: "nw-resize",
    n: "n-resize",
    ne: "ne-resize",
    e: "e-resize",
    se: "se-resize",
    s: "s-resize",
    sw: "sw-resize",
    w: "w-resize",
};

type Scene = {
    leafer: Leafer;
    world: Group;
    shadow: Rect;
    pageRect: Rect;
    content: Group;
    chrome: Group;
    nodes: Map<string, Rect | Text>;
    order: string[];
};

type Interaction =
    | { mode: "idle" }
    | { mode: "pan"; startScreen: Point; startPan: { x: number; y: number }; moved: boolean }
    | { mode: "move"; startPage: Point; starts: Map<string, Point>; startBounds: PortfolioRect; moved: boolean }
    | { mode: "marquee"; startPage: Point; moved: boolean }
    | { mode: "resize"; elementId: string; handle: ResizeHandle; startRect: PortfolioRect; rotation: number; keepRatio: boolean; moved: boolean }
    | { mode: "rotate"; elementId: string; startRotation: number; pointerOffset: number; moved: boolean };

export type PortfolioCanvasHandle = {
    /** 把当前页适配到视口中央。 */
    fit: () => void;
};

type PortfolioCanvasProps = {
    onEditText?: (elementId: string) => void;
    /** 画布内容准备就绪后回调，供页面做「首次进入自动适配」。 */
    onReady?: (handle: PortfolioCanvasHandle) => void;
};

function pixelRatio() {
    return Math.min(3, Math.max(1, window.devicePixelRatio || 1));
}

function imageFillMode(fit: PortfolioImageElement["fit"]) {
    if (fit === "contain") return "fit" as const;
    if (fit === "fill") return "stretch" as const;
    return "cover" as const;
}

export function PortfolioCanvas({ onEditText, onReady }: PortfolioCanvasProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<Scene | null>(null);
    const interactionRef = useRef<Interaction>({ mode: "idle" });
    const viewportRef = useRef<ViewTransform>({ zoom: 1, panX: 0, panY: 0 });
    const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
    const [spacePressed, setSpacePressed] = useState(false);
    const [marquee, setMarquee] = useState<PortfolioRect | null>(null);

    const page = usePortfolioStore(currentPortfolioPage);
    const selectedIds = usePortfolioStore((state) => state.selectedIds);
    const viewport = usePortfolioStore((state) => state.viewport);
    viewportRef.current = viewport;

    const elements = page?.elements ?? EMPTY_ELEMENTS;
    const selected = useMemo(() => elements.filter((element) => selectedIds.includes(element.id)), [elements, selectedIds]);
    const single = selected.length === 1 ? selected[0] : null;

    // ---- 场景生命周期 ----
    useLayoutEffect(() => {
        const host = hostRef.current;
        const stage = stageRef.current;
        if (!host || !stage) return;
        const scene = createScene(host);
        sceneRef.current = scene;
        const resize = () => {
            const rect = stage.getBoundingClientRect();
            const size = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
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
        // 阴影整体右下偏移：页面像卡片一样"浮"在网格工作区上。
        scene.shadow.set({ x: 5, y: 7, width: page.width, height: page.height, fill: "rgba(15, 23, 42, 0.16)" });
        syncElementNodes(scene, sortByZIndex(elements));
    }, [page, elements]);

    // ---- 参考线分层渲染（拖动期间高频更新，不走 React 状态） ----
    const drawGuides = useCallback(
        (guides: readonly PortfolioSnapGuide[], bounds: PortfolioRect | null) => {
            const scene = sceneRef.current;
            if (!scene || !page) return;
            scene.chrome.removeAll(true);
            for (const guide of guides) {
                const from = guide.axis === "x" ? { x: guide.position, y: Math.min(guide.from, guide.to) } : { x: Math.min(guide.from, guide.to), y: guide.position };
                const to = guide.axis === "x" ? { x: guide.position, y: Math.max(guide.from, guide.to) } : { x: Math.max(guide.from, guide.to), y: guide.position };
                scene.chrome.add(new Path({ path: `M ${from.x} ${from.y} L ${to.x} ${to.y}`, stroke: "#f43f5e", strokeWidth: 1 / Math.max(viewportRef.current.zoom, 0.01), dashPattern: [6, 4], hittable: false }));
            }
            if (bounds) {
                scene.chrome.add(new Rect({ ...bounds, fill: "rgba(56, 189, 248, 0.12)", stroke: "#0ea5e9", strokeWidth: 1 / Math.max(viewportRef.current.zoom, 0.01), dashPattern: [6, 4], hittable: false }));
            }
        },
        [page],
    );

    // 视口缩放变化后，参考线粗细需要跟着换算，重新画一次当前状态。
    useLayoutEffect(() => {
        if (interactionRef.current.mode === "idle") drawGuides([], null);
    }, [viewport, drawGuides]);

    const handleReadyRef = useRef(false);
    useEffect(() => {
        if (handleReadyRef.current || !onReady || !page) return;
        handleReadyRef.current = true;
        onReady({
            fit: () => {
                const state = usePortfolioStore.getState();
                const target = currentPortfolioPage(state);
                if (!target) return;
                const rect = stageRef.current?.getBoundingClientRect();
                if (!rect) return;
                usePortfolioStore.getState().setViewport(fitViewTransform(target.width, target.height, rect.width, rect.height));
            },
        });
    }, [onReady, page]);

    // 首次拿到页面尺寸时自动适配一次，避免打开就看到超出视口的页面。
    const autoFitRef = useRef(false);
    useEffect(() => {
        if (autoFitRef.current || !page || stageSize.width <= 1) return;
        autoFitRef.current = true;
        const rect = stageRef.current?.getBoundingClientRect();
        if (!rect) return;
        usePortfolioStore.getState().setViewport(fitViewTransform(page.width, page.height, rect.width, rect.height));
    }, [page, stageSize]);

    // ---- 空格键切换抓手 ----
    useEffect(() => {
        const down = (event: KeyboardEvent) => {
            if (event.code === "Space" && !isTypingTarget(event.target)) {
                event.preventDefault();
                setSpacePressed(true);
            }
        };
        const up = (event: KeyboardEvent) => {
            if (event.code === "Space") setSpacePressed(false);
        };
        window.addEventListener("keydown", down);
        window.addEventListener("keyup", up);
        return () => {
            window.removeEventListener("keydown", down);
            window.removeEventListener("keyup", up);
        };
    }, []);

    // ---- 滚轮：Ctrl/⌘ 缩放，否则平移 ----
    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            const store = usePortfolioStore.getState();
            const rect = stage.getBoundingClientRect();
            if (event.ctrlKey || event.metaKey) {
                const factor = Math.exp(-event.deltaY * 0.0025);
                store.zoomBy(factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
                return;
            }
            store.setViewport({ panX: store.viewport.panX - event.deltaX, panY: store.viewport.panY - event.deltaY });
        };
        stage.addEventListener("wheel", onWheel, { passive: false });
        return () => stage.removeEventListener("wheel", onWheel);
    }, []);

    const pagePointOf = useCallback((event: { clientX: number; clientY: number }): Point => {
        const rect = stageRef.current?.getBoundingClientRect();
        return screenToPage({ x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }, viewportRef.current);
    }, []);

    const finishInteraction = useCallback(() => {
        const interaction = interactionRef.current;
        if (interaction.mode !== "idle" && "moved" in interaction && interaction.moved) {
            usePortfolioStore.getState().endInteraction();
        }
        interactionRef.current = { mode: "idle" };
        drawGuides([], null);
        setMarquee(null);
    }, [drawGuides]);

    const onStagePointerDown = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            const state = usePortfolioStore.getState();
            const target = currentPortfolioPage(state);
            if (!target) return;
            const point = pagePointOf(event);

            if (event.button === 1 || spacePressed) {
                event.currentTarget.setPointerCapture(event.pointerId);
                interactionRef.current = { mode: "pan", startScreen: { x: event.clientX, y: event.clientY }, startPan: { x: state.viewport.panX, y: state.viewport.panY }, moved: false };
                return;
            }

            const hit = hitTestElements(target.elements, point);
            const additive = event.shiftKey || event.metaKey || event.ctrlKey;

            if (!hit) {
                if (!additive) state.clearSelection();
                state.beginInteraction();
                event.currentTarget.setPointerCapture(event.pointerId);
                interactionRef.current = { mode: "marquee", startPage: point, moved: false };
                return;
            }

            // 点在已选中的元素上时保留整个选区一起拖，这是多选拖动的常见预期。
            if (!state.selectedIds.includes(hit.id)) state.toggleSelection(hit.id, additive);
            const selection = usePortfolioStore.getState().selectedIds;
            const starts = new Map<string, Point>();
            for (const element of target.elements) {
                if (selection.includes(element.id)) starts.set(element.id, { x: element.x, y: element.y });
            }
            const startBounds = unionElementBounds(target.elements.filter((element) => starts.has(element.id)));
            if (!startBounds) return;
            state.beginInteraction();
            event.currentTarget.setPointerCapture(event.pointerId);
            interactionRef.current = { mode: "move", startPage: point, starts, startBounds, moved: false };
        },
        [pagePointOf, spacePressed],
    );

    const onStagePointerMove = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            const interaction = interactionRef.current;
            if (interaction.mode === "idle") return;
            const store = usePortfolioStore.getState();
            const page = currentPortfolioPage(store);
            if (!page) return;
            const point = pagePointOf(event);
            const zoom = viewportRef.current.zoom;

            if (interaction.mode === "pan") {
                const dx = event.clientX - interaction.startScreen.x;
                const dy = event.clientY - interaction.startScreen.y;
                if (Math.abs(dx) > DRAG_THRESHOLD_SCREEN || Math.abs(dy) > DRAG_THRESHOLD_SCREEN) interaction.moved = true;
                store.setViewport({ panX: interaction.startPan.x + dx, panY: interaction.startPan.y + dy });
                return;
            }

            if (interaction.mode === "marquee") {
                const rect = normalizeRect({ x: interaction.startPage.x, y: interaction.startPage.y, width: point.x - interaction.startPage.x, height: point.y - interaction.startPage.y });
                if (rect.width * zoom > DRAG_THRESHOLD_SCREEN || rect.height * zoom > DRAG_THRESHOLD_SCREEN) interaction.moved = true;
                setMarquee(rect);
                store.setSelection(marqueeSelect(page.elements, rect));
                return;
            }

            if (interaction.mode === "move") {
                let dx = point.x - interaction.startPage.x;
                let dy = point.y - interaction.startPage.y;
                if (Math.hypot(dx * zoom, dy * zoom) > DRAG_THRESHOLD_SCREEN) interaction.moved = true;
                let guides: PortfolioSnapGuide[] = [];
                const allUnrotated = page.elements.every((element) => !interaction.starts.has(element.id) || !element.rotation);
                if (store.snapEnabled && interaction.moved && allUnrotated) {
                    const moved: PortfolioRect = { ...interaction.startBounds, x: interaction.startBounds.x + dx, y: interaction.startBounds.y + dy };
                    const targets = page.elements.filter((element) => !interaction.starts.has(element.id)).map(elementBounds);
                    const snap = snapRect(moved, targets, { x: 0, y: 0, width: page.width, height: page.height }, SNAP_THRESHOLD_SCREEN / zoom);
                    guides = snap.guides;
                    dx += snap.x - moved.x;
                    dy += snap.y - moved.y;
                }
                store.applyDocumentLive(
                    applyPatches(store.document!, store.pageIndex, (element) => {
                        const start = interaction.starts.get(element.id);
                        return start ? { x: start.x + dx, y: start.y + dy } : null;
                    }),
                );
                drawGuides(guides, null);
                return;
            }

            if (interaction.mode === "resize") {
                const element = page.elements.find((item) => item.id === interaction.elementId);
                if (!element) return;
                const next = resizeRectFromHandle(interaction.startRect, interaction.rotation, interaction.handle, point, { keepRatio: interaction.keepRatio });
                interaction.moved = true;
                store.applyDocumentLive(applyPatches(store.document!, store.pageIndex, (item) => (item.id === element.id ? next : null)));
                return;
            }

            if (interaction.mode === "rotate") {
                const element = page.elements.find((item) => item.id === interaction.elementId);
                if (!element) return;
                const center = elementCenter(element);
                const raw = rotationFromPointer(center, point, { snap: event.shiftKey });
                const rotation = event.shiftKey ? raw : raw - interaction.pointerOffset;
                interaction.moved = true;
                store.applyDocumentLive(applyPatches(store.document!, store.pageIndex, (item) => (item.id === element.id ? { rotation } : null)));
            }
        },
        [drawGuides, pagePointOf],
    );

    const onStagePointerUp = useCallback(() => finishInteraction(), [finishInteraction]);

    const onStageDoubleClick = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            const state = usePortfolioStore.getState();
            const page = currentPortfolioPage(state);
            if (!page) return;
            const hit = hitTestElements(page.elements, pagePointOf(event));
            if (hit?.kind === "text" && onEditText) onEditText(hit.id);
        },
        [onEditText, pagePointOf],
    );

    const beginHandleResize = useCallback(
        (handle: ResizeHandle) => (event: React.PointerEvent<HTMLDivElement>) => {
            event.stopPropagation();
            const state = usePortfolioStore.getState();
            const element = single;
            if (!element) return;
            state.beginInteraction();
            state.setSelection([element.id]);
            interactionRef.current = {
                mode: "resize",
                elementId: element.id,
                handle,
                startRect: { x: element.x, y: element.y, width: element.width, height: element.height },
                rotation: element.rotation,
                keepRatio: event.shiftKey,
                moved: false,
            };
            // 手柄是 DOM 元素，拖动过程中指针会移出它，统一交给 window 事件收尾。
            const move = (nativeEvent: PointerEvent) => {
                onStagePointerMove(nativeEvent as unknown as React.PointerEvent<HTMLDivElement>);
            };
            const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                finishInteraction();
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
        },
        [finishInteraction, onStagePointerMove, single],
    );

    const beginRotate = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            event.stopPropagation();
            const element = single;
            if (!element) return;
            const state = usePortfolioStore.getState();
            const center = elementCenter(element);
            const startRaw = rotationFromPointer(center, pagePointOf(event), { snap: false });
            state.beginInteraction();
            interactionRef.current = { mode: "rotate", elementId: element.id, startRotation: element.rotation, pointerOffset: startRaw - element.rotation, moved: false };
            const move = (nativeEvent: PointerEvent) => {
                onStagePointerMove(nativeEvent as unknown as React.PointerEvent<HTMLDivElement>);
            };
            const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                finishInteraction();
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
        },
        [finishInteraction, onStagePointerMove, pagePointOf, single],
    );

    const selectionChrome = useMemo(() => {
        if (!page) return null;
        const zoom = viewport.zoom;
        if (single) {
            const center = pageToScreen(elementCenter(single), viewport);
            const width = single.width * zoom;
            const height = single.height * zoom;
            return (
                <div className="pointer-events-none absolute" style={{ left: center.x - width / 2, top: center.y - height / 2, width, height, transform: `rotate(${single.rotation}deg)`, transformOrigin: "center center" }}>
                    <div className="absolute inset-0 border border-sky-500" />
                    {RESIZE_HANDLES.map((handle) => (
                        <div
                            key={handle}
                            role="presentation"
                            onPointerDown={beginHandleResize(handle)}
                            className="pointer-events-auto absolute rounded-[2px] border border-sky-500 bg-white shadow-sm"
                            style={{
                                left: HANDLE_STYLE[handle].left,
                                top: HANDLE_STYLE[handle].top,
                                width: HANDLE_SIZE,
                                height: HANDLE_SIZE,
                                transform: "translate(-50%, -50%)",
                                cursor: rotateHandleCursor(HANDLE_CURSOR[handle], single.rotation),
                            }}
                        />
                    ))}
                    <div
                        role="presentation"
                        onPointerDown={beginRotate}
                        className="pointer-events-auto absolute size-3 rounded-full border border-sky-500 bg-white shadow-sm"
                        style={{ left: "50%", top: -ROTATE_OFFSET, transform: "translate(-50%, -50%)", cursor: "grab" }}
                    />
                    <div className="pointer-events-none absolute" style={{ left: "50%", top: -ROTATE_OFFSET, height: ROTATE_OFFSET, transform: "translateX(-50%)", borderLeft: "1px solid #0ea5e9" }} />
                </div>
            );
        }
        const bounds = unionElementBounds(selected);
        if (!bounds) return null;
        const topLeft = pageToScreen({ x: bounds.x, y: bounds.y }, viewport);
        return <div className="pointer-events-none absolute border border-dashed border-sky-500" style={{ left: topLeft.x, top: topLeft.y, width: bounds.width * zoom, height: bounds.height * zoom }} />;
    }, [beginHandleResize, beginRotate, page, selected, single, viewport]);

    return (
        <div ref={stageRef} className="portfolio-stage" style={{ cursor: spacePressed ? "grab" : undefined }}>
            <div ref={hostRef} className="pointer-events-none absolute inset-0" aria-hidden />
            <div className="absolute inset-0 touch-none" onPointerDown={onStagePointerDown} onPointerMove={onStagePointerMove} onPointerUp={onStagePointerUp} onPointerCancel={onStagePointerUp} onDoubleClick={onStageDoubleClick} role="presentation" />
            {selectionChrome}
            {marquee ? <MarqueeOverlay marquee={marquee} viewport={viewport} /> : null}
        </div>
    );
}

function MarqueeOverlay({ marquee, viewport }: { marquee: PortfolioRect; viewport: ViewTransform }) {
    const rect = normalizeRect(marquee);
    const topLeft = pageToScreen({ x: rect.x, y: rect.y }, viewport);
    return <div className="pointer-events-none absolute border border-sky-400 bg-sky-400/10" style={{ left: topLeft.x, top: topLeft.y, width: rect.width * viewport.zoom, height: rect.height * viewport.zoom }} />;
}

function createScene(host: HTMLDivElement): Scene {
    const leafer = new Leafer({ view: host, width: 1, height: 1, pixelRatio: pixelRatio(), fill: "transparent", hittable: false, smooth: true });
    const world = new Group({ hittable: false });
    const shadow = new Rect({ hittable: false, fill: "rgba(15, 23, 42, 0.16)" });
    const pageRect = new Rect({ hittable: false });
    const content = new Group({ hittable: false });
    const chrome = new Group({ hittable: false });
    world.add(shadow);
    world.add(pageRect);
    world.add(content);
    world.add(chrome);
    leafer.add(world);
    return { leafer, world, shadow, pageRect, content, chrome, nodes: new Map(), order: [] };
}

function createElementNode(element: PortfolioElement): Rect | Text {
    const base = {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        rotation: element.rotation,
        opacity: element.opacity,
        // 显式声明基点：文档模型以左上角定位、围绕中心旋转，两端必须在同一套约定下。
        origin: "top-left" as const,
        around: "center" as const,
        hittable: false,
        zIndex: element.zIndex,
    };
    if (element.kind === "image") {
        return new Rect({ ...base, fill: { type: "image", url: element.src, mode: imageFillMode(element.fit) } });
    }
    return new Text({ ...base, ...textStyleOf(element) });
}

/** leafer 只接受 100 步进的字重，文档里存的是任意数值，这里统一收敛。 */
const FONT_WEIGHT_STEPS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

function normalizeFontWeight(value: number): IFontWeight {
    const snapped = Math.round(Math.min(900, Math.max(100, value)) / 100) * 100;
    return (FONT_WEIGHT_STEPS.find((step) => step === snapped) ?? 400) as IFontWeight;
}

function textStyleOf(element: PortfolioTextElement) {
    return {
        text: element.text,
        fontFamily: element.fontFamily,
        fontSize: element.fontSize,
        fontWeight: normalizeFontWeight(element.fontWeight),
        fill: element.color,
        textAlign: element.align,
        lineHeight: element.lineHeight,
        letterSpacing: element.letterSpacing,
        verticalAlign: "top" as const,
        textWrap: "break" as const,
    };
}

function syncElementNodes(scene: Scene, ordered: readonly PortfolioElement[]) {
    const alive = new Set(ordered.map((element) => element.id));
    for (const [id, node] of scene.nodes) {
        if (alive.has(id)) continue;
        node.remove();
        scene.nodes.delete(id);
    }

    const nextOrder: string[] = [];
    for (const element of ordered) {
        nextOrder.push(element.id);
        let node = scene.nodes.get(element.id);
        const expectedTag = element.kind === "image" ? "Rect" : "Text";
        // 元素类型变了（例如数据被替换）时类型对不上，必须换节点重建。
        if (node && node.__tag !== expectedTag) {
            node.remove();
            scene.nodes.delete(element.id);
            node = undefined;
        }
        if (!node) {
            node = createElementNode(element);
            scene.nodes.set(element.id, node);
            scene.content.add(node);
            continue;
        }
        const shared = {
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
            rotation: element.rotation,
            opacity: element.opacity,
            zIndex: element.zIndex,
        };
        if (element.kind === "image") {
            (node as Rect).set({ ...shared, fill: { type: "image", url: element.src, mode: imageFillMode(element.fit) } });
        } else {
            (node as Text).set({ ...shared, ...textStyleOf(element) });
        }
    }

    // 层级变化只在顺序真的变了时重排，避免每帧都动场景树。
    if (scene.order.join("|") !== nextOrder.join("|")) {
        scene.order = nextOrder;
        for (const id of nextOrder) {
            const node = scene.nodes.get(id);
            if (node) scene.content.add(node);
        }
    }
}

/** 以纯函数方式套用一批元素补丁，保证拖动期间的文档仍然是不可变更新。 */
function applyPatches(document: PortfolioDocument, pageIndex: number, resolve: (element: PortfolioElement) => Partial<PortfolioElement> | null): PortfolioDocument {
    return {
        ...document,
        pages: document.pages.map((page, index) => {
            if (index !== pageIndex) return page;
            return {
                ...page,
                elements: page.elements.map((element) => {
                    const patch = resolve(element);
                    return patch ? ({ ...element, ...patch } as PortfolioElement) : element;
                }),
            };
        }),
    };
}

function isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || target.isContentEditable;
}
