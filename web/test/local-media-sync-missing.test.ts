// DX OS 的沙箱里 localStorage/IndexedDB 只是可丢失的缓存：本机媒体库的内容可能被清空，
// 也可能被 localforage 拍平成 {}（File 的 toStringTag 是 [object File]，不走 Blob 序列化）。
// 这两种情况下重传都不可能成功，同步必须只跳过这一条，不能让整批用户数据永久卡死。
import { describe, expect, mock, test } from "bun:test";

const state: { stored: unknown } = { stored: null };

mock.module("@/services/image-storage", () => ({
    getImageBlob: async () => state.stored,
}));
mock.module("@/services/file-storage", () => ({
    getMediaBlob: async () => state.stored,
}));

const { UnreadableLocalMediaError, ensureRemoteResourceReferences, uploadLocalStorageKey } = await import("@/services/user-data-sync-media");

describe("本机媒体不可用时的同步行为", () => {
    test("内容被拍平成 {} 的记录抛 UnreadableLocalMediaError", async () => {
        state.stored = {};
        await expect(uploadLocalStorageKey("image:u1:flat", {})).rejects.toBeInstanceOf(UnreadableLocalMediaError);
    });

    test("内容被清空（取回 null）时同样按不可用处理，不再抛裸 Error", async () => {
        state.stored = null;
        const error = await uploadLocalStorageKey("image:u1:gone", {}).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(UnreadableLocalMediaError);
        expect((error as InstanceType<typeof UnreadableLocalMediaError>).storageKey).toBe("image:u1:gone");
    });

    test("Agent 提交/画布保存遇到不可用媒体时跳过该条并保留原引用", async () => {
        state.stored = null;
        const payload = { storageKey: "image:u1:gone", content: "blob:preview", width: 1024 };
        const result = await ensureRemoteResourceReferences(payload);
        expect(result).toEqual(payload);
    });
});
