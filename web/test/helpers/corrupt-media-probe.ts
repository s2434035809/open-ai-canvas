// 由 test/local-media-corrupt-read.test.ts 在独立进程里运行。
// localforage 的 DriverSupport 在模块加载时只算一次，往同一个进程里补 localStorage 已经太晚，
// 所以"脏记录读回来到底长什么样"必须在干净进程里验，否则结果依赖测试文件的执行顺序。
//
// 这里不打桩：用同一套 localforage（真序列化器 + localStorage 驱动）写入脏值；
// 浏览器外的 Bun 没有 localStorage / FileReader，补最小的内存实现。
const backing = new Map<string, string>();

class MemoryStorage {
    get length() {
        return backing.size;
    }
    key(index: number) {
        return [...backing.keys()][index] ?? null;
    }
    getItem(key: string) {
        return backing.has(key) ? (backing.get(key) as string) : null;
    }
    setItem(key: string, value: string) {
        backing.set(key, String(value));
    }
    removeItem(key: string) {
        backing.delete(key);
    }
    clear() {
        backing.clear();
    }
}

class MemoryFileReader {
    onload: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    result: ArrayBuffer | null = null;
    readAsArrayBuffer(blob: Blob) {
        blob.arrayBuffer().then(
            (buffer) => {
                this.result = buffer;
                this.onload?.();
            },
            (error) => this.onerror?.(error),
        );
    }
}

Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
Object.defineProperty(globalThis, "FileReader", { value: MemoryFileReader, configurable: true });

// 浏览器里 File 的 toStringTag 是 [object File]；Bun 的 File 与 Blob 同为 [object Blob]，
// 用带自定义标签的子类还原浏览器行为。
class FileTaggedBlob extends Blob {
    get [Symbol.toStringTag]() {
        return "File";
    }
}

const localforage = (await import("localforage")).default;
const { getImageBlob, imageToDataUrl, resolveImageUrl } = await import("@/services/image-storage");

// 与 image-storage 内部实例同名同 store，落到同一份存储上。
const store = localforage.createInstance({ name: "yingce", storeName: "image_files" });
await store.setItem("image:u1:flat", new FileTaggedBlob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
await store.setItem("image:u1:good", new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" }));

const good = await getImageBlob("image:u1:good");

console.log(
    JSON.stringify({
        flatStoredAsEmptyJson: [...backing.values()].includes("{}"),
        flatReadBack: await store.getItem("image:u1:flat"),
        flatBlob: await getImageBlob("image:u1:flat"),
        resolveFallback: await resolveImageUrl("image:u1:flat", "/fallback.png"),
        inlineFallback: await imageToDataUrl({ storageKey: "image:u1:flat", dataUrl: "data:image/png;base64,AAAA" }),
        emptyFallback: await imageToDataUrl({ storageKey: "image:u1:flat" }),
        goodBlob: good ? { isBlob: good instanceof Blob, type: good.type, size: good.size } : null,
    }),
);
