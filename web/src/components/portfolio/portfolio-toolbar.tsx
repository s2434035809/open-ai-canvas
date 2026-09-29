/**
 * 作品集工作台顶栏：文档操作、撤销重做、视口、对齐与层级。
 *
 * 按钮的可用状态全部来自 store，禁用而不隐藏，避免布局跳动让用户找不到刚用过的按钮。
 */

import { App, Button, Divider, Input, Segmented, Tooltip } from "antd";
import {
    AlignCenterHorizontal,
    AlignCenterVertical,
    AlignEndHorizontal,
    AlignEndVertical,
    AlignStartHorizontal,
    AlignStartVertical,
    ArrowDown,
    ArrowLeft,
    ArrowUp,
    BringToFront,
    Copy,
    LayoutGrid,
    Loader2,
    Magnet,
    Maximize,
    Redo2,
    RotateCw,
    Save,
    SendToBack,
    Sparkles,
    Trash2,
    Undo2,
    ZoomIn,
    ZoomOut,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { PortfolioAlignMode } from "@/lib/portfolio/contracts";
import { PORTFOLIO_MAX_ZOOM, PORTFOLIO_MIN_ZOOM, usePortfolioStore } from "@/lib/portfolio/store";

export type PortfolioToolbarProps = {
    onBack: () => void;
    onSave: () => void;
    onClassify: () => void;
    onFit: () => void;
    classifyDisabled: boolean;
    classifying: boolean;
    /** 文档切换入口由页面注入，避免工具栏直接依赖文档列表的加载状态。 */
    documentSwitcher?: React.ReactNode;
};

const ALIGN_ACTIONS: Array<{ mode: PortfolioAlignMode; label: string; icon: React.ReactNode }> = [
    { mode: "left", label: "左对齐", icon: <AlignStartVertical className="size-4" /> },
    { mode: "center-x", label: "水平居中", icon: <AlignCenterVertical className="size-4" /> },
    { mode: "right", label: "右对齐", icon: <AlignEndVertical className="size-4" /> },
    { mode: "top", label: "顶对齐", icon: <AlignStartHorizontal className="size-4" /> },
    { mode: "center-y", label: "垂直居中", icon: <AlignCenterHorizontal className="size-4" /> },
    { mode: "bottom", label: "底对齐", icon: <AlignEndHorizontal className="size-4" /> },
];

export function PortfolioToolbar({ onBack, onSave, onClassify, onFit, classifyDisabled, classifying, documentSwitcher }: PortfolioToolbarProps) {
    const { message } = App.useApp();
    const title = usePortfolioStore((state) => state.document?.title ?? "");
    const dirty = usePortfolioStore((state) => state.dirty);
    const saving = usePortfolioStore((state) => state.saving);
    const canUndo = usePortfolioStore((state) => state.past.length > 0);
    const canRedo = usePortfolioStore((state) => state.future.length > 0);
    const selectedCount = usePortfolioStore((state) => state.selectedIds.length);
    const snapEnabled = usePortfolioStore((state) => state.snapEnabled);
    const zoom = usePortfolioStore((state) => state.viewport.zoom);
    const setTitle = usePortfolioStore((state) => state.setTitle);
    const undo = usePortfolioStore((state) => state.undo);
    const redo = usePortfolioStore((state) => state.redo);
    const zoomBy = usePortfolioStore((state) => state.zoomBy);
    const setViewport = usePortfolioStore((state) => state.setViewport);
    const toggleSnap = usePortfolioStore((state) => state.toggleSnap);
    const alignSelected = usePortfolioStore((state) => state.alignSelected);
    const arrangeSelected = usePortfolioStore((state) => state.arrangeSelected);
    const reorderSelected = usePortfolioStore((state) => state.reorderSelected);
    const duplicateSelected = usePortfolioStore((state) => state.duplicateSelected);
    const removeSelected = usePortfolioStore((state) => state.removeSelected);

    const [draftTitle, setDraftTitle] = useState(title);
    const [columns, setColumns] = useState<number>(3);
    useEffect(() => setDraftTitle(title), [title]);

    const hasSelection = selectedCount > 0;
    const commitTitle = () => {
        const next = draftTitle.trim();
        if (!next || next === title) {
            setDraftTitle(title);
            return;
        }
        setTitle(next);
    };

    return (
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-3">
            <Tooltip title="返回插件中心">
                <Button type="text" icon={<ArrowLeft className="size-4" />} onClick={onBack} aria-label="返回" />
            </Tooltip>
            {documentSwitcher}
            <Input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} onBlur={commitTitle} onPressEnter={commitTitle} variant="borderless" className="!w-56 font-medium" placeholder="作品集标题" maxLength={80} />
            <span className="text-[var(--fs-micro)] text-foreground/45">{dirty ? "有未保存改动" : "已保存"}</span>

            <Button type="primary" size="small" icon={saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} onClick={onSave} disabled={saving} className="ml-1">
                保存
            </Button>

            <Divider type="vertical" className="mx-1" />
            <Tooltip title="撤销">
                <Button type="text" icon={<Undo2 className="size-4" />} disabled={!canUndo} onClick={undo} aria-label="撤销" />
            </Tooltip>
            <Tooltip title="重做">
                <Button type="text" icon={<Redo2 className="size-4" />} disabled={!canRedo} onClick={redo} aria-label="重做" />
            </Tooltip>

            <Divider type="vertical" className="mx-1" />
            <Tooltip title="缩小">
                <Button type="text" icon={<ZoomOut className="size-4" />} disabled={zoom <= PORTFOLIO_MIN_ZOOM} onClick={() => zoomBy(1 / 1.2)} aria-label="缩小" />
            </Tooltip>
            <button type="button" className="min-w-14 cursor-pointer rounded-[var(--r-sm)] px-1 text-center text-[var(--fs-micro)] tabular-nums text-foreground/70 hover:bg-muted/50" onClick={() => setViewport({ zoom: 1 })} title="恢复 100%">
                {Math.round(zoom * 100)}%
            </button>
            <Tooltip title="放大">
                <Button type="text" icon={<ZoomIn className="size-4" />} disabled={zoom >= PORTFOLIO_MAX_ZOOM} onClick={() => zoomBy(1.2)} aria-label="放大" />
            </Tooltip>
            <Tooltip title="适应窗口">
                <Button type="text" icon={<Maximize className="size-4" />} onClick={onFit} aria-label="适应窗口" />
            </Tooltip>

            <Divider type="vertical" className="mx-1" />
            {ALIGN_ACTIONS.map((action) => (
                <Tooltip key={action.mode} title={action.label}>
                    <Button type="text" icon={action.icon} disabled={!hasSelection} onClick={() => alignSelected(action.mode)} aria-label={action.label} />
                </Tooltip>
            ))}
            <Tooltip title="自动网格排版">
                <Button
                    type="text"
                    icon={<LayoutGrid className="size-4" />}
                    disabled={!hasSelection}
                    onClick={() => {
                        arrangeSelected(columns);
                        void message.success(`已按 ${columns} 列排布 ${selectedCount} 个元素`);
                    }}
                    aria-label="自动排版"
                />
            </Tooltip>
            <Segmented size="small" value={columns} onChange={(value) => setColumns(Number(value))} options={[2, 3, 4, 5].map((value) => ({ label: String(value), value }))} className="ml-1" />

            <Divider type="vertical" className="mx-1" />
            <Tooltip title="置顶">
                <Button type="text" icon={<BringToFront className="size-4" />} disabled={!hasSelection} onClick={() => reorderSelected("front")} aria-label="置顶" />
            </Tooltip>
            <Tooltip title="上移一层">
                <Button type="text" icon={<ArrowUp className="size-4" />} disabled={!hasSelection} onClick={() => reorderSelected("forward")} aria-label="上移一层" />
            </Tooltip>
            <Tooltip title="下移一层">
                <Button type="text" icon={<ArrowDown className="size-4" />} disabled={!hasSelection} onClick={() => reorderSelected("backward")} aria-label="下移一层" />
            </Tooltip>
            <Tooltip title="置底">
                <Button type="text" icon={<SendToBack className="size-4" />} disabled={!hasSelection} onClick={() => reorderSelected("back")} aria-label="置底" />
            </Tooltip>

            <Divider type="vertical" className="mx-1" />
            <Tooltip title="复制选中">
                <Button type="text" icon={<Copy className="size-4" />} disabled={!hasSelection} onClick={duplicateSelected} aria-label="复制" />
            </Tooltip>
            <Tooltip title="删除选中">
                <Button type="text" danger icon={<Trash2 className="size-4" />} disabled={!hasSelection} onClick={removeSelected} aria-label="删除" />
            </Tooltip>

            <div className="ml-auto flex items-center gap-1">
                <Tooltip title={snapEnabled ? "已开启对齐吸附" : "已关闭对齐吸附"}>
                    <Button type="text" icon={<Magnet className="size-4" />} onClick={toggleSnap} className={snapEnabled ? "!text-sky-600" : "!text-foreground/40"} aria-label="对齐吸附" />
                </Tooltip>
                <Tooltip title="按当前缩放重置选中元素的旋转角度">
                    <Button type="text" icon={<RotateCw className="size-4" />} disabled={!hasSelection} onClick={() => usePortfolioStore.getState().updateSelected({ rotation: 0 })} aria-label="重置旋转" />
                </Tooltip>
                <Button size="small" icon={classifying ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} disabled={classifyDisabled || classifying} onClick={onClassify}>
                    Agent 分类配文
                </Button>
            </div>
        </header>
    );
}
