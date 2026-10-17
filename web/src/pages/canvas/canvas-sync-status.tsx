import { CloudCheck, LoaderCircle } from "lucide-react";
import { Button, Popover } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useSyncProgressStore } from "@/stores/use-sync-progress-store";
import { canvasRecoveryExport, restoreCanvasCloudVersion, saveRemoteUserDataNow } from "@/services/user-data-sync";
import { getActiveUserScope } from "@/lib/user-scope";
import "./canvas-sync-status.css";

export function CanvasSyncStatus({ projectId }: { projectId: string }) {
    const navigate = useNavigate();
    const copyDraft = () => {
        const store = useCanvasStore.getState();
        const project = store.openProject(projectId);
        if (!project) return;
        const id = store.importProject({ ...project, title: `${project.title}（恢复副本）` });
        if (project.timeline) store.updateProject(id, { timeline: project.timeline });
        navigate(`/canvas/${id}`);
    };
    const progress = useSyncProgressStore((state) => state.syncingProjects[projectId]);
    const [action, setAction] = useState("");
    const [notice, setNotice] = useState("");
    const phase = progress?.phase;
    const localError = progress?.localPhase === "error";
    const cloudPending = phase === "error" || Boolean(progress?.errorKind);
    const saving = phase === "pending" || phase === "saving" || phase === "uploading" || progress?.localPhase === "pending";
    const tone = localError ? "error" : cloudPending || saving ? "pending" : phase === "done" || progress?.localPhase === "saved" ? "done" : "idle";
    const label = localError ? "本地存储不可用，请导出当前草稿" : cloudPending ? "后台等待恢复，可继续编辑" : saving ? "正在同步画布" : phase === "done" ? "已同步" : progress?.localPhase === "saved" ? "已保存到本地" : "尚未同步";
    const run = async (kind: "retry" | "cloud") => {
        const scope = getActiveUserScope();
        setAction(kind);
        setNotice("");
        try {
            if (kind === "cloud") await restoreCanvasCloudVersion(projectId);
            else await saveRemoteUserDataNow(projectId);
            if (scope === getActiveUserScope()) setNotice(kind === "cloud" ? "已采用云端版本，本地草稿已保留恢复副本" : "云端保存已确认");
        } catch (error) {
            if (scope === getActiveUserScope()) setNotice(error instanceof Error ? `${error.message}。可继续编辑或导出草稿。` : "暂未收到确认，可继续编辑或导出草稿。");
        } finally {
            setAction("");
        }
    };
    const exportDraft = () => {
        try {
            const blob = new Blob([JSON.stringify(canvasRecoveryExport(projectId), null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `canvas-recovery-${projectId}.json`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1_000);
            setNotice("已导出画布快照及未落盘恢复副本；媒体仅包含引用，请保留当前浏览器数据。");
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "导出未完成，请保留当前页面");
        }
    };
    const content = (
        <div className="flex max-w-80 flex-col gap-3" data-canvas-no-zoom data-canvas-wheel-scroll>
            <div role="status">{label}</div>
            <p className="text-xs">画布可继续编辑。采用云端版本会替换当前画布，原草稿先保留恢复副本；本地存储不可用时请及时导出。</p>
            <div className="flex flex-wrap gap-2">
                <Button size="small" loading={action === "retry"} disabled={Boolean(action)} onClick={() => void run("retry")}>
                    立即重连
                </Button>
                <Button size="small" loading={action === "cloud"} disabled={Boolean(action)} onClick={() => void run("cloud")}>
                    采用云端版本
                </Button>
                <Button size="small" onClick={exportDraft}>
                    导出草稿
                </Button>
                <Button size="small" onClick={copyDraft}>
                    另存新画布
                </Button>
            </div>
            {notice ? (
                <p role="status" className="text-xs">
                    {notice}
                </p>
            ) : null}
        </div>
    );
    return (
        <Popover trigger="click" content={content}>
            <button type="button" className={`canvas-sync-status-trigger canvas-sync-status-trigger--${tone} inline-flex size-8 items-center justify-center rounded-full`} aria-label={label} title={label} data-canvas-no-zoom>
                {saving || cloudPending || localError ? <LoaderCircle className={`size-4 ${saving && !cloudPending ? "animate-spin motion-reduce:animate-none" : ""}`} /> : <CloudCheck className="size-4" />}
            </button>
        </Popover>
    );
}
