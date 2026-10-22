/**
 * 设计工作台基础层测试：契约 / 文档工厂 / store。
 *
 * 这三层是纯逻辑，能用真实断言覆盖，不依赖 DOM 或后端。测试的重点不是
 * "函数被调用过"，而是这些一旦错的规则：
 *   - 尺寸预设与页面尺寸必须一致（否则高亮撒谎）；
 *   - 撤销/重做的历史语义（一次操作回退一步，合并窗口内不产生多步）；
 *   - 元素创建时的默认值（图层顺序、图片等比缩放、形状带填充）；
 *   - 越界元素必须被夹回页内（Agent 给的坐标不可信）。
 */

import { describe, expect, test } from "bun:test";

import {
    DESIGN_DEFAULT_PRESET,
    DESIGN_SIZE_PRESETS,
    isDesignDocument,
    type DesignDocument,
    type DesignTextElement,
} from "../src/lib/design/contracts";
import {
    clampToPage,
    createDesignDocument,
    createDesignId,
    createImageElement,
    createShapeElement,
    createTextElement,
    nextZIndex,
    sortByZIndex,
} from "../src/lib/design/document";
import { createDesignStore, designDocumentBytes, selectedDesignElements, currentDesignPage } from "../src/lib/design/store";

function storeWithDocument(document: DesignDocument = createDesignDocument("测试稿")) {
    const store = createDesignStore();
    store.getState().loadDocument(document);
    return store;
}

describe("契约与预设", () => {
    test("默认预设就是 1:1，文档初始尺寸与之相等", () => {
        const document = createDesignDocument("海报");
        expect(DESIGN_DEFAULT_PRESET.label).toBe("1:1");
        expect(document.preset).toBe("1:1");
        expect(document.pages[0].width).toBe(DESIGN_DEFAULT_PRESET.width);
        expect(document.pages[0].height).toBe(DESIGN_DEFAULT_PRESET.height);
    });

    test("五档社媒尺寸齐全且宽高为正", () => {
        expect(DESIGN_SIZE_PRESETS.map((preset) => preset.label)).toEqual(["1:1", "3:4", "4:5", "9:16", "16:9"]);
        for (const preset of DESIGN_SIZE_PRESETS) {
            expect(preset.width).toBeGreaterThan(0);
            expect(preset.height).toBeGreaterThan(0);
        }
    });

    test("按预设建文档会用该预设的尺寸", () => {
        const document = createDesignDocument("竖版", "9:16");
        expect(document.preset).toBe("9:16");
        expect(document.pages[0].width).toBe(1080);
        expect(document.pages[0].height).toBe(1920);
    });

    test("未知预设回退到默认尺寸，而不是造出 0×0 页面", () => {
        const document = createDesignDocument("未知", "42:1");
        expect(document.pages[0].width).toBe(DESIGN_DEFAULT_PRESET.width);
        expect(document.pages[0].height).toBe(DESIGN_DEFAULT_PRESET.height);
    });

    test("isDesignDocument 只接受真正的文档形状", () => {
        expect(isDesignDocument(createDesignDocument("ok"))).toBe(true);
        expect(isDesignDocument(null)).toBe(false);
        expect(isDesignDocument({})).toBe(false);
        expect(isDesignDocument({ title: "x" })).toBe(false);
        expect(isDesignDocument({ title: "x", pages: [] })).toBe(true);
    });
});

describe("元素工厂", () => {
    test("文字元素带上排版所需的全部属性", () => {
        const text = createTextElement({ text: "主标题", fontSize: 64 });
        expect(text.kind).toBe("text");
        expect(text.text).toBe("主标题");
        expect(text.fontSize).toBe(64);
        // 高度随字号推导，避免默认 40px 高度把大标题裁掉。
        expect(text.height).toBeGreaterThan(64);
        expect(text.opacity).toBe(1);
        expect(text.locked).toBe(false);
    });

    test("图片元素保留自然尺寸，供等比缩放使用", () => {
        const image = createImageElement({ src: "data:image/png;base64,x", naturalWidth: 1200, naturalHeight: 800 });
        expect(image.kind).toBe("image");
        expect(image.naturalWidth).toBe(1200);
        expect(image.naturalHeight).toBe(800);
        expect(image.assetId).toBe("");
    });

    test("形状元素默认带可见填充，不是透明的空框", () => {
        const rect = createShapeElement("rect");
        expect(rect.kind).toBe("rect");
        expect(rect.fill).toBe("#2563eb");
        expect(rect.cornerRadius).toBe(0);
    });

    test("三种形状都能建出来", () => {
        for (const kind of ["rect", "ellipse", "line"] as const) {
            expect(createShapeElement(kind).kind).toBe(kind);
        }
    });

    test("ID 每次都不同，避免复制元素时主键相撞", () => {
        const ids = new Set(Array.from({ length: 50 }, () => createDesignId("el")));
        expect(ids.size).toBe(50);
    });

    test("nextZIndex 取最大值加一，空数组从 1 开始", () => {
        expect(nextZIndex([])).toBe(1);
        expect(nextZIndex([createTextElement({ text: "a" })])).toBe(2);
        const high = { ...createTextElement({ text: "b" }), zIndex: 99 };
        expect(nextZIndex([high])).toBe(100);
    });

    test("sortByZIndex 从下到上排序，不改原数组", () => {
        const low = { ...createTextElement({ text: "low" }), zIndex: 3 };
        const high = { ...createTextElement({ text: "high" }), zIndex: 1 };
        const input = [low, high];
        expect(sortByZIndex(input).map((element) => element.zIndex)).toEqual([1, 3]);
        expect(input[0]).toBe(low);
    });
});

describe("越界夹取", () => {
    test("超出右下角的元素被拉回页内", () => {
        const element = { ...createTextElement({ text: "x" }), x: 1000, y: 1200, width: 300, height: 100 };
        const clamped = clampToPage(element, { width: 1080, height: 1080 });
        expect(clamped.x).toBe(780);
        expect(clamped.y).toBe(980);
    });

    test("负坐标被夹到 0", () => {
        const element = { ...createTextElement({ text: "x" }), x: -50, y: -20 };
        const clamped = clampToPage(element, { width: 1080, height: 1080 });
        expect(clamped.x).toBe(0);
        expect(clamped.y).toBe(0);
    });

    test("比页面还大的元素缩到页面尺寸", () => {
        const element = { ...createTextElement({ text: "x" }), x: 0, y: 0, width: 5000, height: 5000 };
        const clamped = clampToPage(element, { width: 1080, height: 1080 });
        expect(clamped.width).toBe(1080);
        expect(clamped.height).toBe(1080);
    });

    test("本来就在页内的元素原样返回（同一个引用，避免无谓重渲染）", () => {
        const element = { ...createTextElement({ text: "x" }), x: 10, y: 10, width: 100, height: 50 };
        expect(clampToPage(element, { width: 1080, height: 1080 })).toBe(element);
    });
});

describe("store：装载与选择", () => {
    test("装载后清空选中与历史，且不算脏", () => {
        const store = storeWithDocument();
        expect(store.getState().document?.title).toBe("测试稿");
        expect(store.getState().selectedIds).toEqual([]);
        expect(store.getState().past).toEqual([]);
        expect(store.getState().dirty).toBe(false);
    });

    test("载入时带上 remoteId/revision", () => {
        const store = createDesignStore();
        store.getState().loadDocument(createDesignDocument("云端稿"), { remoteId: "d-1", revision: 7 });
        expect(store.getState().remoteId).toBe("d-1");
        expect(store.getState().revision).toBe(7);
    });

    test("selectAll 只选当前页元素", () => {
        const store = storeWithDocument();
        store.getState().addText({ text: "a" });
        store.getState().addText({ text: "b" });
        store.getState().selectAll();
        expect(store.getState().selectedIds).toHaveLength(2);
        expect(selectedDesignElements(store.getState())).toHaveLength(2);
    });

    test("currentDesignPage 越界时回退到第一页", () => {
        const store = storeWithDocument();
        store.getState().setPageIndex(99);
        expect(currentDesignPage(store.getState())).not.toBeNull();
        expect(currentDesignPage({ document: null, pageIndex: 0 })).toBeNull();
    });
});

describe("store：添加元素", () => {
    test("加文字会选中它并标脏", () => {
        const store = storeWithDocument();
        const id = store.getState().addText({ text: "主标题", fontSize: 72 });
        expect(id).toBeTruthy();
        expect(store.getState().selectedIds).toEqual([id!]);
        expect(store.getState().dirty).toBe(true);
        const page = currentDesignPage(store.getState())!;
        const element = page.elements.find((item) => item.id === id) as DesignTextElement;
        expect(element.text).toBe("主标题");
        expect(element.fontSize).toBe(72);
    });

    test("加图片按页宽 60% 等比缩放并居中", () => {
        const store = storeWithDocument();
        store.getState().addImage({ src: "data:x", naturalWidth: 2000, naturalHeight: 1000 });
        const page = currentDesignPage(store.getState())!;
        const image = page.elements[0];
        expect(image.width).toBe(Math.round(1080 * 0.6));
        expect(image.width / image.height).toBeCloseTo(2, 1);
        expect(image.x).toBe(Math.round((1080 - image.width) / 2));
    });

    test("小图片不被放大：保持自然尺寸", () => {
        const store = storeWithDocument();
        store.getState().addImage({ src: "data:x", naturalWidth: 200, naturalHeight: 200 });
        const image = currentDesignPage(store.getState())!.elements[0];
        expect(image.width).toBe(200);
        expect(image.height).toBe(200);
    });

    test("加形状走同一套图层递增", () => {
        const store = storeWithDocument();
        const first = store.getState().addShape("rect");
        const second = store.getState().addShape("ellipse");
        const page = currentDesignPage(store.getState())!;
        const a = page.elements.find((item) => item.id === first)!;
        const b = page.elements.find((item) => item.id === second)!;
        expect(b.zIndex).toBeGreaterThan(a.zIndex);
    });

    test("没有文档时加元素返回 null，不抛错", () => {
        const store = createDesignStore();
        expect(store.getState().addText({ text: "x" })).toBeNull();
        expect(store.getState().addImage({ src: "data:x" })).toBeNull();
        expect(store.getState().addShape("rect")).toBeNull();
    });
});

describe("store：撤销与重做", () => {
    test("一次添加可以撤销一步，再重做回来", () => {
        const store = storeWithDocument();
        store.getState().addText({ text: "a" });
        expect(currentDesignPage(store.getState())!.elements).toHaveLength(1);
        store.getState().undo();
        expect(currentDesignPage(store.getState())!.elements).toHaveLength(0);
        store.getState().redo();
        expect(currentDesignPage(store.getState())!.elements).toHaveLength(1);
    });

    test("撤销到底后再撤销是空操作，不抛错", () => {
        const store = storeWithDocument();
        store.getState().undo();
        store.getState().undo();
        expect(store.getState().past).toHaveLength(0);
    });

    test("合并窗口内的连续移动只产生一条历史", () => {
        const store = storeWithDocument();
        const id = store.getState().addText({ text: "a" })!;
        const baseline = store.getState().past.length;
        // 同一元素连续改坐标：模拟拖拽过程中的高频写入。
        for (let step = 1; step <= 10; step += 1) store.getState().updateElement(id, { x: step * 10 });
        const after = store.getState().past.length;
        // 拖拽产生的是「一个可撤销动作」，不是十步。
        expect(after - baseline).toBe(1);
        // 撤销一次就应回到拖动前的位置。
        store.getState().undo();
        const element = currentDesignPage(store.getState())!.elements.find((item) => item.id === id)!;
        expect(element.x).not.toBe(100);
    });

    test("新操作会清空重做栈", () => {
        const store = storeWithDocument();
        store.getState().addText({ text: "a" });
        store.getState().undo();
        expect(store.getState().future.length).toBeGreaterThan(0);
        store.getState().addText({ text: "b" });
        expect(store.getState().future).toHaveLength(0);
    });

    test("撤销会剔除已不存在的选中项", () => {
        const store = storeWithDocument();
        const id = store.getState().addText({ text: "a" })!;
        store.getState().undo();
        expect(store.getState().selectedIds).not.toContain(id);
    });

    test("历史长度有上限，不会无限增长", () => {
        const store = storeWithDocument();
        for (let index = 0; index < 80; index += 1) {
            store.getState().addShape("rect");
            // 每次跨越合并窗口，确保每次都是独立历史。
            store.getState().updateElement(currentDesignPage(store.getState())!.elements[0].id, { x: index });
        }
        expect(store.getState().past.length).toBeLessThanOrEqual(60);
    });
});

describe("store：属性与图层", () => {
    test("updateElement 只改目标元素", () => {
        const store = storeWithDocument();
        const a = store.getState().addText({ text: "a" })!;
        const b = store.getState().addText({ text: "b" })!;
        store.getState().updateElement(a, { x: 300 });
        const page = currentDesignPage(store.getState())!;
        expect(page.elements.find((item) => item.id === a)!.x).toBe(300);
        expect(page.elements.find((item) => item.id === b)!.x).not.toBe(300);
    });

    test("updateSelected 作用于多选", () => {
        const store = storeWithDocument();
        store.getState().addShape("rect");
        store.getState().addShape("ellipse");
        store.getState().selectAll();
        store.getState().updateSelected({ opacity: 0.5 });
        for (const element of currentDesignPage(store.getState())!.elements) expect(element.opacity).toBe(0.5);
    });

    test("删除选中后清空选中集", () => {
        const store = storeWithDocument();
        store.getState().addText({ text: "a" });
        store.getState().removeSelected();
        expect(currentDesignPage(store.getState())!.elements).toHaveLength(0);
        expect(store.getState().selectedIds).toEqual([]);
    });

    test("置顶把选中元素排到最上", () => {
        const store = storeWithDocument();
        const a = store.getState().addShape("rect")!;
        store.getState().addShape("ellipse");
        store.getState().select(a);
        store.getState().reorderSelected("front");
        const page = currentDesignPage(store.getState())!;
        const target = page.elements.find((item) => item.id === a)!;
        expect(target.zIndex).toBe(Math.max(...page.elements.map((element) => element.zIndex)));
    });

    test("置底把选中元素排到最下", () => {
        const store = storeWithDocument();
        store.getState().addShape("rect");
        const b = store.getState().addShape("ellipse")!;
        store.getState().select(b);
        store.getState().reorderSelected("back");
        const page = currentDesignPage(store.getState())!;
        expect(page.elements.find((item) => item.id === b)!.zIndex).toBe(1);
    });

    test("复制选中会错开位置并选中副本", () => {
        const store = storeWithDocument();
        const id = store.getState().addShape("rect")!;
        store.getState().select(id);
        store.getState().selectAll();
        store.getState().duplicateSelected();
        const page = currentDesignPage(store.getState())!;
        expect(page.elements).toHaveLength(2);
        expect(store.getState().selectedIds).toHaveLength(1);
        const original = page.elements.find((item) => item.id === id)!;
        const copy = page.elements.find((item) => item.id !== id)!;
        expect(copy.x).toBe(original.x + 24);
    });

    test("锁定元素不参与对齐", () => {
        const store = storeWithDocument();
        const locked = store.getState().addShape("rect")!;
        const free = store.getState().addShape("rect")!;
        store.getState().updateElement(locked, { x: 500, locked: true });
        store.getState().updateElement(free, { x: 200 });
        store.getState().selectAll();
        store.getState().alignSelected("left");
        const page = currentDesignPage(store.getState())!;
        expect(page.elements.find((item) => item.id === locked)!.x).toBe(500);
        expect(page.elements.find((item) => item.id === free)!.x).toBe(200);
    });

    test("对齐到页内最左/最右", () => {
        const store = storeWithDocument();
        const a = store.getState().addShape("rect")!;
        const b = store.getState().addShape("rect")!;
        store.getState().updateElement(a, { x: 100, width: 200 });
        store.getState().updateElement(b, { x: 600, width: 100 });
        store.getState().selectAll();
        store.getState().alignSelected("left");
        const page = currentDesignPage(store.getState())!;
        expect(page.elements.find((item) => item.id === a)!.x).toBe(100);
        expect(page.elements.find((item) => item.id === b)!.x).toBe(100);
    });
});

describe("store：尺寸预设", () => {
    test("setPreset 同时改预设标签与页面尺寸", () => {
        const store = storeWithDocument();
        const preset = DESIGN_SIZE_PRESETS.find((item) => item.label === "9:16")!;
        store.getState().setPreset(preset.label, preset.width, preset.height);
        const state = store.getState();
        expect(state.document!.preset).toBe("9:16");
        expect(currentDesignPage(state)!.width).toBe(1080);
        expect(currentDesignPage(state)!.height).toBe(1920);
    });

    test("改预设可撤销", () => {
        const store = storeWithDocument();
        store.getState().setPreset("16:9", 1920, 1080);
        store.getState().undo();
        expect(currentDesignPage(store.getState())!.width).toBe(DESIGN_DEFAULT_PRESET.width);
    });
});

describe("serialize 体积", () => {
    test("空文档体积很小", () => {
        const bytes = designDocumentBytes(createDesignDocument("空"));
        expect(bytes).toBeGreaterThan(0);
        expect(bytes).toBeLessThan(1000);
    });

    test("元素越多体积越大", () => {
        const store = storeWithDocument();
        const before = designDocumentBytes(store.getState().document!);
        for (let index = 0; index < 20; index += 1) store.getState().addText({ text: `文字 ${index}` });
        const after = designDocumentBytes(store.getState().document!);
        expect(after).toBeGreaterThan(before);
    });
});
