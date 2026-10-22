/**
 * 设计工作台的 Agent 对话面板。
 *
 * 这是本工作台的主入口：用户在右侧常驻的对话里描述想要什么，
 * Agent 读画布、给出版式方案，用户确认后应用。手动拖拽是精修层。
 *
 * 面板只服务设计工作台：产物是「版式方案 + 直接改画布」，消息结构、
 * 确认方式与展示组件都按这一种交互设计，不承载其他工作台的形态。
 */

import { Button, Checkbox, Input, Tag } from "antd";
import { Check, ChevronDown, ChevronRight, Loader2, Play, Sparkles, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ModelPicker } from "@/components/model-picker";
import type { DesignLayoutOption } from "@/lib/design/agent";
import { selectableModelsByCapability, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";

import { DesignLayoutThumbnail } from "./design-layout-thumbnail";

export type DesignAgentStep = { toolName: string; label: string; ok: boolean };

export type DesignProposalItem = {
    elementId: string;
    /** 建议的新文案（改文字元素时）。 */
    text: string;
    previousText: string;
    accepted: boolean;
};

export type DesignAgentPanelProps = {
    busy: boolean;
    canRun: boolean;
    stage: string;
    reasoning: string;
    assistantText: string;
    steps: readonly DesignAgentStep[];
    failureMessage: string;
    /** Agent 直接改画布时登记的待确认项。 */
    proposals: readonly DesignProposalItem[];
    /** 当前页元素数，让用户在按下运行前知道 Agent 会看到什么。 */
    elementCount: number;
    imageCount: number;
    layoutOptions: readonly DesignLayoutOption[];
    selectedLayout: number | null;
    previewPage: { width: number; height: number; elements: readonly unknown[] } | null;
    onRun: (instruction: string) => void;
    onStop: () => void;
    onToggleProposal: (elementId: string, accepted: boolean) => void;
    onApplyProposals: () => void;
    onDiscardProposals: () => void;
    onSelectLayout: (index: number) => void;
    onApplyLayout: () => void;
    onDiscardLayouts: () => void;
};

export const DESIGN_AGENT_DEFAULT_INSTRUCTION = "把这张海报的主标题做大、突出层级，图片与文字之间留出呼吸感；给我 2-4 个方向不同的构图方案。";

export function DesignAgentPanel({
    busy,
    canRun,
    stage,
    reasoning,
    assistantText,
    steps,
    failureMessage,
    proposals,
    elementCount,
    imageCount,
    layoutOptions,
    selectedLayout,
    previewPage,
    onRun,
    onStop,
    onToggleProposal,
    onApplyProposals,
    onDiscardProposals,
    onSelectLayout,
    onApplyLayout,
    onDiscardLayouts,
}: DesignAgentPanelProps) {
    const config = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const [instruction, setInstruction] = useState(DESIGN_AGENT_DEFAULT_INSTRUCTION);
    const [reasoningOpen, setReasoningOpen] = useState(false);
    const listRef = useRef<HTMLDivElement | null>(null);

    const selectedModel = useMemo(() => {
        const textModels = selectableModelsByCapability(config, "text");
        const preferred = config.textModel || config.model || "";
        return textModels.includes(preferred) ? preferred : textModels[0] || "";
    }, [config]);

    const setModel = (model: string) => {
        updateConfig("textModel", model);
        updateConfig("model", model);
    };

    const acceptedCount = proposals.filter((item) => item.accepted).length;
    const started = busy || steps.length > 0 || Boolean(assistantText) || Boolean(reasoning) || proposals.length > 0 || layoutOptions.length > 0;

    // 新内容进来时贴底，用户不用手动滚。
    useEffect(() => {
        const list = listRef.current;
        if (list) list.scrollTop = list.scrollHeight;
    }, [assistantText, steps.length, layoutOptions.length, proposals.length]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <header className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-3">
                <Sparkles className="size-4 text-sky-400" />
                <span className="text-[13px] font-medium text-white/90">设计 Agent</span>
                <span className="ml-auto text-[11px] text-white/40">
                    {elementCount > 0 ? `${elementCount} 个元素 · ${imageCount} 张图片` : "空白画布"}
                </span>
            </header>

            <div ref={listRef} className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
                {!started ? (
                    <p className="text-[12px] leading-5 text-white/50">
                        描述你想要的样子：Agent 会读取当前画布，给出可挑选的版式方案，或直接调整元素。选定后应用，可用撤销回退。
                    </p>
                ) : null}

                {steps.length > 0 ? (
                    <div>
                        <div className="mb-1 font-mono text-[10px] tracking-[0.18em] text-white/35 uppercase">Steps</div>
                        <ol className="space-y-0.5">
                            {steps.map((step, index) => (
                                <li key={`${step.toolName}-${index}`} className="flex items-center gap-1.5 font-mono text-[11px] text-white/65">
                                    <span className="w-4 shrink-0 text-right text-white/25 select-none">{String(index + 1).padStart(2, "0")}</span>
                                    {step.ok ? <Check className="size-3 shrink-0 text-emerald-400" /> : <span className="size-3 shrink-0 text-center text-red-400">!</span>}
                                    <span className="truncate">{step.label}</span>
                                    <span className="ml-auto shrink-0 text-white/30">{step.ok ? "完成" : "失败"}</span>
                                </li>
                            ))}
                        </ol>
                    </div>
                ) : null}

                {reasoning ? (
                    <div className="rounded-lg border border-white/10">
                        <button type="button" className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-[11px] text-white/55" onClick={() => setReasoningOpen((open) => !open)} aria-expanded={reasoningOpen}>
                            {reasoningOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                            思考过程
                        </button>
                        {reasoningOpen ? <div className="max-h-56 overflow-y-auto whitespace-pre-wrap border-t border-white/10 px-2 py-1.5 text-[11px] leading-5 text-white/50">{reasoning}</div> : null}
                    </div>
                ) : null}

                {assistantText ? <div className="whitespace-pre-wrap text-[13px] leading-6 text-white/85">{assistantText}</div> : null}

                {busy ? (
                    <div className="flex items-center gap-1.5 text-[11px] text-white/50">
                        <Loader2 className="size-3.5 animate-spin" />
                        {stage || "Agent 正在处理…"}
                    </div>
                ) : null}

                {failureMessage ? <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] leading-5 text-red-300">{failureMessage}</div> : null}

                {layoutOptions.length > 0 ? (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <span className="font-mono text-[10px] tracking-[0.18em] text-white/35 uppercase">Versions</span>
                            <span className="text-[11px] text-white/40">{layoutOptions.length} 个方案</span>
                        </div>
                        <p className="text-[11px] leading-5 text-white/45">每个方案都能在小图上看到排版效果。选定后应用，可一键撤销。</p>
                        <div className="space-y-2">
                            {layoutOptions.map((option, index) => (
                                <div key={`${option.name}-${index}`} className={selectedLayout === index ? "rounded-lg border border-sky-500 bg-sky-500/10 p-2" : "rounded-lg border border-white/10 bg-white/[0.04] p-2"}>
                                    {previewPage ? <DesignLayoutThumbnail option={option} page={previewPage} /> : null}
                                    <div className="mt-2 flex items-start gap-2">
                                        <div className="min-w-0 flex-1">
                                            <div className="text-[13px] font-semibold break-words text-white/90">{option.name}</div>
                                            {option.reason ? <div className="mt-0.5 text-[11px] leading-5 break-words text-white/50">{option.reason}</div> : null}
                                        </div>
                                        <Button type={selectedLayout === index ? "primary" : "default"} size="small" onClick={() => onSelectLayout(index)}>
                                            {selectedLayout === index ? "已选用" : "选用"}
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div className="flex gap-1">
                            <Button type="primary" size="small" disabled={selectedLayout === null} onClick={onApplyLayout}>
                                应用此版式
                            </Button>
                            <Button size="small" onClick={onDiscardLayouts}>
                                放弃
                            </Button>
                        </div>
                    </div>
                ) : null}

                {proposals.length > 0 ? (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] text-white/55">改动（{acceptedCount}/{proposals.length} 选中）</span>
                            <div className="flex gap-1">
                                <Button type="link" size="small" className="!h-auto !px-1" onClick={() => proposals.forEach((item) => onToggleProposal(item.elementId, true))}>
                                    全选
                                </Button>
                                <Button type="link" size="small" className="!h-auto !px-1" onClick={() => proposals.forEach((item) => onToggleProposal(item.elementId, false))}>
                                    全不选
                                </Button>
                            </div>
                        </div>
                        {proposals.map((item) => (
                            <div key={item.elementId} className="flex items-start gap-2 rounded-lg border border-white/10 p-2">
                                <Checkbox className="mt-0.5" checked={item.accepted} onChange={(event) => onToggleProposal(item.elementId, event.target.checked)} />
                                <div className="min-w-0 flex-1">
                                    <div className="text-[13px] leading-snug break-words text-white/85">{item.text || "（清空文案）"}</div>
                                    <div className="mt-1 text-[11px] text-white/40">原内容：{item.previousText || "（空）"}</div>
                                </div>
                            </div>
                        ))}
                        <div className="flex gap-1">
                            <Button type="primary" size="small" disabled={acceptedCount === 0} onClick={onApplyProposals}>
                                应用到画布
                            </Button>
                            <Button size="small" onClick={onDiscardProposals}>
                                放弃
                            </Button>
                        </div>
                    </div>
                ) : null}

                {!busy && started && layoutOptions.length === 0 && proposals.length === 0 && !failureMessage ? (
                    <div className="rounded-lg border border-white/10 px-2 py-1.5 text-[11px] leading-5 text-white/45">
                        这次没有可应用的方案。可以换个说法，或描述得更具体些（例如「把主标放到左上、字号再大一倍」）。
                    </div>
                ) : null}
            </div>

            <footer className="shrink-0 space-y-2 border-t border-white/10 p-3">
                <Input.TextArea value={instruction} onChange={(event) => setInstruction(event.target.value)} autoSize={{ minRows: 2, maxRows: 6 }} maxLength={600} disabled={busy} placeholder="例如：把主标放到左上角，字号再大一倍，整张留白多一些" />
                <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                        <ModelPicker config={config} value={selectedModel} capability="text" onChange={setModel} variant="creation" fullWidth showSelectedPrice={false} showOptionPrices placeholder="选择文本模型" />
                    </div>
                    {busy ? (
                        <Button size="small" icon={<Square className="size-3" />} onClick={onStop}>
                            停止
                        </Button>
                    ) : (
                        <Button type="primary" size="small" icon={<Play className="size-3.5" />} disabled={!canRun || !instruction.trim()} onClick={() => onRun(instruction)}>
                            运行
                        </Button>
                    )}
                </div>
                {!canRun && !busy ? <p className="text-[11px] text-white/35">画布还没有内容，先添加元素或导入图片</p> : null}
            </footer>
        </div>
    );
}
