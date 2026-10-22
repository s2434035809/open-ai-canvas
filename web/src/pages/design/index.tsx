// S1 阶段的门户页：编辑台已经可用，这里负责把它接上门（此前它只能直连 URL 访问）。
// 模板库与卡片流在后续阶段填充。样式走页面局部 .ds-shell 作用域，不外泄到全局主题。

import { Button } from "antd";
import { ArrowRight, PenLine } from "lucide-react";
import { useNavigate } from "react-router";

import { WorkspacePage, PageHeader } from "@/components/layout/workspace-page";
import "@/lib/plugins/builtin";
import "./design.css";

export default function DesignStudioPage() {
    const navigate = useNavigate();
    return (
        <WorkspacePage className="ds-shell">
            <PageHeader
                title="设计工作台"
                description="海报与版式设计：画布编排、图文色块编辑、按社媒尺寸导出。"
                actions={
                    <Button type="primary" icon={<PenLine className="size-4" />} onClick={() => navigate("/plugins/design/editor")}>
                        打开编辑器
                    </Button>
                }
            />
            <div className="ds-empty">
                <p className="ds-empty-title">从一张空白稿开始</p>
                <p className="ds-empty-note">
                    编辑器支持画布编排、图层与素材、图文属性编辑，以及 1:1 / 3:4 / 4:5 / 9:16 / 16:9 五档社媒尺寸预设与单页 PNG 导出。
                    模板库与草稿保存将在后续阶段接入。
                </p>
                <Button type="primary" icon={<ArrowRight className="size-4" />} onClick={() => navigate("/plugins/design/editor")}>
                    新建设计稿
                </Button>
            </div>
        </WorkspacePage>
    );
}
