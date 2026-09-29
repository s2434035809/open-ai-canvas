/**
 * Agent 辅助：给作品集里的图片做分类与配文。
 *
 * 走宿主提供的插件文本模型通道（`services.ai.text`），与提示词优化器同一条链路，
 * 因此沿用同一份全局模型配置，不额外引入密钥管理。返回结果只描述变化，由调用方
 * 决定是否写入文档，避免"看一眼就被改掉"。
 */

import type { PluginHostContext, PluginInstallation, PluginTextContentPart, RegisteredPlugin } from "@/lib/plugins/plugin-types";
import { createPluginHostContext } from "@/services/plugin-host";
import type { AiConfig } from "@/stores/use-config-store";

export type PortfolioImageSuggestionInput = {
    id: string;
    url: string;
};

export type PortfolioImageSuggestion = {
    id: string;
    title: string;
    tags: string[];
    caption: string;
};

const SYSTEM_PROMPT = [
    "你是一名作品集编辑助理。用户会给你若干张图片，请为每张图给出：",
    "1) title：不超过 12 个字的中文标题；",
    "2) tags：1-4 个分类标签，用于分组与筛选，尽量复用常见类别（如 人像、风景、产品、建筑、插画、概念设计、界面）；",
    "3) caption：不超过 40 字的图注，客观描述画面内容，不要夸张营销词。",
    "只根据画面可见内容判断，不要臆测人物身份或地点。",
].join("\n");

const CLASSIFY_TOOL = {
    type: "function" as const,
    function: {
        name: "submit_portfolio_classification",
        description: "提交每张图片的分类与图注",
        parameters: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string", description: "原样回传输入里的图片 id" },
                            title: { type: "string" },
                            tags: { type: "array", items: { type: "string" } },
                            caption: { type: "string" },
                        },
                        required: ["id", "title", "tags", "caption"],
                    },
                },
            },
            required: ["items"],
        },
        strict: true,
    },
};

/** 类型收窄：只接受字符串数组，过滤模型偶尔多给的脏数据。 */
function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
        .slice(0, 6);
}

function parseJson(text: string): Record<string, unknown> | null {
    const trimmed = text
        .trim()
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/, "")
        .trim();
    try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function normalizeSuggestions(value: unknown): PortfolioImageSuggestion[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): PortfolioImageSuggestion[] => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        if (!id) return [];
        return [
            {
                id,
                title: typeof record.title === "string" ? record.title.trim() : "",
                tags: stringList(record.tags),
                caption: typeof record.caption === "string" ? record.caption.trim() : "",
            },
        ];
    });
}

export function createPortfolioAgent(plugin: RegisteredPlugin, installation: PluginInstallation, aiConfig: AiConfig) {
    const context: PluginHostContext = createPluginHostContext(plugin, installation, aiConfig);
    const textService = context.services?.ai?.text;
    if (!textService) throw new Error("作品集工作台暂未获得文本模型服务");

    return {
        /**
         * 一次请求最多分析 8 张图：再多的图片会让单次请求体积与耗时都不可控，
         * 调用方按批调度即可。
         */
        async classify(images: readonly PortfolioImageSuggestionInput[], signal?: AbortSignal): Promise<PortfolioImageSuggestion[]> {
            if (images.length === 0) return [];
            const content: PluginTextContentPart[] = [{ type: "text", text: "请为下列图片分类并配文，id 必须原样回传。" }];
            for (const image of images) {
                content.push({ type: "text", text: `图片 id: ${image.id}` });
                content.push({ type: "image_url", image_url: { url: image.url } });
            }
            const response = await textService.requestToolResponse({
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content },
                ],
                tools: [CLASSIFY_TOOL],
                toolChoice: { type: "function", name: "submit_portfolio_classification" },
                signal,
            });
            const toolCall = response.toolCalls.find((call) => call.name === "submit_portfolio_classification");
            const parsed = parseJson(toolCall?.arguments || response.content);
            return normalizeSuggestions(parsed?.items);
        },
    };
}

export type PortfolioAgent = ReturnType<typeof createPortfolioAgent>;
