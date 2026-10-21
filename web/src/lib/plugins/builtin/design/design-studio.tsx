import { registerPlugin } from "@/lib/plugins/plugin-registry";
import type { PluginManifestV2, RegisteredPlugin } from "@/lib/plugins/plugin-types";

/**
 * 设计工作台是受信任的内置应用插件：宿主在 /plugins/design 路由直接挂载它的全屏界面，
 * 不走上传插件的沙箱运行时（宿主当前只实现 declarative，未实现 web 沙箱加载器）。
 *
 * 与作品集工作台的划界：作品集做多页图注与分类编排，设计工作台做单页精确版式与
 * 社媒尺寸海报。做不到这个区分就应该合并进 portfolio，而不是再堆一个更小的作品集。
 */
export const DESIGN_STUDIO_PLUGIN_ID = "design-studio";

const manifest: PluginManifestV2 = {
    apiVersion: "yingce.plugin/v2",
    id: DESIGN_STUDIO_PLUGIN_ID,
    name: "设计工作台",
    version: "0.1.0",
    description: "海报与版式设计：画布编排、图文色块编辑、按社媒尺寸导出。",
    author: "影策团队",
    surfaces: ["fullscreen"],
    permissions: ["asset.read", "asset.import", "canvas.read"],
    trusted: true,
    runtime: { backend: "trusted-backend", web: "declarative" },
    contributes: {
        importExport: ["design-document"],
        commands: [
            { id: "design.open", label: "打开设计工作台" },
            { id: "design.new", label: "新建设计稿" },
        ],
    },
};

export const designStudioPlugin: RegisteredPlugin = { manifest };

registerPlugin(designStudioPlugin);
