import { describe, expect, test } from "bun:test";

import { buildPortfolioAgentPrompt, parsePortfolioAnnotationProposals, portfolioAgentModelSelection, PORTFOLIO_AGENT_MAX_IMAGES } from "../src/lib/portfolio/agent-run";
import { isPortfolioShellCanvasId, portfolioShellCanvasId, PORTFOLIO_SHELL_CANVAS_PREFIX } from "../src/lib/portfolio/contracts";
import { createModelChannel, defaultConfig, type AiConfig } from "../src/stores/use-config-store";

/**
 * 作品集接入内置云 Agent 的契约测试。
 *
 * 这里守的是三件容易悄悄坏掉、坏了又要等用户跑到一半才发现的事情：
 *   1. 壳画布 ID 的派生规则（前缀同时是"画布列表要滤掉它"的判据，改一处漏一处就会
 *      在画布列表里冒出点不开的幽灵画布）；
 *   2. 内置 Agent 只接受后端受管渠道模型：自带密钥的渠道必须解析不出选择，而不是
 *      带着浏览器密钥发出去被后端拒掉；
 *   3. 提示词必须把 pageId 与目标元素 ID 写全——少一个模型就会自己找页面、顺手改到
 *      别的页，而建议是只读的，用户看不到它"多做了什么"。
 */

function systemChannelConfig(): AiConfig {
    return {
        ...defaultConfig,
        model: "platform::vision-text",
        channels: [createModelChannel({ id: "platform", scope: "system", models: ["vision-text"], interfaceType: "chat-completion" })],
    };
}

function userChannelConfig(): AiConfig {
    return {
        ...defaultConfig,
        model: "my-key-channel::vision-text",
        channels: [createModelChannel({ id: "my-key-channel", name: "我的渠道", apiKey: "sk-local", models: ["vision-text"], interfaceType: "chat-completion" })],
    };
}

describe("portfolio shell canvas id", () => {
    test("文档 ID 与壳画布 ID 互为换算，且只认自己的前缀", () => {
        expect(PORTFOLIO_SHELL_CANVAS_PREFIX).toBe("pf-");
        expect(portfolioShellCanvasId("doc-1")).toBe("pf-doc-1");
        expect(portfolioShellCanvasId("  doc-1  ")).toBe("pf-doc-1");
        for (const shell of ["pf-doc-1", "pf-5ac1b720a9b36f69b022d0a60a14b40f"]) {
            expect(isPortfolioShellCanvasId(shell)).toBe(true);
        }
        // 空壳、别的前缀、以及用户自己起名叫 pf 的画布都不能被误判。
        for (const plain of ["", "pf-", "pfx-doc-1", "agent-canvas", "canvas-pf-doc-1"]) {
            expect(isPortfolioShellCanvasId(plain)).toBe(false);
        }
    });
});

describe("portfolio agent model selection", () => {
    test("平台渠道解析成 channelId + channelModelKey（看图能力只认这条形状）", () => {
        const selection = portfolioAgentModelSelection(systemChannelConfig(), "platform::vision-text");
        expect(selection).toEqual({ channelId: "platform", channelModelKey: "vision-text" });
    });

    test("自带密钥的渠道解析不出后端受管模型", () => {
        expect(portfolioAgentModelSelection(userChannelConfig(), "my-key-channel::vision-text")).toBeNull();
    });
});

describe("portfolio agent prompt", () => {
    test("写全 pageId、全部目标元素 ID 与三个作品集工具", () => {
        const images = [
            { id: "img-1", caption: "", tags: [] },
            { id: "img-2", caption: "已有图注", tags: ["人像"] },
        ];
        const prompt = buildPortfolioAgentPrompt({ pageId: "page-1", pageName: "封面", images });
        for (const token of ["portfolio_read_document", "portfolio_inspect_image", "portfolio_propose_annotations", "page-1", "封面", "img-1", "img-2"]) {
            expect(prompt).toContain(token);
        }
        // 现有图注与标签要带上，否则模型会把已经有的信息当成"没有"再写一遍。
        expect(prompt).toContain("已有图注");
        expect(prompt).toContain("人像");
        // 不要求它处理别的页面，避免一次运行烧在无关内容上。
        expect(prompt).toContain("不要动其它页面或其它元素");
    });

    test("单批图片上限与页面一致", () => {
        // page 与 lib 用的是同一个常量；这里守住它不会被改成 0 或负数。
        expect(PORTFOLIO_AGENT_MAX_IMAGES).toBeGreaterThan(0);
        expect(PORTFOLIO_AGENT_MAX_IMAGES).toBe(8);
    });
});

describe("portfolio proposal parsing", () => {
    test("按契约收窄模型产物，丢掉脏数据", () => {
        const parsed = parsePortfolioAnnotationProposals([{ elementId: "img-1", caption: " 海边人像 ", tags: ["人像", "", 7, "风景"] }, { elementId: "", caption: "缺少元素 ID" }, { elementId: "img-2" }, "不是对象", null]);
        expect(parsed).toEqual([
            { elementId: "img-1", caption: "海边人像", tags: ["人像", "风景"] },
            { elementId: "img-2", caption: "", tags: [] },
        ]);
    });

    test("非数组输入不会抛错", () => {
        for (const value of [undefined, null, "items", 42, { elementId: "img-1" }]) {
            expect(parsePortfolioAnnotationProposals(value)).toEqual([]);
        }
    });

    test("标签数量按后端归一化上限截断", () => {
        const parsed = parsePortfolioAnnotationProposals([{ elementId: "img-1", caption: "", tags: ["a", "b", "c", "d", "e", "f", "g", "h"] }]);
        expect(parsed[0].tags).toEqual(["a", "b", "c", "d", "e", "f"]);
    });
});
