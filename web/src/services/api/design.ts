import { http } from "@/services/api/request";
import type { DesignDocument } from "@/lib/design/contracts";

/**
 * 设计工作台的数据接口。
 *
 * 只依赖设计工作台自己的 `DesignDocument` 契约，不跨模块复用文档类型。
 */

export type DesignDocumentSummary = {
    id: string;
    title: string;
    description: string;
    coverUrl: string;
    pageCount: number;
    revision: number;
    createdAt: string;
    updatedAt: string;
};

export type DesignDocumentView = DesignDocumentSummary & {
    doc: DesignDocument;
};

export type SaveDesignDocumentInput = {
    title: string;
    description: string;
    coverUrl: string;
    pageCount: number;
    doc: DesignDocument;
};

export function listDesignDocuments(signal?: AbortSignal) {
    return http.get<{ items: DesignDocumentSummary[] }>("/design/documents", { signal });
}

export function getDesignDocument(id: string, signal?: AbortSignal) {
    return http.get<DesignDocumentView>(`/design/documents/${encodeURIComponent(id)}`, { signal });
}

export function createDesignDocument(input: SaveDesignDocumentInput) {
    return http.post<DesignDocumentView>("/design/documents", input);
}

export function saveDesignDocument(id: string, input: SaveDesignDocumentInput) {
    return http.put<DesignDocumentView>(`/design/documents/${encodeURIComponent(id)}`, input);
}

export function deleteDesignDocument(id: string) {
    return http.delete<{ id: string }>(`/design/documents/${encodeURIComponent(id)}`);
}
