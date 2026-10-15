import { describe, expect, it } from "bun:test";
import { AGENT_APPROVAL_SUPERSEDED_BY_NODE, agentApprovalMatchesSettings, agentApprovalModel, agentApprovalModelSelection, agentApprovalTargetGenerating, agentImageApproval, agentMediaApprovalTargetNodeId, agentVideoApproval } from "../src/lib/canvas/agent-media-approval";
import type { CanvasNodeData } from "../src/types/canvas";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";
import { agentMediaSettingsEqual, normalizeAgentMediaSettings } from "../src/services/api/agent";
import type { AgentMediaSettings } from "../src/services/api/agent";

describe("image generation approval settings", () => {
    const args = { mode: "image", prompt: "保持参考图产品外观", size: "1024x1024", quality: "high", channelId: "platform", channelModelKey: "gpt-image-2", referenceNodeIds: ["product"] };
    it("reads both SSE approval requests and restored run snapshots", () => {
        const event = agentImageApproval({ toolName: "generate_media", arguments: args });
        const restored = agentImageApproval({ call: { function: { name: "generate_media", arguments: JSON.stringify(args) } } });
        expect(event).toEqual(restored);
        expect(restored?.referenceNodeIds).toEqual(["product"]);
        expect(restored?.quality).toBe("high");
    });
    it("does not enable image settings for other tools or invalid arguments", () => {
        expect(agentImageApproval({ toolName: "canvas_apply_ops", arguments: args })).toBeNull();
        expect(agentImageApproval({ toolName: "generate_media", arguments: { ...args, mode: "video" } })).toBeNull();
        expect(agentImageApproval({ toolName: "generate_media", arguments: "{" })).toBeNull();
    });
    it("does not treat another tab's different approval settings as a successful retry", () => {
        expect(agentApprovalMatchesSettings(args, args)).toBe(true);
        expect(agentApprovalMatchesSettings(args, { ...args, quality: "low" })).toBe(false);
        expect(agentApprovalMatchesSettings(args, { logicalModelId: "other", size: args.size, quality: args.quality })).toBe(false);
    });
    it("switches between logical and channel models without retaining the previous selector", () => {
        const cost = { model: "gpt-image-2", capability: "image" as const, billingMode: "fixed_request" as const, unitPriceMicrocredits: 1, priceConfigured: true };
        const config = { ...defaultConfig, channels: [
            createModelChannel({ id: "platform", scope: "system", models: [cost.model], modelCosts: [cost] }),
            createModelChannel({ id: "managed", scope: "system", models: [cost.model], modelCosts: [{ ...cost, logicalModelId: "logical-image" }] }),
            createModelChannel({ id: "personal", scope: "custom", models: [cost.model], modelCosts: [cost] }),
        ] };
        const logical = agentApprovalModelSelection(config, encodeChannelModel("managed", cost.model));
        expect(logical).toEqual({ logicalModelId: "logical-image" });
        expect(agentApprovalModel(config, { ...logical, size: args.size, quality: args.quality })).toBe(encodeChannelModel("managed", cost.model));
        const channel = agentApprovalModelSelection(config, encodeChannelModel("platform", cost.model));
        expect(channel).toEqual({ channelId: "platform", channelModelKey: cost.model });
        expect(agentApprovalModel(config, { ...channel, size: args.size, quality: args.quality })).toBe(encodeChannelModel("platform", cost.model));
        expect(() => agentApprovalModelSelection(config, encodeChannelModel("personal", cost.model))).toThrow("平台模型");
        expect(agentApprovalModel(config, { logicalModelId: "removed", size: args.size, quality: args.quality })).toBe("");
    });
});

describe("video generation approval settings", () => {
    it("reads video duration and audio options", () => {
        const approval = agentVideoApproval({ toolName: "generate_media", arguments: { mode: "video", prompt: "镜头运动", size: "9:16", quality: "720p", durationSeconds: 8, videoGenerateAudio: true, channelId: "platform", channelModelKey: "seedance-test", referenceNodeIds: ["image"] } });
        expect(approval?.durationSeconds).toBe(8);
        expect(approval?.videoGenerateAudio).toBe(true);
        expect(approval?.referenceNodeIds).toEqual(["image"]);
    });
});

describe("approval target already generating on the canvas", () => {
    const detail = { toolName: "generate_media", arguments: JSON.stringify({ mode: "image", prompt: "p", size: "1:1", nodeId: "draft-1" }) };
    const node = (metadata: Record<string, unknown>) => ({ id: "draft-1", type: "image", title: "开场分镜", position: { x: 0, y: 0 }, width: 200, height: 200, metadata }) as unknown as CanvasNodeData;

    it("reads the target node from SSE events and restored snapshots", () => {
        expect(agentMediaApprovalTargetNodeId(detail)).toBe("draft-1");
        expect(agentMediaApprovalTargetNodeId({ call: { function: { name: "generate_media", arguments: detail.arguments } } })).toBe("draft-1");
        expect(agentMediaApprovalTargetNodeId({ toolName: "canvas_apply_ops", arguments: detail.arguments })).toBe("");
        expect(agentMediaApprovalTargetNodeId({ toolName: "generate_media", arguments: "{" })).toBe("");
    });

    it("blocks approval only while the same node is generating", () => {
        expect(agentApprovalTargetGenerating(detail, [node({ status: "idle" })])).toBeUndefined();
        expect(agentApprovalTargetGenerating(detail, [node({ status: "loading" })])?.id).toBe("draft-1");
        expect(agentApprovalTargetGenerating(detail, [node({ taskId: "t1", taskStatus: "running" })])?.id).toBe("draft-1");
        expect(agentApprovalTargetGenerating(detail, [node({ status: "idle" })], "draft-1")?.id).toBe("draft-1");
        expect(agentApprovalTargetGenerating(detail, [{ ...node({ status: "loading" }), id: "other" }])).toBeUndefined();
        expect(agentApprovalTargetGenerating(detail, undefined)).toBeUndefined();
    });

    it("uses the same decision value as the backend", () => {
        expect(AGENT_APPROVAL_SUPERSEDED_BY_NODE).toBe("superseded_by_node");
    });
});

describe("approval decision request body", () => {
    it("never ships server-owned generation intent to the decision endpoint", () => {
        // 审批卡直接把 generate_media 参数摊开展示，未改动设置时 value 为空，
        // 组件曾用 `value || initial` 让整份初始参数（含 prompt/referenceNodeIds）
        // 随 { ...settings } 回传，后端 DisallowUnknownFields 判 400，
        // 用户看到的就是「点了同意执行没反应」。
        const approval = agentImageApproval({ toolName: "generate_media", arguments: {
            mode: "image", prompt: "漫画海报", size: "1024x1824", quality: "medium",
            channelId: "CHANNEL_000023", channelModelKey: "gpt-image-2.5-1k",
            nodeId: "image-dog-poster-1", snapshotHash: "abc", title: "漫画海报 · 金毛犬",
            referenceNodeIds: ["image-dog-1"], referenceTransientIds: ["tmp-1"], sourceNodeId: "image-dog-1",
        } });
        expect(approval?.prompt).toBe("漫画海报");

        // 未改设置时面板的提交值：白名单化的 initial 直接可用于提交。
        const untouched = normalizeAgentMediaSettings(approval!);
        expect(untouched && Object.keys(untouched).sort()).toEqual([
            "channelId", "channelModelKey", "imageResolution", "imageParameters",
            "logicalModelId", "quality", "size",
        ].filter((key) => untouched[key as keyof typeof untouched] !== undefined).sort());
        expect(JSON.stringify(untouched)).not.toContain("prompt");
        expect(JSON.stringify(untouched)).not.toContain("referenceNodeIds");
        expect(JSON.stringify(untouched)).not.toContain("snapshotHash");
        expect(JSON.stringify(untouched)).not.toContain("nodeId");

        // 改过设置后同样只带白名单字段，且画幅覆盖真正生效。
        const edited = normalizeAgentMediaSettings({ ...approval!, size: "9:16", quality: "high" });
        expect(edited?.size).toBe("9:16");
        expect(edited?.quality).toBe("high");
        expect("prompt" in (edited as object)).toBe(false);
        expect("referenceNodeIds" in (edited as object)).toBe(false);
    });

    it("keeps transient and video-only fields out of an image decision", () => {
        const settings = normalizeAgentMediaSettings({
            size: "16:9", quality: "720p", durationSeconds: 8,
            videoGenerateAudio: true, videoWatermark: false, videoArkPrivateAssetUpload: true,
            prompt: "x", referenceNodeIds: ["a"], sourceNodeId: "b",
        } as AgentMediaSettings);
        expect(settings).toEqual({ size: "16:9", quality: "720p", durationSeconds: 8, videoGenerateAudio: true, videoWatermark: false, videoArkPrivateAssetUpload: true });
    });

    it("treats an unedited approval and a whitespace-equivalent edit as the same retry", () => {
        expect(agentMediaSettingsEqual({ size: "9:16", quality: "medium", prompt: "p" } as AgentMediaSettings, { size: "9:16", quality: "medium" })).toBe(true);
        expect(agentMediaSettingsEqual({ size: "9:16", quality: "medium" }, { size: "9:16", quality: "high" })).toBe(false);
        expect(agentMediaSettingsEqual(undefined, undefined)).toBe(true);
    });
});
