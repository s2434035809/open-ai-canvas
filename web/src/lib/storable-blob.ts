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
