/**
 * 本地图片导入。
 *
 * 分两步：先读成 data URL 让画布立刻有东西可渲染，再异步上传到宿主资源存储换取稳定
 * 引用。上传失败不阻断编辑，文档继续用内嵌 data URL——只是体积更大，功能不受影响。
 */

import { resourceFileUrl, uploadResourceFile } from "@/services/api/resources";

export type LocalImage = {
    fileName: string;
    dataUrl: string;
    width: number;
    height: number;
    bytes: number;
};

export function readAsDataUrl(file: Blob): Promise<string | null> {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}

export function measureImage(url: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0 });
        image.onerror = () => resolve({ width: 0, height: 0 });
        image.src = url;
    });
}

export async function readLocalImage(file: File): Promise<LocalImage | null> {
    if (!file.type.startsWith("image/")) return null;
    const dataUrl = await readAsDataUrl(file);
    if (!dataUrl) return null;
    const size = await measureImage(dataUrl);
    return { fileName: file.name, dataUrl, width: size.width, height: size.height, bytes: file.size };
}

/** 上传成功返回可长期引用的资源地址；失败返回 null，由调用方决定是否提示。 */
export async function uploadLocalImage(file: Blob, image: LocalImage): Promise<{ assetId: string; src: string } | null> {
    try {
        const resource = await uploadResourceFile(file, "image", { fileName: image.fileName, width: image.width, height: image.height });
        return { assetId: resource.id, src: resource.publicUrl || resourceFileUrl(resource.id) };
    } catch {
        return null;
    }
}

/** 从拖拽事件里取出图片文件；过滤掉 URL 拖拽等非文件内容。 */
export function imageFilesFromDataTransfer(transfer: DataTransfer | null): File[] {
    if (!transfer) return [];
    const fromFiles = Array.from(transfer.files || []);
    if (fromFiles.length > 0) return fromFiles.filter((file) => file.type.startsWith("image/"));
    return Array.from(transfer.items || [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file && file.type.startsWith("image/")));
}
