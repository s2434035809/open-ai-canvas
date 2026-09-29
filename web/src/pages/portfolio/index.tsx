/**
 * 作品集工作台（全屏应用插件页面）。
 *
 * 装配顺序：工具栏 / 左栏（页面·素材·图层）/ 画布 / 右栏属性。页面本身只负责
 * 「文档生命周期 + 快捷键 + 拖拽导入 + Agent 调度」，排版与交互都在下层组件里。
 */

import { App, Button, Dropdown, Input, Modal, Spin } from "antd";
import { FilePlus2, FolderOpen, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import "@/lib/plugins/builtin";
import { PortfolioCanvas, type PortfolioCanvasHandle } from "@/components/portfolio/portfolio-canvas";
import { PortfolioInspector } from "@/components/portfolio/portfolio-inspector";
import { PortfolioSidebar } from "@/components/portfolio/portfolio-sidebar";
import { PortfolioToolbar } from "@/components/portfolio/portfolio-toolbar";
import { EmptyState } from "@/components/ui/product/empty-state";
import { createPortfolioAgent } from "@/lib/portfolio/agent";
import { isPortfolioDocument, PORTFOLIO_MAX_DOC_BYTES, type PortfolioDocument, type PortfolioElementPatch } from "@/lib/portfolio/contracts";
import { createPortfolioDocument as createBlankDocument } from "@/lib/portfolio/document";
import { imageFilesFromDataTransfer, readLocalImage, uploadLocalImage } from "@/lib/portfolio/image-import";
import { currentPortfolioPage, isPortfolioDocumentTooLarge, usePortfolioStore } from "@/lib/portfolio/store";
import { PORTFOLIO_STUDIO_PLUGIN_ID, portfolioStudioPlugin } from "@/lib/plugins/builtin/portfolio/portfolio-studio";
import { createPortfolioDocument as createRemoteDocument, getPortfolioDocument, listPortfolioDocuments, savePortfolioDocument, type PortfolioDocumentSummary } from "@/services/api/portfolio";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { usePluginStore } from "@/stores/use-plugin-store";
import "./portfolio.css";

/** 单次交给模型的图片上限：再多会让请求体积与耗时都失控。 */
const CLASSIFY_BATCH_SIZE = 8;

export default function PortfolioStudioPage() {
    const navigate = useNavigate();
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const installations = usePluginStore((state) => state.installations);
    const ensurePlugin = usePluginStore((state) => state.ensurePlugin);
    const installation = installations.find((item) => item.manifest.id === PORTFOLIO_STUDIO_PLUGIN_ID);
    const enabled = Boolean(installation?.enabled);

    const portfolioDoc = usePortfolioStore((state) => state.document);
    const currentPage = usePortfolioStore(currentPortfolioPage);
    const booting = usePortfolioStore((state) => state.loading);
    const error = usePortfolioStore((state) => state.error);

    const [documents, setDocuments] = useState<PortfolioDocumentSummary[]>([]);
    const [classifying, setClassifying] = useState(false);
    const [editingTextId, setEditingTextId] = useState<string | null>(null);
    const [textDraft, setTextDraft] = useState("");
    const [dragging, setDragging] = useState(false);
    const canvasHandleRef = useRef<PortfolioCanvasHandle | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        ensurePlugin(portfolioStudioPlugin.manifest);
    }, [ensurePlugin]);

    const openDocument = useCallback(
        async (id: string) => {
            const store = usePortfolioStore.getState();
            store.setLoading(true);
            try {
                const view = await getPortfolioDocument(id);
                if (!isPortfolioDocument(view.doc)) throw new Error("文档结构无法识别");
                store.loadDocument(view.doc, { remoteId: view.id, revision: view.revision });
            } catch (reason) {
                store.setError(reason instanceof Error ? reason.message : "打开作品集失败");
                void message.error("打开作品集失败，请稍后重试");
            }
        },
        [message],
    );

    const startNewDocument = useCallback(() => {
        usePortfolioStore.getState().loadDocument(createBlankDocument("未命名作品集"));
        canvasHandleRef.current?.fit();
    }, []);

    // 首次进入：能打开最近的文档就打开，否则给一张空白草稿；后端不可用时降级为本地草稿。
    useEffect(() => {
        let cancelled = false;
        const store = usePortfolioStore.getState();
        store.setLoading(true);
        void (async () => {
            try {
                const data = await listPortfolioDocuments();
                if (cancelled) return;
                setDocuments(data.items);
                if (data.items.length > 0) await openDocument(data.items[0].id);
                else usePortfolioStore.getState().loadDocument(createBlankDocument());
            } catch {
                if (cancelled) return;
                usePortfolioStore.getState().loadDocument(createBlankDocument());
                void message.warning("未能连接后端，已切换为本地草稿模式，保存功能暂不可用");
            } finally {
                if (!cancelled) usePortfolioStore.setState({ loading: false });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [message, openDocument]);

    const refreshDocuments = useCallback(async () => {
        try {
            const data = await listPortfolioDocuments();
            setDocuments(data.items);
        } catch {
            // 列表刷新失败不影响当前编辑，静默处理。
        }
    }, []);

    const save = useCallback(async () => {
        const store = usePortfolioStore.getState();
        const doc = store.document;
        if (!doc) return;
        if (isPortfolioDocumentTooLarge(doc)) {
            void message.error(`文档已超过 ${Math.round(PORTFOLIO_MAX_DOC_BYTES / 1024 / 1024)}MB 上限，请减少内嵌图片或改用素材库图片`);
            return;
        }
        usePortfolioStore.setState({ saving: true, error: "" });
        const coverUrl = doc.coverUrl || firstImageSource(doc);
        const payload = { title: doc.title, description: doc.description, coverUrl, pageCount: doc.pages.length, doc };
        try {
            const view = store.remoteId ? await savePortfolioDocument(store.remoteId, payload) : await createRemoteDocument(payload);
            usePortfolioStore.getState().markSaved({ remoteId: view.id, revision: view.revision });
            void message.success("已保存到作品集列表");
            await refreshDocuments();
        } catch (reason) {
            const text = reason instanceof Error ? reason.message : "保存失败";
            usePortfolioStore.setState({ saving: false, error: text });
            void message.error(`保存失败：${text}`);
        }
    }, [message, refreshDocuments]);

    // ---- 拖拽导入 ----
    const importFiles = useCallback(
        async (files: File[]) => {
            const store = usePortfolioStore.getState();
            for (const file of files) {
                const image = await readLocalImage(file);
                if (!image) continue;
                const elementId = store.addImage({ src: image.dataUrl, naturalWidth: image.width, naturalHeight: image.height });
                void uploadLocalImage(file, image).then((uploaded) => {
                    if (!elementId) return;
                    if (uploaded) usePortfolioStore.getState().updateElement(elementId, uploaded);
                });
            }
            if (files.length > 0) void message.success(`已导入 ${files.length} 张图片`);
        },
        [message],
    );

    const onDrop = useCallback(
        (event: React.DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            setDragging(false);
            const files = imageFilesFromDataTransfer(event.dataTransfer);
            if (files.length === 0) return;
            void importFiles(files);
        },
        [importFiles],
    );

    // ---- Agent 分类配文 ----
    const classify = useCallback(async () => {
        if (!installation) return;
        const store = usePortfolioStore.getState();
        const page = currentPortfolioPage(store);
        if (!page) return;
        const images = page.elements.filter((element) => element.kind === "image").slice(0, CLASSIFY_BATCH_SIZE);
        if (images.length === 0) {
            void message.info("当前页还没有图片可以分析");
            return;
        }
        setClassifying(true);
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const agent = createPortfolioAgent(portfolioStudioPlugin, installation, config);
            const suggestions = await agent.classify(
                images.map((element) => ({ id: element.id, url: element.src })),
                controller.signal,
            );
            if (suggestions.length === 0) {
                void message.warning("模型没有返回可用的分类结果");
                return;
            }
            // 汇总成一次补丁写入，撤销时一步回到分析前。
            const patches = new Map<string, PortfolioElementPatch>();
            const latest = usePortfolioStore.getState();
            const latestPage = currentPortfolioPage(latest);
            for (const suggestion of suggestions) {
                const element = latestPage?.elements.find((item) => item.id === suggestion.id);
                if (!element || element.kind !== "image") continue;
                const tags = Array.from(new Set([...element.tags, ...suggestion.tags]));
                patches.set(suggestion.id, { caption: suggestion.caption || element.caption, tags });
            }
            if (patches.size > 0) {
                latest.applyElementPatches(patches);
                void message.success(`已为 ${patches.size} 张图片补充分类与图注`);
            }
        } catch (reason) {
            if (controller.signal.aborted) return;
            void message.error(reason instanceof Error ? reason.message : "Agent 分析失败");
        } finally {
            setClassifying(false);
        }
    }, [config, installation, message]);

    const classifyDisabled = !currentPage || currentPage.elements.every((element) => element.kind !== "image");

    // ---- 文字编辑 ----
    const editingElement = usePortfolioStore((state) => {
        if (!editingTextId) return null;
        const page = currentPortfolioPage(state);
        const element = page?.elements.find((item) => item.id === editingTextId);
        return element && element.kind === "text" ? element : null;
    });
    const editingOpen = Boolean(editingTextId && editingElement);
    const closeTextEditor = useCallback(() => setEditingTextId(null), []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (isTypingTarget(event.target)) return;
            const store = usePortfolioStore.getState();
            const meta = event.metaKey || event.ctrlKey;
            if (meta && event.key.toLowerCase() === "z") {
                event.preventDefault();
                if (event.shiftKey) store.redo();
                else store.undo();
                return;
            }
            if (meta && event.key.toLowerCase() === "a") {
                event.preventDefault();
                store.selectAll();
                return;
            }
            if (meta && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void save();
                return;
            }
            if (event.key === "Delete" || event.key === "Backspace") {
                if (store.selectedIds.length === 0) return;
                event.preventDefault();
                store.removeSelected();
                return;
            }
            if (event.key === "Escape") {
                store.clearSelection();
                return;
            }
            const step = event.shiftKey ? 10 : 1;
            const nudge: Record<string, { x: number; y: number }> = {
                ArrowLeft: { x: -step, y: 0 },
                ArrowRight: { x: step, y: 0 },
                ArrowUp: { x: 0, y: -step },
                ArrowDown: { x: 0, y: step },
            };
            const delta = nudge[event.key];
            if (!delta || store.selectedIds.length === 0) return;
            event.preventDefault();
            const page = currentPortfolioPage(store);
            if (!page) return;
            const patches = new Map<string, PortfolioElementPatch>();
            for (const element of page.elements) {
                if (!store.selectedIds.includes(element.id) || element.locked) continue;
                patches.set(element.id, { x: element.x + delta.x, y: element.y + delta.y });
            }
            store.applyElementPatches(patches);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [save]);

    if (!enabled && !booting) {
        return (
            <main className="flex h-full items-center justify-center bg-background">
                <EmptyState
                    icon={Sparkles}
                    title="作品集工作台未启用"
                    description="在插件中心启用后，即可导入图片、编排版式并交给 Agent 分类配文。"
                    action={
                        <Button type="primary" onClick={() => navigate("/plugins")}>
                            去插件中心启用
                        </Button>
                    }
                />
            </main>
        );
    }

    const switcher = (
        <Dropdown
            menu={{
                items: [
                    { key: "__new__", icon: <FilePlus2 className="size-4" />, label: "新建作品集" },
                    { type: "divider" as const },
                    ...documents.map((item) => ({ key: item.id, icon: <FolderOpen className="size-4" />, label: `${item.title}（${item.pageCount} 页）` })),
                ],
                onClick: ({ key }) => {
                    if (key === "__new__") startNewDocument();
                    else void openDocument(key);
                },
            }}
            trigger={["click"]}
        >
            <Button type="text" size="small" icon={<FolderOpen className="size-4" />}>
                文档
            </Button>
        </Dropdown>
    );

    return (
        <main className="flex h-full min-h-0 flex-col bg-muted/20">
            <PortfolioToolbar
                onBack={() => navigate("/plugins")}
                onSave={() => void save()}
                onClassify={() => void classify()}
                onFit={() => canvasHandleRef.current?.fit()}
                classifyDisabled={classifyDisabled}
                classifying={classifying}
                documentSwitcher={switcher}
            />
            {error ? <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[var(--fs-micro)] text-destructive">{error}</div> : null}
            {booting && !portfolioDoc ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-foreground/60">
                    <Spin />
                    <span className="text-[var(--fs-micro)]">正在打开作品集</span>
                </div>
            ) : (
                <div
                    className="flex min-h-0 flex-1"
                    onDragOver={(event) => {
                        event.preventDefault();
                        setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={onDrop}
                >
                    <PortfolioSidebar />
                    <div className="relative min-w-0 flex-1">
                        <PortfolioCanvas
                            onReady={(handle) => {
                                canvasHandleRef.current = handle;
                            }}
                            onEditText={(elementId) => {
                                const store = usePortfolioStore.getState();
                                const page = currentPortfolioPage(store);
                                const element = page?.elements.find((item) => item.id === elementId);
                                if (element?.kind !== "text") return;
                                store.setSelection([elementId]);
                                setTextDraft(element.text);
                                setEditingTextId(elementId);
                            }}
                        />
                        {dragging ? (
                            <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-[var(--r-lg)] border-2 border-dashed border-sky-500 bg-sky-500/10 text-[var(--fs-body)] text-sky-700">
                                松开即可把图片加入当前页
                            </div>
                        ) : null}
                        {classifying ? (
                            <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-background/95 px-3 py-1.5 text-[var(--fs-micro)] shadow-sm">
                                <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
                                Agent 正在分析当前页图片…
                            </div>
                        ) : null}
                    </div>
                    <PortfolioInspector />
                </div>
            )}

            <Modal
                open={editingOpen}
                title="编辑文字"
                onCancel={closeTextEditor}
                onOk={() => {
                    if (editingTextId) usePortfolioStore.getState().updateElement(editingTextId, { text: textDraft });
                    closeTextEditor();
                }}
                okText="确定"
                cancelText="取消"
                destroyOnHidden
            >
                <Input.TextArea value={textDraft} onChange={(event) => setTextDraft(event.target.value)} autoSize={{ minRows: 6, maxRows: 16 }} placeholder="输入作品集里的标题、说明或图注" />
            </Modal>
        </main>
    );
}

/** 作品集封面：取第一页第一张图片，方便列表里一眼认出是哪个项目。 */
function firstImageSource(doc: PortfolioDocument): string {
    for (const page of doc.pages) {
        const image = page.elements.find((element) => element.kind === "image");
        if (image && image.kind === "image") return image.src;
    }
    return "";
}

function isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || target.isContentEditable;
}
