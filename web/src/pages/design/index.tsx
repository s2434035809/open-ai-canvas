// S0 骨架阶段的占位页：只验证接入链路（插件注册 → 路由 → 侧栏入口），
// 编辑器与门户卡片流在后续阶段填充。样式走页面局部 .ds-shell 作用域，
// 照 pages/portfolio 的做法，不外泄到全局主题。

import { WorkspacePage, PageHeader } from "@/components/layout/workspace-page";
import "@/lib/plugins/builtin";
import "./design.css";

export default function DesignStudioPage() {
    return (
        <WorkspacePage className="ds-shell">
            <PageHeader
                title="设计工作台"
                description="海报与版式设计：画布编排、图文色块编辑、按社媒尺寸导出。"
            />
            <div className="ds-empty">
                <p className="ds-empty-title">设计工作台已接通</p>
                <p className="ds-empty-note">
                    当前为骨架版本，用于验证插件注册、路由挂载与侧栏入口。编辑器与模板将在下一阶段接入。
                </p>
            </div>
        </WorkspacePage>
    );
}
