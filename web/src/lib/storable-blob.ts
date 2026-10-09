/**
 * localforage 的序列化器按 `Object.prototype.toString` 判断类型，只识别 `[object Blob]`；
 * `File` 是 Blob 的子类但标签是 `[object File]`，会落到 JSON 分支被拍平成 `{}`，
 * 取回来既没有 `type` 也没有内容，云端同步读本地媒体时就抛 `Cannot read properties of undefined`。
 * 所有写进本地媒体库的值都先经过这里，统一收敛成普通 Blob。
 */
export function toStorableBlob(value: Blob): Blob {
    if (typeof Blob === "undefined" || !(value instanceof Blob)) return value;
    if (Object.prototype.toString.call(value) === "[object Blob]") return value;
    return new Blob([value], { type: value.type || "application/octet-stream" });
}

/**
 * 与 toStorableBlob 成对的读侧收敛。存进去的值不一定还原得回来：被拍平成 {} 的脏记录、
 * 被清空的可丢失缓存、以及跨 realm 传回来的 Blob（宿主页面与沙箱 iframe 之间过不了
 * instanceof）都会走到这里。能还原成 Blob 就还原，还原不了返回 null，
 * 让展示、同步、Agent 参考图这些调用方按"媒体内容不可用"处理，
 * 而不是各自假设对方一定带着 type 和字节。
 */
export function toBlobOrNull(value: unknown, fallbackType = ""): Blob | null {
    if (typeof Blob === "undefined" || value === null || value === undefined) return null;
    if (value instanceof Blob) return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return new Blob([value as BlobPart], { type: fallbackType });
    if (typeof value !== "object") return null;
    const candidate = value as { arrayBuffer?: unknown; size?: unknown; type?: unknown };
    // 跨 realm 的 Blob 只能按能力判断；被 JSON 拍平过的 {} 既没有 arrayBuffer 也没有 size。
    if (typeof candidate.arrayBuffer === "function" && typeof candidate.size === "number") {
        return new Blob([value as BlobPart], { type: typeof candidate.type === "string" ? candidate.type : fallbackType });
    }
    return null;
}
