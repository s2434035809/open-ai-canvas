import { registerPlugin } from "@/lib/plugins/plugin-registry";
import type { PluginManifestV2, RegisteredPlugin } from "@/lib/plugins/plugin-types";

/**
 * 作品集工作台是受信任的内置应用插件：宿主在 /portfolio 路由直接挂载它的全屏界面，
 * 不走上传插件的沙箱运行时。文档数据由后端 /api/portfolio 提供，图片复用宿主资源系统。
 */
export const PORTFOLIO_STUDIO_PLUGIN_ID = "portfolio-studio";

const manifest: PluginManifestV2 = {
    apiVersion: "yingce.plugin/v2",
    id: PORTFOLIO_STUDIO_PLUGIN_ID,
    name: "作品集工作台",
    version: "0.1.0",
    description: "导入图片、编排版式并导出作品集，并支持由 Agent 辅助分类与生成文案。",
    author: "影策团队",
    surfaces: ["fullscreen"],
    permissions: ["asset.read", "asset.import", "ai.text", "canvas.read"],
    trusted: true,
    runtime: { backend: "trusted-backend", web: "declarative" },
    contributes: {
        importExport: ["portfolio-document"],
        commands: [
            { id: "portfolio.open", label: "打开作品集工作台" },
            { id: "portfolio.arrange", label: "自动排版当前作品集" },
        ],
    },
};

export const portfolioStudioPlugin: RegisteredPlugin = { manifest };

registerPlugin(portfolioStudioPlugin);
