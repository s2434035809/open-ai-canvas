import { http } from "@/services/api/request";
import type { PortfolioDocument } from "@/lib/portfolio/contracts";

export type PortfolioDocumentSummary = {
    id: string;
    title: string;
    description: string;
    coverUrl: string;
    pageCount: number;
    revision: number;
    createdAt: string;
    updatedAt: string;
};

export type PortfolioDocumentView = PortfolioDocumentSummary & {
    doc: PortfolioDocument;
};

export type SavePortfolioDocumentInput = {
    title: string;
    description: string;
    coverUrl: string;
    pageCount: number;
    doc: PortfolioDocument;
};

export function listPortfolioDocuments(signal?: AbortSignal) {
    return http.get<{ items: PortfolioDocumentSummary[] }>("/portfolio/documents", { signal });
}

export function getPortfolioDocument(id: string, signal?: AbortSignal) {
    return http.get<PortfolioDocumentView>(`/portfolio/documents/${encodeURIComponent(id)}`, { signal });
}

export function createPortfolioDocument(input: SavePortfolioDocumentInput) {
    return http.post<PortfolioDocumentView>("/portfolio/documents", input);
}

export function savePortfolioDocument(id: string, input: SavePortfolioDocumentInput) {
    return http.put<PortfolioDocumentView>(`/portfolio/documents/${encodeURIComponent(id)}`, input);
}

export function deletePortfolioDocument(id: string) {
    return http.delete<{ id: string }>(`/portfolio/documents/${encodeURIComponent(id)}`);
}
