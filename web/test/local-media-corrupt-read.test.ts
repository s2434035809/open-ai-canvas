// 本机媒体库不是主数据源：localforage 的序列化器按 Object.prototype.toString 判断类型，
// 只把 [object Blob] 走二进制分支；File 的标签是 [object File]，会落到 JSON.stringify 被拍平成 {}，
// 读回来既没有 type 也没有内容。展示路径会把 undefined 交给 URL.createObjectURL，
// Agent 参考图路径会把 undefined 当 MIME 类型用——改之前这里抛
// "Cannot read properties of undefined (reading 'startsWith')"，把整次提交打断。
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { toBlobOrNull } from "@/lib/storable-blob";

// 脏记录的真实读回放在独立进程里验（见 helpers/corrupt-media-probe.ts 的说明）。
const runProbe = () => {
    const probe = Bun.spawnSync(["bun", "run", resolve(import.meta.dir, "helpers/corrupt-media-probe.ts")], {
        cwd: resolve(import.meta.dir, ".."),
        stderr: "pipe",
    });
    if (probe.exitCode !== 0) throw new Error(`探针进程失败(${probe.exitCode})：${probe.stderr.toString()}`);
    return JSON.parse(probe.stdout.toString());
};

describe("本地媒体脏记录的读侧收敛", () => {
    test("toBlobOrNull 放行真实 Blob，拒绝被拍平的 {}、缺字节的对象和非对象", () => {
        const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
        expect(toBlobOrNull(blob)).toBe(blob);
        expect(toBlobOrNull({})).toBeNull();
        expect(toBlobOrNull(null)).toBeNull();
        expect(toBlobOrNull(undefined)).toBeNull();
        expect(toBlobOrNull("image/png")).toBeNull();
        expect(toBlobOrNull({ size: 3, type: "image/png" })).toBeNull();
    });

    test("真实落库的脏记录：读回是 {}，但展示与 Agent 参考图都按内容不可用回退", () => {
        const result = runProbe();
        // 先确认这个探针真的复现了线上落库语义，否则后面的断言没有意义。
        expect(result.flatStoredAsEmptyJson).toBe(true);
        expect(result.flatReadBack).toEqual({});

        expect(result.flatBlob).toBeNull();
        expect(result.resolveFallback).toBe("/fallback.png");
        expect(result.emptyFallback).toBe("");
        expect(result.inlineFallback).toBe("data:image/png;base64,AAAA");
    });

    test("同一份存储里的正常图片不受影响", () => {
        expect(runProbe().goodBlob).toEqual({ isBlob: true, type: "image/png", size: 3 });
    });
});
