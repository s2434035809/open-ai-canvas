import { afterAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const dom = new Window({ url: "http://localhost/" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    SVGElement: dom.SVGElement,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createPortfolioDocument, createTextElement } = await import("../src/lib/portfolio/document");
const { createPortfolioStore, usePortfolioStore: useDefaultPortfolioStore } = await import("../src/lib/portfolio/store");
const { PortfolioStoreProvider, usePortfolioStore, usePortfolioStoreApi } = await import("../src/lib/portfolio/store-context");
type Store = ReturnType<typeof createPortfolioStore>;

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function documentWithText(title: string) {
    const document = createPortfolioDocument(title);
    document.pages[0].elements = [createTextElement({ text: title, x: 10, y: 10, width: 200, height: 40, zIndex: 1 })];
    return document;
}

function Title() {
    return createElement(
        "span",
        null,
        usePortfolioStore((state) => state.document?.title ?? "(empty)"),
    );
}

function ApiProbe({ onApi }: { onApi: (store: Store) => void }) {
    onApi(usePortfolioStoreApi());
    return null;
}

/**
 * 真 DOM 渲染（store 是外部状态，SSR 的 getServerSnapshot 拿不到之后写入的值）。
 * 渲染期异常既可能走 onUncaughtError，也可能被 act 透传上来，两路都收进 errors。
 */
async function render(element: ReactElement) {
    const host = document.createElement("div");
    document.body.append(host);
    const errors: Error[] = [];
    const root = createRoot(host, { onUncaughtError: (error) => errors.push(error as Error) });
    try {
        await act(async () => {
            root.render(element);
        });
    } catch (error) {
        errors.push(error as Error);
    }
    const text = host.textContent ?? "";
    try {
        await act(async () => {
            root.unmount();
        });
    } catch {
        // 渲染已经失败时卸载也可能抛，忽略：断言只需要 errors。
    }
    host.remove();
    return { text, errors };
}

describe("portfolio store factory", () => {
    test("returns a distinct instance on every call", () => {
        const first = createPortfolioStore();
        const second = createPortfolioStore();

        expect(first).not.toBe(second);
        expect(first.getState()).not.toBe(second.getState());
        // 默认导出是一个独立实例：它不该等于任何新建的会话。
        expect(useDefaultPortfolioStore).not.toBe(first);
        expect(useDefaultPortfolioStore.getState()).not.toBe(first.getState());
    });

    test("keeps document, history, dirty flag and viewport isolated between sessions", () => {
        const sessions = createPortfolioStore();
        const designs = createPortfolioStore();

        sessions.getState().loadDocument(documentWithText("作品集"));

        // 1. 文档隔离：另一个会话不该"顺手"拿到这份文档。
        expect(sessions.getState().document?.title).toBe("作品集");
        expect(designs.getState().document).toBeNull();

        // 2. 历史与脏标记隔离：A 的可撤销修改不能出现在 B 的撤销栈里。
        const elementId = sessions.getState().addText({ text: "新增标题" });
        expect(elementId).not.toBeNull();
        expect(sessions.getState().past.length).toBeGreaterThan(0);
        expect(sessions.getState().dirty).toBe(true);
        expect(designs.getState().past).toHaveLength(0);
        expect(designs.getState().future).toHaveLength(0);
        expect(designs.getState().dirty).toBe(false);
        expect(designs.getState().document).toBeNull();

        // 3. 视口隔离：A 的缩放/平移不影响 B。
        sessions.getState().setViewport({ zoom: 2.5, panX: 40, panY: -30 });
        expect(sessions.getState().viewport).toEqual({ zoom: 2.5, panX: 40, panY: -30 });
        expect(designs.getState().viewport).toEqual({ zoom: 1, panX: 0, panY: 0 });
    });

    test("undo in one session never rewrites the other", () => {
        const sessions = createPortfolioStore();
        const designs = createPortfolioStore();
        sessions.getState().loadDocument(documentWithText("作品集"));
        designs.getState().loadDocument(documentWithText("设计稿"));

        sessions.getState().addText({ text: "A" });
        sessions.getState().undo();

        expect(designs.getState().document?.title).toBe("设计稿");
        expect(designs.getState().past).toHaveLength(0);
        expect(designs.getState().dirty).toBe(false);
    });
});

describe("portfolio store context", () => {
    test("components read the instance injected by the provider, not the module default", async () => {
        const sessions = createPortfolioStore();
        const designs = createPortfolioStore();
        sessions.getState().loadDocument(documentWithText("作品集"));
        designs.getState().loadDocument(documentWithText("设计稿"));
        // 默认实例刻意留空：任何回退到单例的读取都会渲染出 "(empty)"。
        useDefaultPortfolioStore.getState().closeDocument();

        expect((await render(createElement(PortfolioStoreProvider, { store: sessions }, createElement(Title)))).text).toBe("作品集");
        expect((await render(createElement(PortfolioStoreProvider, { store: designs }, createElement(Title)))).text).toBe("设计稿");
    });

    test("hands the exact injected instance to consumers", async () => {
        const sessions = createPortfolioStore();
        const designs = createPortfolioStore();
        let seen: Store | null = null;
        await render(
            createElement(
                PortfolioStoreProvider,
                { store: designs },
                createElement(ApiProbe, {
                    onApi: (store: Store) => {
                        seen = store;
                    },
                }),
            ),
        );
        expect(seen).toBe(designs);
        expect(seen).not.toBe(sessions);
        expect(seen).not.toBe(useDefaultPortfolioStore);
    });

    test("provider without an explicit store owns a fresh session", async () => {
        useDefaultPortfolioStore.getState().loadDocument(documentWithText("单例里的文档"));
        const { text } = await render(createElement(PortfolioStoreProvider, null, createElement(Title)));
        // 自建实例是空的：既不是默认单例的内容，也不是上一次 Provider 的残留。
        expect(text).toBe("(empty)");
    });

    test("fails fast outside the provider instead of silently using the default instance", async () => {
        useDefaultPortfolioStore.getState().loadDocument(documentWithText("单例里的文档"));
        const { errors } = await render(createElement(Title));
        expect(errors.map((error) => error.message).join("\n")).toContain("PortfolioStoreProvider");
    });
});
