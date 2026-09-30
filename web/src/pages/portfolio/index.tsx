/**
 * 作品集工作台（全屏应用插件页面）。
 *
 * 装配顺序：工具栏 / 左栏（页面·素材·图层）/ 画布 / 右栏属性。页面本身只负责
 * 「文档生命周期 + 快捷键 + 拖拽导入 + Agent 调度」，排版与交互都在下层组件里。
 */

import { App, Button, Dropdown, Input, Modal, Segmented, Spin } from "antd";
import { FilePlus2, FolderOpen, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import "@/lib/plugins/builtin";
import { PortfolioAgentPanel, type PortfolioAgentStep, type PortfolioProposalReviewItem } from "@/components/portfolio/portfolio-agent-panel";
import { PortfolioCanvas, type PortfolioCanvasHandle } from "@/components/portfolio/portfolio-canvas";
import { PortfolioExportMenu } from "@/components/portfolio/portfolio-export-menu";
import { PortfolioInspector } from "@/components/portfolio/portfolio-inspector";
import { PortfolioSidebar } from "@/components/portfolio/portfolio-sidebar";
import { PortfolioToolbar } from "@/components/portfolio/portfolio-toolbar";
import { EmptyState } from "@/components/ui/product/empty-state";
import { PORTFOLIO_AGENT_MAX_IMAGES, runPortfolioAnnotationAgent } from "@/lib/portfolio/agent-run";
import { isPortfolioDocument, PORTFOLIO_MAX_DOC_BYTES, type PortfolioDocument, type PortfolioElementPatch } from "@/lib/portfolio/contracts";
import { createPortfolioDocument as createBlankDocument } from "@/lib/portfolio/document";
import { runPortfolioExport } from "@/lib/portfolio/export";
import { PORTFOLIO_EXPORT_DEFAULT_SCALE, type PortfolioExportTarget } from "@/lib/portfolio/export/types";
import { imageFilesFromDataTransfer, readLocalImage, uploadImageSource, uploadLocalImage } from "@/lib/portfolio/image-import";
import { currentPortfolioPage, isPortfolioDocumentTooLarge, usePortfolioStore } from "@/lib/portfolio/store";
import { PORTFOLIO_STUDIO_PLUGIN_ID, portfolioStudioPlugin } from "@/lib/plugins/builtin/portfolio/portfolio-studio";
import { createPortfolioDocument as createRemoteDocument, getPortfolioDocument, listPortfolioDocuments, savePortfolioDocument, type PortfolioDocumentSummary } from "@/services/api/portfolio";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { usePluginStore } from "@/stores/use-plugin-store";
import "./portfolio.css";

/** 右栏的两个用途：改属性 / 跟 Agent。同一列内切换，不额外挤占画布。 */
type PortfolioRightPane = "properties" | "agent";

export default function PortfolioStudioPage() {
    const navigate = useNavigate();
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const installations = usePluginStore((state) => state.installations);
    const ensurePlugin = usePluginStore((state) => state.ensurePlugin);
    const pluginStates = usePluginStore((state) => state.pluginStates);
    const installation = installations.find((item) => item.manifest.id === PORTFOLIO_STUDIO_PLUGIN_ID);
    // 后端启停状态优先（与全应用其它插件一致），本地安装状态兜底：否则后端已启用、
    // 而本地 store 里首次记录是 enabled:false 时，工作台会被误判成「未启用」。
    const enabled = pluginStates[PORTFOLIO_STUDIO_PLUGIN_ID]?.effectiveEnabled ?? Boolean(installation?.enabled);

    const portfolioDoc = usePortfolioStore((state) => state.document);
    const currentPage = usePortfolioStore(currentPortfolioPage);
    const booting = usePortfolioStore((state) => state.loading);
    const error = usePortfolioStore((state) => state.error);

    const [documents, setDocuments] = useState<PortfolioDocumentSummary[]>([]);
    const [rightPane, setRightPane] = useState<PortfolioRightPane>("properties");
    const [classifying, setClassifying] = useState(false);
    /** Agent 运行期的一句话进度，避免长时间只转圈不给信息。 */
    const [agentStage, setAgentStage] = useState("");
    // 运行过程留在这里、由面板渲染：面板是纯展示组件，换布局不影响运行语义。
    const [agentSteps, setAgentSteps] = useState<PortfolioAgentStep[]>([]);
    const [agentReasoning, setAgentReasoning] = useState("");
    const [agentText, setAgentText] = useState("");
    const [agentFailure, setAgentFailure] = useState("");
    const [reviewItems, setReviewItems] = useState<PortfolioProposalReviewItem[]>([]);
    const [exporting, setExporting] = useState(false);
    const [exportStage, setExportStage] = useState("");
    const [exportScale, setExportScale] = useState<number>(PORTFOLIO_EXPORT_DEFAULT_SCALE);
    /** null 表示跟随目标默认：PNG 不含图注与标签，HTML 含。 */
    const [exportIncludeMeta, setExportIncludeMeta] = useState<boolean | null>(null);
    const [editingTextId, setEditingTextId] = useState<string | null>(null);
    const [textDraft, setTextDraft] = useState("");
    const [dragging, setDragging] = useState(false);
    const canvasHandleRef = useRef<PortfolioCanvasHandle | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        ensurePlugin(portfolioStudioPlugin.manifest);
    }, [ensurePlugin]);

    // 离开工作台就取消在跑的 Agent：结果只会落在这一页的确认弹窗里，用户走了就看不到了，
    // 让它继续跑只是白烧额度。
    useEffect(() => () => abortRef.current?.abort(), []);

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

    // ---- Agent 分类配文（走影策内置云 Agent）----
    //
    // 三个前置条件缺一不可，顺序也不能换：
    //   1. 图片必须是账号资源——内置 Agent 的看图工具只认资源 ID，内嵌 data URL 递不过去；
    //   2. 文档必须已经落库——Agent 读的是服务端那份文档，不是本地草稿；
    //   3. 补传图片会弄脏文档，所以"补传"必须在"保存"之前，否则 Agent 读到的是没有
    //      assetId 的旧快照，看图会整批失败。
    const runAgent = useCallback(
        async (instruction?: string) => {
            const store = usePortfolioStore.getState();
            const page = currentPortfolioPage(store);
            if (!page) return;
            const images = page.elements.filter((element) => element.kind === "image").slice(0, PORTFOLIO_AGENT_MAX_IMAGES);
            if (images.length === 0) {
                void message.info("当前页还没有图片可以分析");
                return;
            }
            setClassifying(true);
            setAgentStage("正在准备图片…");
            // 新一轮从零开始：上一轮的过程文本留在面板里，会让人分不清哪句是这一次的。
            setAgentSteps([]);
            setAgentReasoning("");
            setAgentText("");
            setAgentFailure("");
            abortRef.current?.abort();
            const controller = new AbortController();
            abortRef.current = controller;
            try {
                const uploading = images.filter((element) => element.kind === "image" && !element.assetId.trim());
                if (uploading.length > 0) {
                    setAgentStage("正在上传图片到账号资源…");
                    const failures = await Promise.all(
                        uploading.map(async (element) => {
                            if (element.kind !== "image") return 0;
                            const uploaded = await uploadImageSource(element.src, { width: element.naturalWidth, height: element.naturalHeight });
                            if (uploaded) usePortfolioStore.getState().updateElement(element.id, uploaded);
                            return uploaded ? 0 : 1;
                        }),
                    );
                    const failed = failures.reduce<number>((total, value) => total + value, 0);
                    if (failed > 0) void message.warning(`有 ${failed} 张图片没能存进账号资源，Agent 看不到它们的画面`);
                }
                if (controller.signal.aborted) return;

                setAgentStage("正在保存作品集…");
                const latest = usePortfolioStore.getState();
                if (!latest.remoteId || latest.dirty) await save();
                const documentId = usePortfolioStore.getState().remoteId;
                if (!documentId) {
                    void message.error("作品集还没保存到服务端，Agent 读不到内容；请先确认后端可用后重试");
                    return;
                }

                // 以落库后的文档为准重新取目标：补传成功的图片此时才有 assetId。
                const readyPage = currentPortfolioPage(usePortfolioStore.getState());
                if (!readyPage) return;
                const targets = readyPage.elements.filter((element) => element.kind === "image" && element.assetId.trim() !== "").slice(0, PORTFOLIO_AGENT_MAX_IMAGES);
                if (targets.length === 0) {
                    void message.error("这些图片还不是账号资源，Agent 无法查看画面；请重新导入后再试");
                    return;
                }

                setAgentStage("Agent 正在分析当前页图片…");
                const result = await runPortfolioAnnotationAgent({
                    documentId,
                    pageId: readyPage.id,
                    pageName: readyPage.name,
                    images: targets.map((element) => ({ id: element.id, caption: element.kind === "image" ? element.caption : "", tags: element.kind === "image" ? element.tags : [] })),
                    config,
                    model: config.textModel || config.model,
                    prompt: instruction,
                    onProgress: (progress) => setAgentStage(progress.stage),
                    onEvent: (event) => {
                        if (controller.signal.aborted) return;
                        switch (event.kind) {
                            case "reasoning":
                                setAgentReasoning(event.text);
                                break;
                            case "assistant":
                                setAgentText(event.text);
                                break;
                            case "tool":
                                setAgentSteps((current) => [...current, { toolName: event.toolName, label: event.label, ok: event.ok }]);
                                break;
                            default:
                                break;
                        }
                    },
                    signal: controller.signal,
                });
                if (controller.signal.aborted) return;

                // 建议只对"仍然存在"的图片生效：运行期间用户可能删过元素或换了页。
                const currentPageAfterRun = currentPortfolioPage(usePortfolioStore.getState());
                const reviewed: PortfolioProposalReviewItem[] = [];
                const seen = new Set<string>();
                for (const proposal of result.proposals) {
                    if (seen.has(proposal.elementId)) continue;
                    const element = currentPageAfterRun?.elements.find((item) => item.id === proposal.elementId);
                    if (!element || element.kind !== "image") continue;
                    seen.add(proposal.elementId);
                    reviewed.push({
                        elementId: element.id,
                        caption: proposal.caption || element.caption,
                        tags: proposal.tags,
                        previousCaption: element.caption,
                        previousTags: element.tags,
                        previewSrc: element.src,
                        accepted: true,
                    });
                }
                if (reviewed.length > 0) {
                    setReviewItems(reviewed);
                    return;
                }
                if (result.status === "failed" || result.status === "cancelled") {
                    setAgentFailure(result.failureMessage || "Agent 运行没有完成");
                    return;
                }
                // 成功但没有建议：正文里通常已经解释了原因，只有连正文都没有时才补一句。
                if (!result.summary.trim()) setAgentFailure("Agent 没有给出可用的分类结果");
            } catch (reason) {
                if (controller.signal.aborted) return;
                setAgentFailure(reason instanceof Error ? reason.message : "Agent 分析失败");
            } finally {
                setClassifying(false);
                setAgentStage("");
            }
        },
        [config, message, save],
    );

    const toggleReviewItem = useCallback((elementId: string, accepted: boolean) => {
        setReviewItems((current) => current.map((item) => (item.elementId === elementId ? { ...item, accepted } : item)));
    }, []);

    /** 提议制落地：只有用户勾过的条目才写进文档，且一次性提交，撤销回到分析前。 */
    const applyReviewedProposals = useCallback(() => {
        const store = usePortfolioStore.getState();
        const page = currentPortfolioPage(store);
        const patches = new Map<string, PortfolioElementPatch>();
        for (const item of reviewItems) {
            if (!item.accepted) continue;
            const element = page?.elements.find((candidate) => candidate.id === item.elementId);
            if (!element || element.kind !== "image") continue;
            patches.set(item.elementId, { caption: item.caption || element.caption, tags: Array.from(new Set([...element.tags, ...item.tags])) });
        }
        setReviewItems([]);
        if (patches.size === 0) {
            void message.info("没有选中任何建议");
            return;
        }
        store.applyElementPatches(patches);
        void message.success(`已写入 ${patches.size} 张图片的分类与图注`);
    }, [message, reviewItems]);

    const classifyDisabled = !currentPage || currentPage.elements.every((element) => element.kind !== "image");

    // ---- 导出 ----
    const runExport = useCallback(
        async (target: PortfolioExportTarget) => {
            const store = usePortfolioStore.getState();
            const doc = store.document;
            if (!doc) return;
            if (isPortfolioDocumentTooLarge(doc)) {
                void message.error(`文档已超过 ${Math.round(PORTFOLIO_MAX_DOC_BYTES / 1024 / 1024)}MB 上限，请先精简内嵌图片再导出`);
                return;
            }
            setExporting(true);
            setExportStage("正在准备导出");
            try {
                const outcome = await runPortfolioExport(
                    {
                        target,
                        document: doc,
                        page: currentPortfolioPage(store),
                        options: {
                            scale: exportScale,
                            ...(exportIncludeMeta === null ? {} : { includeCaptions: exportIncludeMeta, includeTags: exportIncludeMeta }),
                        },
                    },
                    { onProgress: (progress) => setExportStage(progress.label) },
                );
                // 个别图片读不到不影响交付，但要明确告诉用户少了几张，而不是让他在成品里自己找。
                if (outcome.failures.length > 0) void message.warning(outcome.note);
                else void message.success(outcome.note);
            } catch (reason) {
                void message.error(reason instanceof Error ? reason.message : "导出失败");
            } finally {
                setExporting(false);
                setExportStage("");
            }
        },
        [exportIncludeMeta, exportScale, message],
    );

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
                onClassify={() => {
                    // 顶栏按钮是快捷入口：切到 Agent 栏并按当前要求立刻跑一轮。
                    setRightPane("agent");
                    void runAgent();
                }}
                onFit={() => canvasHandleRef.current?.fit()}
                classifyDisabled={classifyDisabled}
                classifying={classifying}
                documentSwitcher={switcher}
                exportMenu={
                    <PortfolioExportMenu
                        disabled={!portfolioDoc}
                        busy={exporting}
                        scale={exportScale}
                        includeMeta={exportIncludeMeta}
                        onScaleChange={setExportScale}
                        onIncludeMetaChange={setExportIncludeMeta}
                        onExport={(target) => void runExport(target)}
                    />
                }
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
                        {exporting || classifying ? (
                            <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-background/95 px-3 py-1.5 text-[var(--fs-micro)] shadow-sm">
                                <Loader2 className="size-3.5 animate-spin" />
                                {exporting ? exportStage || "正在导出…" : agentStage || "Agent 正在分析当前页图片…"}
                                {classifying ? (
                                    <Button type="link" size="small" className="!h-auto !px-1" onClick={() => abortRef.current?.abort()}>
                                        停止
                                    </Button>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                    <aside className="flex w-80 shrink-0 flex-col border-l border-border/60 bg-background">
                        <div className="flex h-9 shrink-0 items-center border-b border-border/60 px-2">
                            <Segmented
                                size="small"
                                value={rightPane}
                                onChange={(value) => setRightPane(value as PortfolioRightPane)}
                                options={[
                                    { label: "属性", value: "properties" },
                                    { label: "Agent", value: "agent" },
                                ]}
                            />
                        </div>
                        <div className="min-h-0 flex-1 overflow-hidden">
                            {rightPane === "agent" ? (
                                <PortfolioAgentPanel
                                    busy={classifying}
                                    canRun={!classifyDisabled}
                                    stage={agentStage}
                                    reasoning={agentReasoning}
                                    assistantText={agentText}
                                    steps={agentSteps}
                                    failureMessage={agentFailure}
                                    proposals={reviewItems}
                                    imageCount={currentPage ? currentPage.elements.filter((element) => element.kind === "image").length : 0}
                                    onRun={(instruction) => void runAgent(instruction)}
                                    onStop={() => abortRef.current?.abort()}
                                    onToggleProposal={toggleReviewItem}
                                    onApplyProposals={applyReviewedProposals}
                                    onDiscardProposals={() => setReviewItems([])}
                                />
                            ) : (
                                <PortfolioInspector />
                            )}
                        </div>
                    </aside>
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
