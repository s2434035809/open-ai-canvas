/**
 * 作品集编辑器内核的 store 注入层。
 *
 * 内核（store.ts + components/portfolio/*）是通用的「版式编辑会话」，但会话状态必须
 * 每个工作台各自一份：作品集与设计工作台共用同一个实例会让 document / selectedIds /
 * past / future / viewport / dirty 互相污染，而类型系统完全发现不了。
 *
 * 用法：
 *   <PortfolioStoreProvider>            // 自己建一份会话，随 Provider 生命周期存亡
 *       <Studio />                      // 内部用 usePortfolioStore(selector) / usePortfolioStoreApi()
 *   </PortfolioStoreProvider>
 *
 * 需要挂第二个会话（设计工作台、测试里并排渲染）时，由调用方传自己建好的 store。
 */

import { createContext, useContext, useRef, type ReactNode } from "react";
import { useStore } from "zustand";

import { createPortfolioStore, type PortfolioStore, type PortfolioStoreState } from "./store";

const PortfolioStoreContext = createContext<PortfolioStore | null>(null);

export function PortfolioStoreProvider({ store, children }: { store?: PortfolioStore; children: ReactNode }) {
    // 缺省实例只建一次：每次 render 新建会让所有订阅方在无关重渲染时被换掉。
    const ownedRef = useRef<PortfolioStore | null>(null);
    if (!store && !ownedRef.current) ownedRef.current = createPortfolioStore();
    const instance = store ?? ownedRef.current;
    if (!instance) throw new Error("PortfolioStoreProvider 未能创建会话实例");

    return <PortfolioStoreContext.Provider value={instance}>{children}</PortfolioStoreContext.Provider>;
}

/**
 * 取实例本身：用于事件回调、副作用里的 getState / setState，不订阅状态。
 *
 * Provider 外调用直接抛错。静默回退到默认单例等于把「两个工作台串台」这个 bug 藏回去，
 * 而这种错类型系统发现不了。
 */
export function usePortfolioStoreApi(): PortfolioStore {
    const store = useContext(PortfolioStoreContext);
    if (!store) throw new Error("usePortfolioStoreApi 必须在 <PortfolioStoreProvider> 内使用：请检查该组件是否被渲染在作品集/设计工作台的 Provider 之外");
    return store;
}

/** 订阅单段状态，签名与 zustand 的 `usePortfolioStore(selector)` 一致。 */
export function usePortfolioStore<T>(selector: (state: PortfolioStoreState) => T): T {
    return useStore(usePortfolioStoreApi(), selector);
}
