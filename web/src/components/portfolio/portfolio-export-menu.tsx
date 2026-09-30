/**
 * 作品集导出下拉面板。
 *
 * 用 Popover 而不是 Dropdown：面板里不只有菜单项，还有倍率与图注开关这类需要保持
 * 展开状态的控件，交给菜单渲染会把它们当成「点一下就关闭」的选项。
 */

import { Button, Checkbox, Divider, Popover, Segmented } from "antd";
import { Download, FileDown, Image as ImageIcon, Layers, Loader2 } from "lucide-react";
import { useState } from "react";

import { PORTFOLIO_EXPORT_SCALES, type PortfolioExportTarget } from "@/lib/portfolio/export/types";

export type PortfolioExportMenuProps = {
    /** 没有可导出的文档时禁用（禁用而不隐藏，与工具栏其它按钮一致）。 */
    disabled: boolean;
    /** 导出进行中：按钮转圈并阻止重复触发。 */
    busy: boolean;
    scale: number;
    /** null 表示「跟随目标默认」（PNG 不带，HTML 带）。 */
    includeMeta: boolean | null;
    onScaleChange: (scale: number) => void;
    onIncludeMetaChange: (value: boolean) => void;
    onExport: (target: PortfolioExportTarget) => void;
};

const EXPORT_ACTIONS: Array<{ target: PortfolioExportTarget; label: string; hint: string; icon: React.ReactNode }> = [
    { target: "page-png", label: "导出当前页 PNG", hint: "当前这一页的位图，适合贴进聊天或文档", icon: <ImageIcon className="size-4" /> },
    { target: "document-png", label: "导出整册长图 PNG", hint: "多页纵向拼成一张长图，适合提案与社媒", icon: <Layers className="size-4" /> },
    { target: "document-html", label: "导出 HTML（自包含单文件）", hint: "图片已内联，双击即开、可自托管分享", icon: <FileDown className="size-4" /> },
];

export function PortfolioExportMenu({ disabled, busy, scale, includeMeta, onScaleChange, onIncludeMetaChange, onExport }: PortfolioExportMenuProps) {
    const [open, setOpen] = useState(false);

    const run = (target: PortfolioExportTarget) => {
        setOpen(false);
        onExport(target);
    };

    const content = (
        <div className="w-72">
            <div className="flex flex-col gap-0.5">
                {EXPORT_ACTIONS.map((action) => (
                    <button key={action.target} type="button" onClick={() => run(action.target)} className="flex cursor-pointer flex-col items-start gap-0.5 rounded-[var(--r-sm)] px-2 py-1.5 text-left hover:bg-muted/60">
                        <span className="flex items-center gap-2 text-[var(--fs-body)]">
                            {action.icon}
                            {action.label}
                        </span>
                        <span className="pl-6 text-[10px] leading-4 text-foreground/45">{action.hint}</span>
                    </button>
                ))}
            </div>
            <Divider className="!my-2" />
            <div className="flex flex-col gap-2 px-1">
                <div className="flex items-center justify-between">
                    <span className="text-[var(--fs-micro)] text-foreground/60">位图倍率</span>
                    <Segmented size="small" value={scale} onChange={(value) => onScaleChange(Number(value))} options={PORTFOLIO_EXPORT_SCALES.map((value) => ({ label: `${value}x`, value }))} />
                </div>
                <Checkbox checked={includeMeta ?? true} onChange={(event) => onIncludeMetaChange(event.target.checked)}>
                    <span className="text-[var(--fs-micro)]">包含图注与标签</span>
                </Checkbox>
                <span className="text-[10px] leading-4 text-foreground/40">PNG 默认不含、HTML 默认包含图注与标签</span>
            </div>
        </div>
    );

    return (
        <Popover open={open} onOpenChange={setOpen} content={content} trigger="click" placement="bottomRight" arrow={false}>
            <Button size="small" icon={busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} disabled={disabled || busy}>
                导出
            </Button>
        </Popover>
    );
}
