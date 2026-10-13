import { expect, test } from "bun:test";

// 自研（2026-10-10）：审批是写操作，不依赖事件流。
//
// 症状：事件流处于 connecting/reconnecting/disconnected 时，「同意执行」按钮被连接状态
// 禁用（渲染成「正在提交」），点击既不提交也不提示，用户感知就是「点了没反应」。
// 上一版修复只补了一条提示，按钮仍然被禁用；这里盯住入口本身不再被连接状态锁死，
// 掉线时点击仍然直接提交，由服务端校验审批是否仍然有效。
test("事件流未连接时「同意执行」仍然可点，点击直接提交审批", async () => {
    const panel = await Bun.file(new URL("../src/components/canvas/canvas-cloud-agent-panel.tsx", import.meta.url)).text();

    // 提前 return 的条件里只剩「没有运行/没有审批/重复提交」
    const guard = panel.match(/const submitApproval = async[\s\S]*?\n\s*const runId/)?.[0];
    expect(guard).toBeDefined();
    expect(guard).toContain("if (!run || !approval || approvalRequestRef.current === approval.approvalId) return;");
    expect(guard).not.toMatch(/connectionStatus[\s\S]{0,80}?return;/);

    // 掉线时给出可见反馈，不允许静默
    expect(guard).toContain("`approval-offline-${approval.approvalId}`");

    // 审批卡片不再用连接状态禁用按钮（禁用只由我们自己的提交请求驱动）
    const conversation = panel.match(/<AgentConversation[\s\S]*?\/>/)?.[0];
    expect(conversation).toBeDefined();
    expect(conversation).toContain("approvalSubmitting={approvalSubmitting}");
    expect(conversation).not.toContain("connectionStatus");
});

// 自研（2026-10-12）：同意执行前的画布保存失败不能阻断审批提交。
//
// 症状：保存走的是 operation 增量接口，一旦本地队列里有服务端必然拒绝的脏操作
// （例如节点补丁丢失基线），PATCH 会持续 400；原先 `await saveRemoteUserDataNow()`
// 抛错后直接进 catch，审批请求根本没发出，运行永久停在等待审批，用户感知就是
// 「点了同意执行又不行了」。保存有它自己的重放队列，审批是写操作必须送达服务端。
test("同意执行前的画布保存失败只提示，不阻断审批提交", async () => {
    const panel = await Bun.file(new URL("../src/components/canvas/canvas-cloud-agent-panel.tsx", import.meta.url)).text();
    const body = panel.match(/const submitApproval = async[\s\S]*?\n    \};/)?.[0];
    expect(body).toBeDefined();
    expect(body).toContain("await saveRemoteUserDataNow();");
    // 保存被包进独立的 try/catch，失败只发提示
    const guard = body!.match(/if \(decision === "approve"\) \{[\s\S]*?\n            \}/)?.[0];
    expect(guard).toBeDefined();
    expect(guard).toContain("catch (saveCause)");
    expect(guard).toContain("`approval-save-${approvalId}`");
    // 保存不再与提交共享同一个 try/catch：失败后仍必须走到审批提交
    expect(body).not.toContain('if (decision === "approve") await saveRemoteUserDataNow();');
    expect(body!.indexOf("decideAgentApproval(")).toBeGreaterThan(guard!.length);
});
