import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { toStorableBlob } from "@/lib/storable-blob";
import { resourceKindFromMime, UnreadableLocalMediaError } from "@/services/user-data-sync-media";

const readSource = (relative: string) => readFileSync(resolve(import.meta.dir, "../src", relative), "utf8");

// localforage 的 localStorage 驱动按 Object.prototype.toString 判断类型，只还原 [object Blob]。
// File 是 Blob 的子类但标签是 [object File]，会被 JSON 拍平成 {}，取回来没有 type 也没有内容，
// 云端同步读本地媒体时就会抛 "Cannot read properties of undefined (reading 'startsWith')"。
// 浏览器里 File 的标签是 [object File]；Bun 的 File 与 Blob 同为 [object Blob]，
// 这里用带自定义标签的子类还原浏览器行为，保证测试不依赖运行环境。
class FileTaggedBlob extends Blob {
    get [Symbol.toStringTag]() {
        return "File";
    }
}

describe("本地媒体库写入前收敛 File", () => {
    test("非 [object Blob] 标签的值会转成普通 Blob，并保留 MIME 类型与字节", () => {
        const file = new FileTaggedBlob([new Uint8Array([1, 2, 3])], { type: "image/png" });
        expect(Object.prototype.toString.call(file)).toBe("[object File]");
        const stored = toStorableBlob(file);
        expect(Object.prototype.toString.call(stored)).toBe("[object Blob]");
        expect(stored.type).toBe("image/png");
        expect(stored.size).toBe(3);
    });

    test("普通 Blob 原样返回，不额外复制", () => {
        const blob = new Blob([new Uint8Array([1])], { type: "image/jpeg" });
        expect(Object.prototype.toString.call(blob)).toBe("[object Blob]");
        expect(toStorableBlob(blob)).toBe(blob);
    });

    test("没有类型时给出兜底 MIME", () => {
        expect(toStorableBlob(new FileTaggedBlob([new Uint8Array([1])])).type).toBe("application/octet-stream");
    });
});

describe("本地媒体写入口全部经过 toStorableBlob", () => {
    for (const relative of ["services/image-storage.ts", "services/file-storage.ts"]) {
        test(relative, () => {
            const source = readSource(relative);
            expect(source).not.toMatch(/store\.setItem\(\s*storageKey\s*,\s*blob\s*\)/);
            expect(source).toContain("store.setItem(storageKey, toStorableBlob(blob))");
        });
    }

    test("services/resource-blob-cache.ts", () => {
        expect(readSource("services/resource-blob-cache.ts")).toContain("blobStore.setItem(target.key, toStorableBlob(blob))");
    });
});

describe("损坏的本地媒体不再产生 TypeError", () => {
    test("MIME 缺失或非字符串时退化为 file", () => {
        expect(resourceKindFromMime("image/png")).toBe("image");
        expect(resourceKindFromMime("video/mp4")).toBe("video");
        expect(resourceKindFromMime("audio/mpeg")).toBe("audio");
        expect(resourceKindFromMime("application/pdf")).toBe("file");
        expect(resourceKindFromMime(undefined)).toBe("file");
    });

    test("损坏错误带 storageKey，文案里不再出现裸 JS 异常", () => {
        const error = new UnreadableLocalMediaError("image:u1:abc");
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("UnreadableLocalMediaError");
        expect(error.storageKey).toBe("image:u1:abc");
        expect(error.message).toBe("本地媒体不可用（内容已丢失或不存在），无法同步：image:u1:abc");
    });

    test("同步遇到损坏媒体时跳过这一条，而不是让整批保存失败", () => {
        expect(readSource("services/user-data-sync-media.ts")).toContain("error instanceof UnreadableLocalMediaError");
    });
});
