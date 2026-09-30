/**
 * 作品集右栏属性面板：选中元素时编辑元素属性，未选中时编辑页面与文档属性。
 *
 * 数值输入直接写回 store（走撤销栈），这样键盘微调也能被撤销，和拖拽保持一致。
 */

import { ColorPicker, Divider, Input, InputNumber, Segmented, Select, Slider, Switch } from "antd";
import { useMemo } from "react";

import type { PortfolioImageFit, PortfolioTextAlign } from "@/lib/portfolio/contracts";
import { currentPortfolioPage, usePortfolioStore } from "@/lib/portfolio/store";

const FIT_OPTIONS: Array<{ label: string; value: PortfolioImageFit }> = [
    { label: "裁剪填满", value: "cover" },
    { label: "完整显示", value: "contain" },
    { label: "拉伸", value: "fill" },
];

const ALIGN_OPTIONS: Array<{ label: string; value: PortfolioTextAlign }> = [
    { label: "左", value: "left" },
    { label: "中", value: "center" },
    { label: "右", value: "right" },
];

const FONT_OPTIONS = [
    { label: "Inter", value: "Inter, system-ui, sans-serif" },
    { label: "思源黑体", value: "'Source Han Sans SC', 'Noto Sans SC', sans-serif" },
    { label: "思源宋体", value: "'Source Han Serif SC', 'Noto Serif SC', serif" },
    { label: "等宽", value: "'JetBrains Mono', ui-monospace, monospace" },
];

export function PortfolioInspector() {
    const page = usePortfolioStore(currentPortfolioPage);
    const selectedIds = usePortfolioStore((state) => state.selectedIds);
    const updateElement = usePortfolioStore((state) => state.updateElement);
    const updatePage = usePortfolioStore((state) => state.updatePage);
    const setDescription = usePortfolioStore((state) => state.setDescription);
    const description = usePortfolioStore((state) => state.document?.description ?? "");

    const selected = useMemo(() => (page ? page.elements.filter((element) => selectedIds.includes(element.id)) : []), [page, selectedIds]);
    const single = selected.length === 1 ? selected[0] : null;

    return (
        <div className="thin-scrollbar h-full overflow-y-auto p-3">
            {single ? (
                <div className="space-y-3">
                    <header className="text-[var(--fs-body)] font-medium">{single.kind === "image" ? "图片元素" : "文字元素"}</header>
                    <div className="grid grid-cols-2 gap-2">
                        <LabeledNumber label="X" value={single.x} onChange={(x) => updateElement(single.id, { x })} />
                        <LabeledNumber label="Y" value={single.y} onChange={(y) => updateElement(single.id, { y })} />
                        <LabeledNumber label="宽" value={single.width} min={8} onChange={(width) => updateElement(single.id, { width })} />
                        <LabeledNumber label="高" value={single.height} min={8} onChange={(height) => updateElement(single.id, { height })} />
                        <LabeledNumber label="旋转°" value={Math.round(single.rotation)} onChange={(rotation) => updateElement(single.id, { rotation })} />
                        <LabeledNumber label="不透明度%" value={Math.round(single.opacity * 100)} min={0} max={100} onChange={(value) => updateElement(single.id, { opacity: Math.min(1, Math.max(0, value / 100)) })} />
                    </div>

                    <Divider className="!my-2" />

                    {single.kind === "image" ? (
                        <div className="space-y-2">
                            <Field label="填充方式">
                                <Segmented block size="small" value={single.fit} options={FIT_OPTIONS} onChange={(value) => updateElement(single.id, { fit: value as PortfolioImageFit })} />
                            </Field>
                            <Field label="图注">
                                <Input.TextArea value={single.caption} autoSize={{ minRows: 2, maxRows: 4 }} maxLength={200} onChange={(event) => updateElement(single.id, { caption: event.target.value })} placeholder="导出的 HTML / PDF 会显示在图下" />
                            </Field>
                            <Field label="分类标签">
                                <Select mode="tags" className="w-full" value={single.tags} onChange={(tags: string[]) => updateElement(single.id, { tags })} placeholder="回车添加标签" tokenSeparators={[",", "，"]} />
                            </Field>
                            <Field label="资源引用">
                                <Input value={single.assetId || "本地内嵌"} readOnly />
                            </Field>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <Field label="文字内容">
                                <Input.TextArea value={single.text} autoSize={{ minRows: 3, maxRows: 8 }} onChange={(event) => updateElement(single.id, { text: event.target.value })} />
                            </Field>
                            <Field label="字体">
                                <Select className="w-full" value={single.fontFamily} options={FONT_OPTIONS} onChange={(fontFamily) => updateElement(single.id, { fontFamily })} />
                            </Field>
                            <div className="grid grid-cols-2 gap-2">
                                <LabeledNumber label="字号" value={single.fontSize} min={6} onChange={(fontSize) => updateElement(single.id, { fontSize })} />
                                <LabeledNumber label="字重" value={single.fontWeight} min={100} max={900} step={100} onChange={(fontWeight) => updateElement(single.id, { fontWeight })} />
                                <LabeledNumber label="行高" value={single.lineHeight} min={0.8} max={3} step={0.1} onChange={(lineHeight) => updateElement(single.id, { lineHeight })} />
                                <LabeledNumber label="字距" value={single.letterSpacing} min={-5} max={40} onChange={(letterSpacing) => updateElement(single.id, { letterSpacing })} />
                            </div>
                            <Field label="对齐">
                                <Segmented block size="small" value={single.align} options={ALIGN_OPTIONS} onChange={(value) => updateElement(single.id, { align: value as PortfolioTextAlign })} />
                            </Field>
                            <Field label="颜色">
                                <ColorPicker showText value={single.color} onChange={(color) => updateElement(single.id, { color: color.toHexString() })} />
                            </Field>
                        </div>
                    )}

                    <Divider className="!my-2" />
                    <Field label="锁定">
                        <Switch size="small" checked={single.locked} onChange={(locked) => updateElement(single.id, { locked })} />
                    </Field>
                </div>
            ) : selected.length > 1 ? (
                <div className="space-y-3">
                    <header className="text-[var(--fs-body)] font-medium">已选 {selected.length} 个元素</header>
                    <Field label="整体不透明度">
                        <Slider min={0} max={100} value={Math.round((selected[0]?.opacity ?? 1) * 100)} onChange={(value) => usePortfolioStore.getState().updateSelected({ opacity: value / 100 })} />
                    </Field>
                    <p className="text-[var(--fs-micro)] leading-5 text-foreground/55">多选时可以整体拖动、对齐、层级调整与自动网格排版；要改具体尺寸请单选。</p>
                </div>
            ) : (
                <div className="space-y-3">
                    <header className="text-[var(--fs-body)] font-medium">页面与文档</header>
                    {page ? (
                        <>
                            <Field label="页面名称">
                                <Input value={page.name} maxLength={40} onChange={(event) => updatePage(page.id, { name: event.target.value })} />
                            </Field>
                            <div className="grid grid-cols-2 gap-2">
                                <LabeledNumber label="页宽" value={page.width} min={200} onChange={(width) => updatePage(page.id, { width })} />
                                <LabeledNumber label="页高" value={page.height} min={200} onChange={(height) => updatePage(page.id, { height })} />
                            </div>
                            <Field label="页面底色">
                                <ColorPicker showText value={page.background} onChange={(color) => updatePage(page.id, { background: color.toHexString() })} />
                            </Field>
                        </>
                    ) : null}
                    <Divider className="!my-2" />
                    <Field label="作品集说明">
                        <Input.TextArea value={description} autoSize={{ minRows: 3, maxRows: 6 }} maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="简单描述这份作品集的主题，导出时可用作前言" />
                    </Field>
                    <p className="text-[var(--fs-micro)] leading-5 text-foreground/55">在画布空白处拖动可框选元素；双击文字元素可直接编辑文案。</p>
                </div>
            )}
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block space-y-1">
            <span className="text-[var(--fs-micro)] text-foreground/60">{label}</span>
            <span className="block">{children}</span>
        </label>
    );
}

function LabeledNumber({ label, value, onChange, min, max, step }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number }) {
    return (
        <label className="block space-y-1">
            <span className="text-[var(--fs-micro)] text-foreground/60">{label}</span>
            <InputNumber className="w-full" size="small" value={Math.round(value * 100) / 100} min={min} max={max} step={step} onChange={(next) => onChange(typeof next === "number" ? next : 0)} />
        </label>
    );
}
