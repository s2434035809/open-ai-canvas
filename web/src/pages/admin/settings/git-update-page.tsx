import { App, Button, Skeleton, Tag } from "antd";
import { AlertTriangle, ArrowDownToLine, CheckCircle2, GitBranch, GitMerge, RefreshCw, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { applyGitUpdate, checkGitUpdate, getGitUpdateStatus, type GitUpdatePhase, type GitUpdateStatus } from "@/services/api/git-update";
import { AdminPageFrame } from "../components/admin-shell";
import { AdminStatusBadge, SettingsSectionCard } from "../components/admin-ui";

const busyPhases = new Set<GitUpdatePhase>(["checking", "merging"]);

const phaseLabels: Record<GitUpdatePhase, string> = {
    idle: "尚未检查",
    checking: "检查与预演中",
    ready: "预演通过，可应用",
    no_update: "已是最新",
    blocked: "存在阻塞项",
    merging: "正在合并",
    failed: "失败",
    succeeded: "已合并",
};

const phaseTones: Record<GitUpdatePhase, "success" | "warning" | "error" | "neutral"> = {
    idle: "neutral",
    checking: "warning",
    ready: "success",
    no_update: "neutral",
    blocked: "warning",
    merging: "warning",
    failed: "error",
    succeeded: "success",
};

function formatTime(value?: string) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", { hour12: false });
}

// 后端 Go 的空切片在某些情况下会序列化成 null，这里统一兜底，
// 避免页面因为读取 null.length 直接白屏。
function normalizeStatus(next: GitUpdateStatus): GitUpdateStatus {
    return {
        ...next,
        merge: {
            ...next.merge,
            files: next.merge?.files ?? [],
            conflictFiles: next.merge?.conflictFiles ?? [],
        },
        commits: next.commits ?? [],
        dirty: next.dirty ?? [],
        untracked: next.untracked ?? [],
        checks: next.checks ?? [],
        logs: next.logs ?? [],
    };
}

export default function GitUpdatePage() {
    const { message, modal } = App.useApp();
    const [status, setStatus] = useState<GitUpdateStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [checking, setChecking] = useState(false);
    const [applying, setApplying] = useState(false);
    const [loadError, setLoadError] = useState("");
    const mountedRef = useRef(true);

    const load = useCallback(async (initial = false) => {
        if (initial) setLoading(true);
        try {
            const next = await getGitUpdateStatus();
            if (!mountedRef.current) return;
            setStatus(normalizeStatus(next));
            setLoadError("");
        } catch (error) {
            if (!mountedRef.current) return;
            setLoadError(error instanceof Error ? error.message : "读取更新状态失败");
        } finally {
            if (mountedRef.current && initial) setLoading(false);
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        void load(true);
        return () => {
            mountedRef.current = false;
        };
    }, [load]);

    useEffect(() => {
        if (!status || !busyPhases.has(status.phase)) return;
        const timer = window.setInterval(() => void load(false), 2000);
        return () => window.clearInterval(timer);
    }, [load, status]);

    const busy = Boolean(status && busyPhases.has(status.phase));
    const blockers = status?.checks.filter((check) => check.blocking && check.status === "failed") ?? [];
    const canApply = Boolean(status && status.enabled && status.phase === "ready" && status.mergeable && blockers.length === 0);

    const requestCheck = async () => {
        setChecking(true);
        try {
            const next = await checkGitUpdate();
            setStatus(normalizeStatus(next));
            if (!next.updateAvailable) {
                message.success("dev 已包含上游全部提交");
            } else if (next.phase === "blocked") {
                message.warning("预演发现阻塞项，未改动 dev");
            } else {
                message.success(`预演通过，可合并 ${next.merge.incomingCommits} 个上游提交`);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "检查失败");
            await load(false);
        } finally {
            setChecking(false);
        }
    };

    const requestApply = () => {
        if (!status) return;
        modal.confirm({
            title: `合并 ${status.merge.upstreamRef} 到 ${status.branch}？`,
            width: 600,
            content: (
                <div className="space-y-3 text-sm text-foreground/70">
                    <p>
                        将把 <strong>{status.merge.incomingCommits}</strong> 个提交合并进 <code>{status.branch}</code>，涉及 <strong>{status.merge.files.length}</strong> 个文件。
                    </p>
                    <p>合并后容器内的 air 会自动重新编译并热重载。你的未跟踪文件与未提交改动不会被删除，但若与上游同文件冲突，合并在检查阶段就会被拦下。</p>
                    <p>
                        二次确认：当前本地提交为 <code>{status.localHead}</code>，将以此作为预期值提交。
                    </p>
                </div>
            ),
            okText: "确认合并",
            cancelText: "取消",
            onOk: async () => {
                setApplying(true);
                try {
                    const next = await applyGitUpdate(status.localHead);
                    setStatus(normalizeStatus(next));
                    message.success(`已合并到 ${next.branch}（${next.localHead}）`);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "合并失败");
                    throw error;
                } finally {
                    setApplying(false);
                }
            },
        });
    };

    if (loading) {
        return (
            <AdminPageFrame title="源码更新" description="把上游 main 安全合并进开发分支 dev。" scroll>
                <div className="admin-settings-stack"><Skeleton active paragraph={{ rows: 12 }} /></div>
            </AdminPageFrame>
        );
    }

    return (
        <AdminPageFrame
            title="源码更新"
            description="检查上游 main → 冲突预演 → 构建验证 → 合并进 dev，全程不触碰未跟踪文件。"
            scroll
            actions={
                <Button icon={<RefreshCw className="size-4" />} loading={checking} disabled={busy || !status?.enabled} onClick={() => void requestCheck()}>
                    检查上游
                </Button>
            }
        >
            <div className="admin-settings-stack">
                {loadError && !status ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{loadError}</div>
                ) : null}

                {status && !status.enabled ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                        当前部署未开启源码更新。请在开发环境设置 <code>CANVAS_GIT_UPDATE_ENABLED=true</code>，并确保容器挂载了仓库与 git。
                    </div>
                ) : null}

                {status?.error ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                        <div className="mb-1 font-medium">上次操作失败</div>
                        <div className="whitespace-pre-wrap break-words">{status.error}</div>
                    </div>
                ) : null}

                {status?.fetchError ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                        <div className="mb-1 font-medium">拉取上游失败</div>
                        <div className="whitespace-pre-wrap break-words">{status.fetchError}</div>
                    </div>
                ) : null}

                <div className="grid gap-4 lg:grid-cols-2">
                    <SettingsSectionCard
                        layout="stacked"
                        icon={<GitBranch className="size-4" />}
                        title="分支与版本"
                        description={`当前分支 ${status?.branch || "dev"}，上游 ${status?.merge.upstreamRef || "upstream/main"}`}
                        status={<AdminStatusBadge label={phaseLabels[status?.phase || "idle"]} tone={phaseTones[status?.phase || "idle"]} />}
                        footer={<span className="text-xs text-foreground/50">最近检查：{formatTime(status?.finishedAt)}</span>}
                    >
                        <dl className="grid grid-cols-2 gap-3 text-sm">
                            <div>
                                <dt className="text-foreground/50">本地提交</dt>
                                <dd className="font-mono">{status?.localHead || "--"}</dd>
                            </div>
                            <div>
                                <dt className="text-foreground/50">上游提交</dt>
                                <dd className="font-mono">{status?.upstreamHead || "--"}</dd>
                            </div>
                            <div>
                                <dt className="text-foreground/50">落后提交</dt>
                                <dd>{status?.merge.behind ?? 0}</dd>
                            </div>
                            <div>
                                <dt className="text-foreground/50">领先提交</dt>
                                <dd>{status?.merge.ahead ?? 0}</dd>
                            </div>
                        </dl>
                    </SettingsSectionCard>

                    <SettingsSectionCard
                        layout="stacked"
                        icon={<GitMerge className="size-4" />}
                        title="合并预演"
                        description="预演在临时 worktree 中执行，失败不会改动 dev"
                        status={status?.mergeable ? <AdminStatusBadge label="无冲突" tone="success" /> : <AdminStatusBadge label={status?.updateAvailable ? "待检查" : "无变更"} tone="neutral" />}
                        footer={
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-xs text-foreground/50">应用前必须通过冲突检测与编译验证</span>
                                <Button type="primary" icon={<ArrowDownToLine className="size-4" />} loading={applying} disabled={!canApply} onClick={requestApply}>
                                    合并到 {status?.branch || "dev"}
                                </Button>
                            </div>
                        }
                    >
                        <div className="space-y-2 text-sm">
                            <div className="flex flex-wrap gap-2">
                                {status?.checks.map((check) => (
                                    <Tag key={check.key} color={check.status === "passed" ? "green" : check.status === "failed" ? "red" : "gold"}>
                                        {check.label}：{check.status === "passed" ? "通过" : check.status === "failed" ? "阻塞" : "提示"}
                                    </Tag>
                                ))}
                                {!status?.checks.length ? <span className="text-foreground/50">尚未检查</span> : null}
                            </div>
                            {status?.merge.conflictFiles.length ? (
                                <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                                    <div className="mb-1 font-medium">冲突文件</div>
                                    <ul className="list-disc pl-4">
                                        {status.merge.conflictFiles.map((file) => (
                                            <li key={file} className="break-all">{file}</li>
                                        ))}
                                    </ul>
                                </div>
                            ) : null}
                            {status?.merge.files.length ? (
                                <details className="text-xs text-foreground/70">
                                    <summary className="cursor-pointer">涉及 {status.merge.files.length} 个文件</summary>
                                    <ul className="mt-1 max-h-40 list-disc overflow-auto pl-4">
                                        {status.merge.files.map((file) => (
                                            <li key={file} className="break-all font-mono">{file}</li>
                                        ))}
                                    </ul>
                                </details>
                            ) : null}
                        </div>
                    </SettingsSectionCard>
                </div>

                <SettingsSectionCard
                    layout="stacked"
                    icon={<CheckCircle2 className="size-4" />}
                    title="上游提交"
                    description={status?.updateAvailable ? `共 ${status.commits.length} 个待合并提交` : "没有需要合并的提交"}
                >
                    {status?.commits.length ? (
                        <ul className="divide-y divide-black/5 text-sm">
                            {status.commits.map((commit) => (
                                <li key={commit.hash} className="flex items-start gap-3 py-2">
                                    <code className="shrink-0 text-xs text-foreground/50">{commit.hash}</code>
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate">{commit.subject}</div>
                                        <div className="text-xs text-foreground/45">
                                            {commit.author} · {formatTime(commit.at)}
                                        </div>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-foreground/50">暂无待合并提交</p>
                    )}
                </SettingsSectionCard>

                {status?.dirty.length || status?.untracked.length ? (
                    <SettingsSectionCard
                        layout="stacked"
                        icon={<AlertTriangle className="size-4" />}
                        title="工作区状态"
                        description="这些内容不会被自动删除或 stash"
                    >
                        {status.dirty.length ? (
                            <div className="mb-3">
                                <div className="mb-1 text-xs font-medium text-foreground/60">未提交改动（{status.dirty.length}）</div>
                                <ul className="max-h-32 list-disc overflow-auto pl-5 text-xs font-mono">
                                    {status.dirty.map((file) => <li key={file} className="break-all">{file}</li>)}
                                </ul>
                            </div>
                        ) : null}
                        {status.untracked.length ? (
                            <div>
                                <div className="mb-1 text-xs font-medium text-foreground/60">未跟踪文件（{status.untracked.length}）</div>
                                <ul className="max-h-32 list-disc overflow-auto pl-5 text-xs font-mono">
                                    {status.untracked.map((file) => <li key={file} className="break-all">{file}</li>)}
                                </ul>
                            </div>
                        ) : null}
                    </SettingsSectionCard>
                ) : null}

                <SettingsSectionCard layout="stacked" icon={<Terminal className="size-4" />} title="执行日志" description="最近一次检查或合并的过程记录">
                    {status?.logs.length ? (
                        <ol className="space-y-2 text-sm">
                            {status.logs.map((entry, index) => (
                                <li key={`${entry.at}-${index}`} className="flex gap-3">
                                    <time className="shrink-0 text-xs text-foreground/40">{formatTime(entry.at)}</time>
                                    <span className="min-w-0 flex-1 break-words">{entry.message}</span>
                                </li>
                            ))}
                        </ol>
                    ) : (
                        <p className="text-sm text-foreground/50">暂无日志</p>
                    )}
                </SettingsSectionCard>
            </div>
        </AdminPageFrame>
    );
}
