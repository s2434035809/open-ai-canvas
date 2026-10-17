import { describe, expect, test } from "bun:test";
import { formatLocalSavedRemotePending } from "@/services/user-data-sync";
import { ApiError } from "@/services/api/request";

describe("本地已保存时的可操作恢复提示", () => {
    test("连接未确认不伪报云端成功，提供编辑、重连与导出出口", () => {
        const text = formatLocalSavedRemotePending("素材已在本地保存", new Error("网络中断"));
        expect(text).toContain("后台等待同步，可继续编辑");
        expect(text).toContain("导出草稿");
        expect(text).not.toContain("已保存到云端");
        expect(text).not.toContain("同步失败");
    });
    test("登录和权限问题有准确下一步，不无限承诺重试可写入", () => {
        expect(formatLocalSavedRemotePending("本地已保存", new ApiError("auth", { status: 401 }))).toContain("重新登录");
        expect(formatLocalSavedRemotePending("本地已保存", new ApiError("forbidden", { status: 403 }))).toContain("没有云端写入权限");
    });
});
