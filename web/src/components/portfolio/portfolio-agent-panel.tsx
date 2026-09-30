/**
 * 作品集右栏的 Agent 面板。
 *
 * 形态对齐影策自带 Agent（创作台 / 自由画布 / 短剧创作共用的那套）：**选模型 → 写要求 →
 * 运行 → 看见过程 → 确认结果**。模型选择器是同一个 `ModelPicker`，"换模型"写回同一组
 * 全局配置字段（`textModel` + `model`），所以在这里换模型和在任何工作台换模型是一件事。
 *
 * 有意不做的两件事，以及原因：
 *   - **不做跨轮会话历史**：作品集 Agent 是任务型（"给当前页配文"），不是聊天。保留历史
 *     只会让用户在多个相似结果之间挑花眼，而每次运行都基于当前文档重读一遍，天然幂等。
 *   - **不做审批轮次**：作品集的三个工具是只读 + 提议，运行时不会写文档，所以"确认"发生在
 *     面板底部的建议区，而不是运行中途。
 */

import { Button, Checkbox, Input, Tag } from "antd";
import { Check, ChevronDown, ChevronRight, Loader2, Play, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import { ModelPicker } from "@/components/model-picker";
import { PORTFOLIO_AGENT_DEFAULT_INSTRUCTION } from "@/lib/portfolio/agent-run";
import { selectableModelsByCapability, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";

/** 待确认的建议条目：页面在运行结束后按"元素是否还在"收窄，面板只负责展示与勾选。 */
export type PortfolioProposalReviewItem = {
    elementId: string;
    caption: string;
    tags: string[];
    previousCaption: string;
    previousTags: string[];
    previewSrc: string;
    accepted: boolean;
};

/** 一次工具调用在界面上的落点。 */
export type PortfolioAgentStep = {
    toolName: string;
    label: string;
    ok: boolean;
};

export type PortfolioAgentPanelProps = {
    busy: boolean;
    canRun: boolean;
    /** 运行期一句话进度。 */
    stage: string;
    /** 模型的思考过程，可能为空。 */
    reasoning: string;
    /** 模型输出的正文。 */
    assistantText: string;
    steps: readonly PortfolioAgentStep[];
    /** 运行失败原因，成功时为空串。 */
    failureMessage: string;
    proposals: readonly PortfolioProposalReviewItem[];
    /** 当前页会被处理的图片数量，让用户在按下按钮前就知道代价。 */
    imageCount: number;
    onRun: (instruction: string) => void;
    onStop: () => void;
    onToggleProposal: (elementId: string, accepted: boolean) => void;
    onApplyProposals: () => void;
    onDiscardProposals: () => void;
};

export function PortfolioAgentPanel({ busy, canRun, stage, reasoning, assistantText, steps, failureMessage, proposals, imageCount, onRun, onStop, onToggleProposal, onApplyProposals, onDiscardProposals }: PortfolioAgentPanelProps) {
    const config = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const [instruction, setInstruction] = useState(PORTFOLIO_AGENT_DEFAULT_INSTRUCTION);
    const [reasoningOpen, setReasoningOpen] = useState(false);

    // 与画布 Agent 面板同一套解析：优先 `textModel`，再退回通用 `model`，都不在可选目录里
    // 就取第一个文本模型——避免旧配置残留一个已下架的模型名让面板空着。
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
    const started = busy || steps.length > 0 || Boolean(assistantText) || Boolean(reasoning) || proposals.length > 0;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
                <Sparkles className="size-4 text-sky-600" />
                <span className="text-[var(--fs-body)] font-medium">作品集 Agent</span>
                <span className="ml-auto text-[var(--fs-micro)] text-foreground/45">{imageCount > 0 ? `当前页 ${imageCount} 张图片` : "当前页没有图片"}</span>
            </header>

            <div className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
                {!started ? <p className="text-[var(--fs-micro)] leading-5 text-foreground/55">写下要求后运行：Agent 会读取当前页元素、逐张查看图片画面，再把图注与标签作为建议提交上来。建议不会直接改动作品集，确认后才写入。</p> : null}

                {steps.length > 0 ? (
                    <ol className="space-y-1">
                        {steps.map((step, index) => (
                            <li key={`${step.toolName}-${index}`} className="flex items-center gap-1.5 text-[var(--fs-micro)] text-foreground/70">
                                {step.ok ? <Check className="size-3 shrink-0 text-emerald-600" /> : <span className="size-3 shrink-0 text-center text-destructive">!</span>}
                                <span className="truncate">{step.label}</span>
                                <span className="ml-auto shrink-0 text-foreground/35">{step.ok ? "完成" : "失败"}</span>
                            </li>
                        ))}
                    </ol>
                ) : null}

                {reasoning ? (
                    <div className="rounded-[var(--r-md)] border border-border/50">
                        <button type="button" className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-[var(--fs-micro)] text-foreground/60" onClick={() => setReasoningOpen((open) => !open)} aria-expanded={reasoningOpen}>
                            {reasoningOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                            思考过程
                        </button>
                        {reasoningOpen ? <div className="max-h-56 overflow-y-auto whitespace-pre-wrap border-t border-border/50 px-2 py-1.5 text-[var(--fs-micro)] leading-5 text-foreground/55">{reasoning}</div> : null}
                    </div>
                ) : null}

                {assistantText ? <div className="whitespace-pre-wrap text-[var(--fs-body)] leading-6 text-foreground/85">{assistantText}</div> : null}

                {busy ? (
                    <div className="flex items-center gap-1.5 text-[var(--fs-micro)] text-foreground/60">
                        <Loader2 className="size-3.5 animate-spin" />
                        {stage || "Agent 正在分析当前页图片…"}
                    </div>
                ) : null}

                {failureMessage ? <div className="rounded-[var(--r-md)] border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[var(--fs-micro)] leading-5 text-destructive">{failureMessage}</div> : null}

                {proposals.length > 0 ? (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <span className="text-[var(--fs-micro)] text-foreground/60">
                                建议（{acceptedCount}/{proposals.length} 选中）
                            </span>
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
                            <div key={item.elementId} className="flex items-start gap-2 rounded-[var(--r-md)] border border-border/60 p-2">
                                <Checkbox className="mt-0.5" checked={item.accepted} onChange={(event) => onToggleProposal(item.elementId, event.target.checked)} />
                                {item.previewSrc ? <img src={item.previewSrc} alt="" className="size-10 shrink-0 rounded-[var(--r-sm)] object-cover" /> : null}
                                <div className="min-w-0 flex-1">
                                    <div className="text-[var(--fs-body)] leading-snug break-words">{item.caption || "（未给出图注）"}</div>
                                    {item.tags.length > 0 ? (
                                        <div className="mt-1 flex flex-wrap gap-1">
                                            {item.tags.map((tag) => (
                                                <Tag key={tag} className="!m-0">
                                                    {tag}
                                                </Tag>
                                            ))}
                                        </div>
                                    ) : null}
                                    {item.previousCaption || item.previousTags.length > 0 ? <div className="mt-1 text-[var(--fs-micro)] text-foreground/45">原图注：{item.previousCaption || "（无）"}</div> : null}
                                </div>
                            </div>
                        ))}
                        <div className="flex gap-1">
                            <Button type="primary" size="small" disabled={acceptedCount === 0} onClick={onApplyProposals}>
                                写入作品集
                            </Button>
                            <Button size="small" onClick={onDiscardProposals}>
                                放弃
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>

            <footer className="shrink-0 space-y-2 border-t border-border/60 p-3">
                <Input.TextArea value={instruction} onChange={(event) => setInstruction(event.target.value)} autoSize={{ minRows: 2, maxRows: 5 }} maxLength={500} disabled={busy} placeholder="例如：为这一页的图片写中文图注和 3-5 个分类标签" />
                <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                        <ModelPicker config={config} value={selectedModel} capability="text" onChange={setModel} variant="creation" fullWidth showSelectedPrice={false} showOptionPrices placeholder="选择文本模型" />
                    </div>
                    {busy ? (
                        <Button size="small" onClick={onStop}>
                            停止
                        </Button>
                    ) : (
                        <Button type="primary" size="small" icon={<Play className="size-3.5" />} disabled={!canRun || !instruction.trim()} onClick={() => onRun(instruction)}>
                            运行
                        </Button>
                    )}
                </div>
                {!canRun && !busy ? <p className="text-[var(--fs-micro)] text-foreground/45">当前页没有可分析的图片</p> : null}
            </footer>
        </div>
    );
}
