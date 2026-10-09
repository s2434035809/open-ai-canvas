// 用户数据同步前的媒体上行：把本地存储键、内联 data URL 上传成资源引用，再写入远端。
//
// 同一份内联数据按内容摘要去重上传；上传失败时整批同步失败并进入重试，不写入半成品。

import { resourceFileUrl, resourceIdFromStorageKey, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { getImageBlob } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import { toBlobOrNull } from "@/lib/storable-blob";

export function numberValue(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

export const LOCAL_STORAGE_KEY_PATTERN = /^(image|video|audio|file|video-reference|audio-reference):/;

export type ResourceKind = "image" | "video" | "audio" | "file";


export function resourceKindFromMime(type: unknown): ResourceKind {
    if (typeof type !== "string") return "file";
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    return "file";
}

/**
 * 本机媒体库内容不可用时抛出：既可能是 localforage 拍平过的脏记录，也可能是 DX OS
 * 沙箱里被清空的可丢失缓存。两种情况重传都不可能成功，调用方应跳过这一条而不是整批失败。
 */
export class UnreadableLocalMediaError extends Error {
    readonly storageKey: string;

    constructor(storageKey: string) {
        super(`本地媒体不可用（内容已丢失或不存在），无法同步：${storageKey}`);
        this.name = "UnreadableLocalMediaError";
        this.storageKey = storageKey;
    }
}

export function collectLocalMediaKeys(value: unknown, set = new Set<string>()): string[] {
    if (!value || typeof value !== "object") return [...set];
    if (Array.isArray(value)) {
        for (const item of value) collectLocalMediaKeys(item, set);
        return [...set];
    }
    const record = value as Record<string, unknown>;
    const storageKey = typeof record.storageKey === "string" ? record.storageKey : "";
    if (isLocalStorageKey(storageKey) && !resourceIdFromStorageKey(storageKey)) {
        set.add(storageKey);
    } else {
        const inline = inlineMediaDataUrl(record);
        if (inline) set.add(`${inline.length}:${inline.slice(0, 64)}:${inline.slice(-64)}`);
    }
    for (const child of Object.values(record)) {
        collectLocalMediaKeys(child, set);
    }
    return [...set];
}

export async function ensureRemoteResourceReferences<T>(value: T, uploaded = new Map<string, string>(), onUploaded?: () => void): Promise<T> {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        const result: unknown[] = [];
        for (const item of value) result.push(await ensureRemoteResourceReferences(item, uploaded, onUploaded));
        return result as T;
    }

    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        next[key] = await ensureRemoteResourceReferences(child, uploaded, onUploaded);
    }

    const storageKey = typeof next.storageKey === "string" ? next.storageKey : "";
    const remoteResourceId = resourceIdFromStorageKey(storageKey);
    if (remoteResourceId) return applyResourceReference(next, storageKey) as T;

    if (!isLocalStorageKey(storageKey)) {
        const inline = inlineMediaDataUrl(next);
        if (!inline) return next as T;
        const identity = await inlineMediaUploadIdentity(inline);
        const cached = uploaded.get(identity);
        if (cached) return applyResourceReference(next, cached) as T;
        const resourceStorage = await uploadInlineDataUrl(inline, identity);
        uploaded.set(identity, resourceStorage);
        onUploaded?.();
        return applyResourceReference(next, resourceStorage) as T;
    }

    const cached = uploaded.get(storageKey);
    if (cached) return applyResourceReference(next, cached) as T;
    let resourceStorage: string;
    try {
        resourceStorage = await uploadLocalStorageKey(storageKey, next);
    } catch (error) {
        // 内容已经读不出来的本地媒体重传也不会成功；跳过这一条但保留原引用，
        // 否则整批用户数据（画布保存、Agent 提交）会被一条坏记录永久卡死。
        if (!(error instanceof UnreadableLocalMediaError)) throw error;
        console.warn("本地媒体不可用，已跳过同步", { storageKey });
        return next as T;
    }
    uploaded.set(storageKey, resourceStorage);
    onUploaded?.();
    return applyResourceReference(next, resourceStorage) as T;
}

export function applyResourceReference(payload: Record<string, unknown>, storageKey: string) {
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (!resourceId) {
        throw new Error(`远端资源引用无效：${storageKey}`);
    }
    const url = resourceFileUrl(resourceId);
    payload.storageKey = storageKey;
    for (const key of ["content", "dataUrl", "url", "coverUrl"]) {
        if (typeof payload[key] === "string") payload[key] = url;
    }
    return payload;
}

export function inlineMediaDataUrl(payload: Record<string, unknown>) {
    for (const key of ["dataUrl", "content", "url", "coverUrl"]) {
        const value = payload[key];
        if (typeof value === "string" && /^data:(image|video|audio)\//i.test(value)) return value;
    }
    return "";
}

export async function uploadInlineDataUrl(dataUrl: string, identity: string) {
    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error("内嵌媒体读取失败");
    const blob = await response.blob();
    const resource = await uploadResourceFile(blob, resourceKindFromMime(blob.type), { idempotencyKey: identity });
    return resourceStorageKey(resource.id);
}

export async function inlineMediaUploadIdentity(dataUrl: string) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(dataUrl));
    return `inline:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function uploadLocalStorageKey(storageKey: string, payload: Record<string, unknown>) {
    const stored = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
    // 本机媒体库不是主数据源（DX OS 规范里 localStorage/IndexedDB 只允许存可丢失的缓存）：
    // 内容被清空和内容被拍平一样，都重传不可能成功，按同一种"不可用"处理而不是抛裸 Error 卡死整批同步。
    const blob = toBlobOrNull(stored);
    if (!blob) throw new UnreadableLocalMediaError(storageKey);
    const resource = await uploadResourceFile(blob, resourceKindFromMime(blob.type), {
        width: numberValue(payload.naturalWidth) || numberValue(payload.width),
        height: numberValue(payload.naturalHeight) || numberValue(payload.height),
        durationMs: numberValue(payload.durationMs),
        idempotencyKey: storageKey,
    });
    return resourceStorageKey(resource.id);
}

export function isLocalStorageKey(value: string) {
    return LOCAL_STORAGE_KEY_PATTERN.test(value) && !resourceIdFromStorageKey(value);
}
