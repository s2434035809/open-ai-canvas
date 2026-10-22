/**
 * 设计工作台的 store 注入。
 *
 * 页面持有一份实例并挂在自己的生命周期上，退出即销毁；不提供全局单例，
 * 否则类型会退化成 any，且不同页面会互相串状态。
 *
 * Provider 外调用直接抛错：静默回退到某个全局单例，会让"渲染读 A、事件写 B"
 * 这类串台 bug 变得无法定位。
 */

import { createContext, useContext, useRef, type ReactNode } from "react";
import { useStore } from "zustand";

import { createDesignStore, type DesignStore, type DesignStoreState } from "./store";

const DesignStoreContext = createContext<DesignStore | null>(null);

export function DesignStoreProvider({ store, children }: { store?: DesignStore; children: ReactNode }) {
    const ownedRef = useRef<DesignStore | null>(null);
    if (!store && !ownedRef.current) ownedRef.current = createDesignStore();
    const instance = store ?? ownedRef.current;
    if (!instance) throw new Error("DesignStoreProvider 未能创建会话实例");
    return <DesignStoreContext.Provider value={instance}>{children}</DesignStoreContext.Provider>;
}

export function useDesignStore<T>(selector: (state: DesignStoreState) => T): T {
    const store = useContext(DesignStoreContext);
    if (!store) throw new Error("useDesignStore 必须在 DesignStoreProvider 内使用");
    return useStore(store, selector);
}

export function useDesignStoreApi(): DesignStore {
    const store = useContext(DesignStoreContext);
    if (!store) throw new Error("useDesignStoreApi 必须在 DesignStoreProvider 内使用");
    return store;
}

export { currentDesignPage } from "./store";
export type { DesignStore };
