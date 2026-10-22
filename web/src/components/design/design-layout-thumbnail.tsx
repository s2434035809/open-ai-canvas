/**
 * 版式方案的缩略预览。
 *
 * 用纯 DOM 画一个等比缩小的小样：不引画布引擎，也不用截图 ——
 * 用户只需要判断「这个构图和我想要的是不是一回事」，几十个矩形足够。
 */

import type { DesignLayoutElement, DesignLayoutOption } from "@/lib/design/agent";
import type { DesignElement } from "@/lib/design/contracts";

type PreviewPage = { width: number; height: number; elements: readonly unknown[] };

const THUMB_WIDTH = 240;

export function DesignLayoutThumbnail({ option, page }: { option: DesignLayoutOption; page: PreviewPage }) {
    const ratio = page.height / Math.max(1, page.width);
    const height = Math.round(THUMB_WIDTH * ratio);
    const scale = THUMB_WIDTH / Math.max(1, page.width);

    // 方案里既有「改既有元素」也有「新增文本」，两类都要画出来。
    const existing = new Map<string, DesignElement>();
    for (const element of page.elements) {
        const candidate = element as DesignElement;
        if (candidate && typeof candidate.id === "string") existing.set(candidate.id, candidate);
    }

    return (
        <div className="relative overflow-hidden rounded border border-white/10 bg-white" style={{ width: "100%", aspectRatio: `${page.width} / ${page.height}` }}>
            {option.elements.map((entry, index) => {
                const box = resolveBox(entry, existing.get(entry.elementId ?? ""));
                if (!box) return null;
                const isText = entry.kind === "text" || (!entry.elementId && entry.text);
                return (
                    <div
                        key={`${entry.elementId ?? "new"}-${index}`}
                        className="absolute overflow-hidden"
                        style={{
                            left: box.x * scale,
                            top: box.y * scale,
                            width: Math.max(1, box.width * scale),
                            height: Math.max(1, box.height * scale),
                            background: isText ? "transparent" : "#cbd5e1",
                            border: isText ? "none" : "1px solid rgba(15,23,42,0.12)",
                            borderRadius: 0,
                        }}
                    >
                        {isText && entry.text ? (
                            <span
                                style={{
                                    display: "block",
                                    fontSize: Math.max(4, (entry.fontSize ?? 24) * scale),
                                    lineHeight: 1.2,
                                    fontWeight: entry.role === "title" ? 700 : 400,
                                    color: entry.color ?? "#1f2328",
                                    textAlign: (entry.align ?? "left") as "left" | "center" | "right",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                {entry.text}
                            </span>
                        ) : null}
                    </div>
                );
            })}
            <span className="pointer-events-none absolute inset-0" style={{ height }} />
        </div>
    );
}

function resolveBox(entry: DesignLayoutElement, source: DesignElement | undefined): { x: number; y: number; width: number; height: number } | null {
    const x = entry.x ?? source?.x;
    const y = entry.y ?? source?.y;
    const width = entry.width ?? source?.width;
    const height = entry.height ?? source?.height;
    if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") return null;
    return { x, y, width, height };
}

export type { DesignLayoutOption };
