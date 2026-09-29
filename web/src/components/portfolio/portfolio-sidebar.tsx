/**
 * 作品集左栏：页面列表、图片导入、图层列表。
 *
 * 三块都只读写 store；导入时先把本地文件转成 data URL 立即上画布，再异步上传到宿主
 * 资源存储并回写引用，这样"拖进来立刻能看到"，同时文档最终只保留资源引用而非二进制。
 */

import { App, Button, Input, Segmented, Spin, Tooltip } from "antd";
import { Copy, FileImage, Image as ImageIcon, ImagePlus, Layers, Lock, Plus, Trash2, Unlock, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { EmptyState } from "@/components/ui/product/empty-state";
import type { PortfolioElement, PortfolioPage } from "@/lib/portfolio/contracts";
import { elementBounds } from "@/lib/portfolio/geometry";
import { readLocalImage, uploadLocalImage } from "@/lib/portfolio/image-import";
import { usePortfolioStore } from "@/lib/portfolio/store";
import { resolveImageUrl } from "@/services/image-storage";
import { useAssetStore, type ImageAsset } from "@/stores/use-asset-store";

type PanelSection = "pages" | "media" | "layers";

export function PortfolioSidebar() {
    const [section, setSection] = useState<PanelSection>("pages");
    const page = usePortfolioStore((state) => state.document?.pages[state.pageIndex] ?? null);
    const pages = usePortfolioStore((state) => state.document?.pages);

    return (
        <aside className="flex w-72 shrink-0 flex-col border-r border-border/60 bg-background">
            <div className="border-b border-border/60 p-2">
                <Segmented
                    block
                    size="small"
                    value={section}
                    onChange={(value) => setSection(value as PanelSection)}
                    options={[
                        { label: "页面", value: "pages" },
                        { label: "素材", value: "media" },
                        { label: "图层", value: "layers" },
                    ]}
                />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar p-2">
                {section === "pages" ? <PageSection pages={pages ?? []} activeId={page?.id ?? ""} /> : null}
                {section === "media" ? <MediaSection /> : null}
                {section === "layers" ? <LayerSection /> : null}
            </div>
        </aside>
    );
}

function PageSection({ pages, activeId }: { pages: readonly PortfolioPage[]; activeId: string }) {
    const setPageIndex = usePortfolioStore((state) => state.setPageIndex);
    const addPage = usePortfolioStore((state) => state.addPage);
    const duplicatePage = usePortfolioStore((state) => state.duplicatePage);
    const removePage = usePortfolioStore((state) => state.removePage);
    const movePage = usePortfolioStore((state) => state.movePage);
    const selectedCount = usePortfolioStore((state) => state.selectedIds.length);

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-[var(--fs-micro)] font-medium text-foreground/60">共 {pages.length} 页</span>
                <Button size="small" type="text" icon={<Plus className="size-4" />} onClick={addPage}>
                    新增页
                </Button>
            </div>
            <div className="space-y-2">
                {pages.map((page, index) => {
                    const active = page.id === activeId;
                    return (
                        <div key={page.id} className={`rounded-[var(--r-md)] border p-1.5 transition ${active ? "border-sky-500 bg-sky-500/5" : "border-border/60 hover:border-border"}`}>
                            <button type="button" className="block w-full cursor-pointer" onClick={() => setPageIndex(index)} aria-label={`切换到第 ${index + 1} 页`}>
                                <PageThumbnail page={page} />
                            </button>
                            <div className="mt-1.5 flex items-center gap-1">
                                <span className="min-w-0 flex-1 truncate text-[var(--fs-micro)] text-foreground/70">
                                    {index + 1}. {page.name}
                                </span>
                                <Tooltip title="上移">
                                    <Button type="text" size="small" disabled={index === 0} onClick={() => movePage(index, index - 1)} aria-label="页上移">
                                        ↑
                                    </Button>
                                </Tooltip>
                                <Tooltip title="下移">
                                    <Button type="text" size="small" disabled={index === pages.length - 1} onClick={() => movePage(index, index + 1)} aria-label="页下移">
                                        ↓
                                    </Button>
                                </Tooltip>
                                <Tooltip title="复制此页">
                                    <Button type="text" size="small" icon={<Copy className="size-3.5" />} onClick={() => duplicatePage(page.id)} aria-label="复制页" />
                                </Tooltip>
                                <Tooltip title="删除此页">
                                    <Button type="text" size="small" danger disabled={pages.length <= 1} icon={<Trash2 className="size-3.5" />} onClick={() => removePage(page.id)} aria-label="删除页" />
                                </Tooltip>
                            </div>
                        </div>
                    );
                })}
            </div>
            <p className="text-[var(--fs-micro)] text-foreground/45">当前页元素 {selectedCount > 0 ? `已选 ${selectedCount} 个` : "未选择"}</p>
        </div>
    );
}

/** 缩略图按页面等比缩放，元素位置与画布一致，不做旋转以外的额外近似。 */
function PageThumbnail({ page }: { page: PortfolioPage }) {
    const scale = Math.min(150 / page.width, 90 / page.height);
    return (
        <div className="relative mx-auto overflow-hidden rounded-[var(--r-sm)] border border-border/60" style={{ width: page.width * scale, height: page.height * scale, background: page.background }}>
            {page.elements.map((element) => {
                const bounds = elementBounds(element);
                if (element.kind === "text") {
                    return (
                        <span key={element.id} className="absolute block overflow-hidden bg-foreground/25" style={{ left: bounds.x * scale, top: bounds.y * scale, width: Math.max(2, bounds.width * scale), height: Math.max(1, bounds.height * scale) }} />
                    );
                }
                return <img key={element.id} src={element.src} alt="" className="absolute object-cover" style={{ left: bounds.x * scale, top: bounds.y * scale, width: Math.max(2, bounds.width * scale), height: Math.max(2, bounds.height * scale) }} />;
            })}
        </div>
    );
}

function MediaSection() {
    const { message } = App.useApp();
    const inputRef = useRef<HTMLInputElement>(null);
    const addImage = usePortfolioStore((state) => state.addImage);
    const updateElement = usePortfolioStore((state) => state.updateElement);
    const assets = useAssetStore((state) => state.assets);
    const [uploading, setUploading] = useState(0);

    const imageAssets = useMemo(() => assets.filter((asset): asset is ImageAsset => asset.kind === "image").slice(0, 60), [assets]);

    const insertLocalFiles = async (files: FileList | null) => {
        if (!files || files.length === 0) return;
        for (const file of Array.from(files)) {
            if (!file.type.startsWith("image/")) continue;
            setUploading((count) => count + 1);
            const image = await readLocalImage(file);
            if (!image) {
                setUploading((count) => Math.max(0, count - 1));
                continue;
            }
            const elementId = addImage({ src: image.dataUrl, naturalWidth: image.width, naturalHeight: image.height });
            // 上传失败不影响编辑：文档里仍保留可用的 data URL，只是体积更大。
            void uploadLocalImage(file, image)
                .then((uploaded) => {
                    if (elementId && uploaded) updateElement(elementId, uploaded);
                    else if (!uploaded) void message.warning(`${file.name} 上传失败，已改用本地内嵌方式保存`);
                })
                .finally(() => setUploading((count) => Math.max(0, count - 1)));
        }
    };

    const insertAsset = async (asset: ImageAsset) => {
        const url = (await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl)) || asset.data.dataUrl;
        addImage({ src: url, assetId: asset.data.storageKey, naturalWidth: asset.data.width, naturalHeight: asset.data.height });
    };

    return (
        <div className="space-y-3">
            <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(event) => void insertLocalFiles(event.target.files)} />
            <Button block type="primary" icon={<ImagePlus className="size-4" />} onClick={() => inputRef.current?.click()}>
                导入本地图片
            </Button>
            {uploading > 0 ? (
                <p className="flex items-center gap-1.5 text-[var(--fs-micro)] text-foreground/60">
                    <Spin size="small" /> 正在上传 {uploading} 张图，可继续编辑
                </p>
            ) : null}

            <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-[var(--fs-micro)] font-medium text-foreground/60">
                    <FileImage className="size-3.5" /> 来自素材库（{imageAssets.length}）
                </p>
                {imageAssets.length === 0 ? (
                    <EmptyState size="compact" icon={ImageIcon} title="素材库里还没有图片" description="先在创作页生成或上传图片，就能直接引用。" />
                ) : (
                    <div className="grid grid-cols-3 gap-1.5">
                        {imageAssets.map((asset) => (
                            <button key={asset.id} type="button" className="cursor-pointer overflow-hidden rounded-[var(--r-sm)] border border-border/60 hover:border-sky-500" onClick={() => void insertAsset(asset)} title={asset.title}>
                                <img src={asset.coverUrl || asset.data.dataUrl} alt={asset.title} className="aspect-square w-full object-cover" />
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <p className="text-[var(--fs-micro)] text-foreground/45">
                <Upload className="mr-1 inline size-3" />
                也支持把图片直接拖进画布
            </p>
        </div>
    );
}

const ELEMENT_LABEL: Record<PortfolioElement["kind"], string> = { image: "图片", text: "文字" };

function LayerSection() {
    const page = usePortfolioStore((state) => state.document?.pages[state.pageIndex] ?? null);
    const selectedIds = usePortfolioStore((state) => state.selectedIds);
    const toggleSelection = usePortfolioStore((state) => state.toggleSelection);
    const updateElement = usePortfolioStore((state) => state.updateElement);
    const renamePage = usePortfolioStore((state) => state.updatePage);
    const [pageNameDraft, setPageNameDraft] = useState("");

    if (!page) return null;
    const ordered = [...page.elements].sort((a, b) => b.zIndex - a.zIndex);
    const currentName = pageNameDraft || page.name;

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-1.5">
                <span className="shrink-0 text-[var(--fs-micro)] text-foreground/60">页面名</span>
                <Input
                    size="small"
                    value={currentName}
                    onChange={(event) => setPageNameDraft(event.target.value)}
                    onBlur={() => {
                        if (pageNameDraft.trim()) renamePage(page.id, { name: pageNameDraft.trim() });
                        setPageNameDraft("");
                    }}
                    maxLength={40}
                />
            </div>
            <p className="flex items-center gap-1.5 text-[var(--fs-micro)] font-medium text-foreground/60">
                <Layers className="size-3.5" /> 图层（上层在前，共 {ordered.length}）
            </p>
            {ordered.length === 0 ? (
                <EmptyState size="compact" icon={Layers} title="当前页还没有元素" description="导入图片或添加文字后会出现在这里。" />
            ) : (
                <ul className="space-y-1">
                    {ordered.map((element) => {
                        const active = selectedIds.includes(element.id);
                        return (
                            <li key={element.id}>
                                <div
                                    className={`flex cursor-pointer items-center gap-1.5 rounded-[var(--r-sm)] border px-1.5 py-1 text-[var(--fs-micro)] ${active ? "border-sky-500 bg-sky-500/5" : "border-transparent hover:bg-muted/40"}`}
                                    onClick={(event) => toggleSelection(element.id, event.shiftKey || event.metaKey || event.ctrlKey)}
                                >
                                    {element.kind === "image" ? <ImageIcon className="size-3.5 shrink-0 text-foreground/50" /> : <span className="shrink-0 text-foreground/50">T</span>}
                                    <span className="min-w-0 flex-1 truncate">{element.kind === "image" ? element.caption || `图片 ${element.id.slice(-4)}` : element.text.slice(0, 18) || "文字"}</span>
                                    <Tooltip title={element.locked ? "解锁" : "锁定"}>
                                        <button
                                            type="button"
                                            className="cursor-pointer text-foreground/50 hover:text-foreground"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                updateElement(element.id, { locked: !element.locked });
                                            }}
                                            aria-label="切换锁定"
                                        >
                                            {element.locked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
                                        </button>
                                    </Tooltip>
                                    <span className="shrink-0 text-foreground/35">{ELEMENT_LABEL[element.kind]}</span>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
