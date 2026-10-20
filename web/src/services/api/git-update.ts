import { http } from "./request";

export type GitUpdatePhase = "idle" | "checking" | "ready" | "no_update" | "blocked" | "merging" | "failed" | "succeeded";

export type GitUpdateCommit = {
    hash: string;
    subject: string;
    author: string;
    at: string;
};

export type GitUpdateCheck = {
    key: string;
    label: string;
    status: "passed" | "pending" | "failed" | string;
    detail?: string;
    blocking: boolean;
};

export type GitUpdateMerge = {
    branch: string;
    upstreamRef: string;
    localHead: string;
    upstreamHead: string;
    behind: number;
    ahead: number;
    incomingCommits: number;
    files: string[];
    conflictFiles: string[];
    previewOk: boolean;
    buildOk: boolean;
    testOk: boolean;
};

export type GitUpdateLog = {
    at: string;
    phase: GitUpdatePhase;
    message: string;
};

export type GitUpdateStatus = {
    enabled: boolean;
    repository: string;
    branch: string;
    fetchError?: string;
    localHead: string;
    upstreamHead: string;
    updateAvailable: boolean;
    mergeable: boolean;
    merge: GitUpdateMerge;
    commits: GitUpdateCommit[];
    dirty: string[];
    untracked: string[];
    checks: GitUpdateCheck[];
    phase: GitUpdatePhase;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
    logs: GitUpdateLog[];
};

export function getGitUpdateStatus(signal?: AbortSignal) {
    return http.get<GitUpdateStatus>("/admin/git-update", { signal });
}

export function checkGitUpdate() {
    return http.post<GitUpdateStatus>("/admin/git-update/check");
}

export function applyGitUpdate(expectedCommit: string) {
    return http.post<GitUpdateStatus>("/admin/git-update/apply", { expectedCommit });
}
