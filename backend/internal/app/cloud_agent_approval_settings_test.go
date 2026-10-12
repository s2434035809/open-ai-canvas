package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"gorm.io/gorm"

	"yingce/backend/internal/model"
)

func TestCloudAgentMediaReadHashSurvivesMoveBeforeDraft(t *testing.T) {
	s, db, args := agentMediaFixture(t)
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(canvas.PayloadJSON)
	view, err := cloudAgentCanvasState(s.repo, "user", "agent-canvas", doc, 0, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	args.SnapshotHash = view.(map[string]any)["mediaSnapshotHash"].(string)
	nodes, _ := creationObjects(doc["nodes"])
	nodes["cat"]["position"] = map[string]any{"x": 1600, "y": 500}
	raw, _ := json.Marshal(doc)
	if err := db.Model(canvas).Update("payload_json", string(raw)).Error; err != nil {
		t.Fatal(err)
	}
	run, _ := agentMediaRun(t, s, args, "request_approval")
	if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
		t.Fatal(err)
	}
	pending, err := s.CloudAgentRun("user", run.ID)
	if err != nil || pending.Status != "waiting_approval" {
		t.Fatalf("movement prevented draft creation: %v %+v", err, pending)
	}
	approveAgentMediaDraft(t, s, run.ID)
}

func TestCloudAgentMediaApprovalAllowsMovesButRejectsContentChanges(t *testing.T) {
	for _, change := range []string{"move", "presentation", "prompt", "resource", "connection", "locked", "task", "unknown_metadata"} {
		t.Run(change, func(t *testing.T) {
			s, db, a := agentMediaFixture(t)
			run, _ := agentMediaRun(t, s, a, "request_approval")
			if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
				t.Fatal(err)
			}
			run, _ = s.repo.CloudAgent("user", run.ID)
			state, err := cloudAgentDecode(run)
			if err != nil || state.Approval == nil {
				t.Fatalf("missing approval: %v", err)
			}
			canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
			doc, _ := creationDocument(canvas.PayloadJSON)
			nodes, _ := creationObjects(doc["nodes"])
			fullHash := cloudAgentCanvasHash(doc)
			switch change {
			case "move":
				nodes["cat"]["position"] = map[string]any{"x": 1234, "y": 567}
				nodes[a.NodeID]["position"] = map[string]any{"x": 2000, "y": 900}
			case "presentation":
				nodes[a.NodeID]["width"], nodes[a.NodeID]["height"] = 500, 600
				nodes[a.NodeID]["createdAt"], nodes[a.NodeID]["updatedAt"] = "2026-09-19T00:00:00Z", "2026-09-19T00:00:01Z"
				doc["chatMessages"] = []any{map[string]any{"text": "用户补充消息"}}
			case "prompt":
				nodes[a.NodeID]["metadata"].(map[string]any)["composerContent"] = "用户修改的提示词"
			case "resource":
				nodes["cat"]["metadata"].(map[string]any)["storageKey"] = "resource:ref-two"
			case "connection":
				doc["connections"] = []any{}
			case "locked":
				nodes[a.NodeID]["metadata"].(map[string]any)["locked"] = true
			case "task":
				nodes[a.NodeID]["metadata"].(map[string]any)["taskId"] = "another-task"
			case "unknown_metadata":
				nodes[a.NodeID]["metadata"].(map[string]any)["futureGenerationInput"] = "changed"
			}
			if fullHash == cloudAgentCanvasHash(doc) {
				t.Fatal("full mutation/undo hash must still detect changes")
			}
			raw, _ := json.Marshal(doc)
			if err := db.Model(canvas).Update("payload_json", string(raw)).Error; err != nil {
				t.Fatal(err)
			}
			if err := s.DecideCloudAgentApproval("user", run.ID, state.Approval.ID, "approve", ""); err != nil {
				t.Fatal(err)
			}
			if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
				t.Fatal(err)
			}
			var count int64
			db.Model(&model.Task{}).Where("type = ?", "canvas_video").Count(&count)
			if change != "move" && change != "presentation" {
				if count != 0 {
					t.Fatal("content change submitted generation")
				}
				return
			}
			if count != 1 {
				t.Fatal("layout-only change blocked generation")
			}
			canvas, _ = s.repo.CanvasProjectForUser("user", "agent-canvas")
			doc, _ = creationDocument(canvas.PayloadJSON)
			nodes, _ = creationObjects(doc["nodes"])
			if change == "move" && (nodes["cat"]["position"].(map[string]any)["x"] != float64(1234) || nodes[a.NodeID]["position"].(map[string]any)["x"] != float64(2000)) {
				t.Fatal("generation overwrote user's positions")
			}
			if change == "presentation" && (nodes[a.NodeID]["width"] != float64(500) || nodes[a.NodeID]["height"] != float64(600) || nodes[a.NodeID]["createdAt"] != "2026-09-19T00:00:00Z" || nodes[a.NodeID]["updatedAt"] != "2026-09-19T00:00:01Z" || len(doc["chatMessages"].([]any)) != 1) {
				t.Fatal("generation overwrote presentation autosave")
			}
		})
	}
}

func TestCloudAgentMediaApprovalReusesPreparedInputsAfterModelRetry(t *testing.T) {
	s, db, a := agentMediaFixture(t)
	run, _ := agentMediaRun(t, s, a, "request_approval")
	if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
		t.Fatal(err)
	}
	run, _ = s.repo.CloudAgent("user", run.ID)
	state, err := cloudAgentDecode(run)
	if err != nil || state.Approval == nil || state.Approval.Prepared == nil {
		t.Fatalf("missing prepared media approval: %v", err)
	}

	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := creationObjects(doc["nodes"])
	if err != nil {
		t.Fatal(err)
	}
	nodes[a.NodeID]["position"] = map[string]any{"x": 1800.0, "y": 920.0}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(canvas).Update("payload_json", string(raw)).Error; err != nil {
		t.Fatal(err)
	}

	retried := state.Approval.Call
	retried.ID = "media-call-retry"
	_, plan, err := s.prepareCloudAgentMedia(run, &state, retried)
	if err != nil {
		t.Fatalf("layout-only edit plus regenerated tool-call ID must reuse prepared media: %v", err)
	}
	if plan == nil {
		t.Fatal("retry did not retain prepared media admission")
	}
}

func TestCloudAgentImageApprovalEditsAreValidatedAndIdempotent(t *testing.T) {
	s, db, a := agentMediaFixture(t)
	capability := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGrokImage), "grok-image")
	for _, key := range []string{"grok-image", "grok-image-alternative"} {
		for _, row := range []any{
			&model.ChannelModel{ID: key, ChannelID: "channel", ModelKey: key, DisplayName: key, Capability: "image", Protocol: model.ChannelInterfaceGrokImage, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, capability), BillingMode: "fixed_request", PriceConfigured: true, Enabled: true},
			&model.ChannelModelPriceTier{ID: key + "-tier", ChannelModelID: key, SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 1, PriceConfigured: true, Enabled: true},
		} {
			if err := db.Create(row).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	a.Mode, a.ChannelModelKey, a.Duration, a.VideoGenerateAudio = "image", "grok-image", 0, nil
	a.Size, a.Quality, a.NodeID = "1:1", "2k", "image-shot-1"
	a.ReferenceNodeIDs = []string{"cat"}
	run, _ := agentMediaRun(t, s, a, "request_approval")
	if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
		t.Fatal(err)
	}
	run, _ = s.repo.CloudAgent("user", run.ID)
	state, err := cloudAgentDecode(run)
	if err != nil || state.Approval == nil {
		t.Fatalf("missing approval: %v", err)
	}
	var approvedArgs cloudAgentMediaArgs
	if err := json.Unmarshal([]byte(state.Approval.Call.Function.Arguments), &approvedArgs); err != nil {
		t.Fatal(err)
	}
	id := state.Approval.ID
	settings := CloudAgentMediaSettings{ChannelID: "channel", ChannelModelKey: "grok-image-alternative", Size: "16:9", Quality: "1k"}
	for _, invalid := range []CloudAgentMediaSettings{
		{ChannelID: "channel", ChannelModelKey: "missing", Size: "16:9", Quality: "1k"},
		{ChannelID: "channel", ChannelModelKey: "text-test", Size: "16:9", Quality: "1k"},
		{LogicalModelID: "mixed", ChannelID: "channel", ChannelModelKey: settings.ChannelModelKey, Size: "16:9"},
		{ChannelID: "channel", ChannelModelKey: settings.ChannelModelKey, Size: "invalid-size", Quality: "1k"},
		{ChannelID: "channel", ChannelModelKey: settings.ChannelModelKey, Size: "16:9", Quality: "invalid-quality"},
	} {
		if err := s.DecideCloudAgentApproval("user", run.ID, id, "approve", "", &invalid); err == nil {
			t.Fatalf("invalid settings accepted: %+v", invalid)
		}
	}
	if err := s.DecideCloudAgentApproval("other", run.ID, id, "approve", "", &settings); err == nil {
		t.Fatal("cross-user approval accepted")
	}
	pending, _ := s.CloudAgentRun("user", run.ID)
	if pending.Status != "waiting_approval" {
		t.Fatal("invalid settings consumed approval")
	}
	var before int64
	db.Model(&model.BillingOrder{}).Count(&before)
	if err := s.DecideCloudAgentApproval("user", run.ID, id, "approve", "", &settings); err != nil {
		t.Fatal(err)
	}
	var afterFirstApproval int64
	db.Model(&model.BillingOrder{}).Count(&afterFirstApproval)
	if afterFirstApproval <= before {
		t.Fatal("approval did not submit the approved media task")
	}
	if err := s.DecideCloudAgentApproval("user", run.ID, id, "approve", "", &settings); err != nil {
		t.Fatal(err)
	}
	var afterRetry int64
	db.Model(&model.BillingOrder{}).Count(&afterRetry)
	if afterRetry != afterFirstApproval {
		t.Fatalf("idempotent approval created another billing order: first=%d retry=%d", afterFirstApproval, afterRetry)
	}
	changed := settings
	changed.Size = "1:1"
	if err := s.DecideCloudAgentApproval("user", run.ID, id, "approve", "", &changed); err == nil {
		t.Fatal("conflicting retry accepted")
	}
	if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
		t.Fatal(err)
	}
	run, _ = s.repo.CloudAgent("user", run.ID)
	state, err = cloudAgentDecode(run)
	if err != nil || state.MediaTaskID == "" {
		t.Fatalf("edited approval did not submit: %v %+v", err, state.Events)
	}
	task, err := s.repo.TaskForUser("user", state.MediaTaskID)
	if err != nil {
		t.Fatal(err)
	}
	var input canvasGenerationInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	if input.Config.Model != settings.ChannelModelKey || input.Config.Size != settings.Size || input.Config.Quality != settings.Quality || task.Prompt != approvedArgs.Prompt || len(input.ReferenceImages) != 1 {
		t.Fatalf("approved inputs were lost: %+v", input.Config)
	}
	var count int64
	db.Model(&model.Task{}).Where("type = ?", "canvas_image").Count(&count)
	if count != 1 {
		t.Fatalf("expected exactly one image task, got %d", count)
	}
}

func TestCloudAgentVideoApprovalEditsAreValidatedAndApplied(t *testing.T) {
	s, db, args := agentMediaFixture(t)
	run, _ := agentMediaRun(t, s, args, "request_approval")
	if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
		t.Fatal(err)
	}
	run, _ = s.repo.CloudAgent("user", run.ID)
	state, err := cloudAgentDecode(run)
	if err != nil || state.Approval == nil {
		t.Fatalf("missing video approval: %v", err)
	}
	seconds := 8
	audio := false
	watermark := false
	settings := CloudAgentMediaSettings{ChannelID: args.ChannelID, ChannelModelKey: args.ChannelModelKey, Size: args.Size, Quality: args.Quality, DurationSeconds: &seconds, VideoGenerateAudio: &audio, VideoWatermark: &watermark}
	if err := s.DecideCloudAgentApproval("user", run.ID, state.Approval.ID, "approve", "", &settings); err != nil {
		t.Fatal(err)
	}
	if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
		t.Fatal(err)
	}
	updated, err := s.repo.CloudAgent("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, err = cloudAgentDecode(updated)
	if err != nil || state.MediaTaskID == "" {
		t.Fatalf("edited video approval did not submit: %v", err)
	}
	task, err := s.repo.TaskForUser("user", state.MediaTaskID)
	if err != nil {
		t.Fatal(err)
	}
	var input canvasGenerationInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	if input.Config.VideoSeconds != "8" || input.Config.VideoGenerateAudio != "false" || input.Config.VideoWatermark != "false" {
		t.Fatalf("approved video options were not applied: %+v", input.Config)
	}
	var count int64
	db.Model(&model.Task{}).Where("type = ?", "canvas_video").Count(&count)
	if count != 1 {
		t.Fatalf("expected exactly one video task, got %d", count)
	}
}

func TestCloudAgentConversationKeepsRecentRounds(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	if err := db.Create(&model.CanvasProject{ID: "agent-canvas", UserID: "user", PayloadJSON: `{"nodes":[]}`}).Error; err != nil {
		t.Fatal(err)
	}
	parent := ""
	for round := 0; round < 15; round++ {
		req := agentTestRequest()
		req.IdempotencyKey = fmt.Sprintf("long-conversation-%d", round)
		run, err := s.CreateCloudAgentRun("user", req, parent)
		if err != nil {
			t.Fatalf("round %d failed: %v", round+1, err)
		}
		execution, _ := s.repo.CloudAgent("user", run.ID)
		state, err := cloudAgentDecode(execution)
		if err != nil {
			t.Fatalf("history decode failed at round %d: %v", round, err)
		}
		want := round * 2
		if want > cloudAgentHistoryKeepRounds*2 {
			want = cloudAgentHistoryKeepRounds * 2
		}
		if len(state.TextHistory) != want {
			t.Fatalf("history window at round %d: got %d want %d", round, len(state.TextHistory), want)
		}
		if err := db.Model(&model.Task{}).Where("id = ?", run.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"text":"继续创作"}`}).Error; err != nil {
			t.Fatal(err)
		}
		if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
			t.Fatal(err)
		}
		parent = run.ID
	}
	run, _ := s.repo.CloudAgent("user", parent)
	state, _ := cloudAgentDecode(run)
	for i := range state.TextHistory {
		state.TextHistory[i].Content = strings.Repeat("x", 4000)
	}
	raw, _ := json.Marshal(state)
	if err := db.Model(run).Update("state_json", string(raw)).Error; err != nil {
		t.Fatal(err)
	}
	req := agentTestRequest()
	req.IdempotencyKey = "long-conversation-trim-bytes"
	child, err := s.CreateCloudAgentRun("user", req, parent)
	if err != nil {
		t.Fatalf("oversize history should trim not fail: %v", err)
	}
	childRun, err := s.repo.CloudAgent("user", child.ID)
	if err != nil {
		t.Fatal(err)
	}
	childState, err := cloudAgentDecode(childRun)
	if err != nil {
		t.Fatal(err)
	}
	if cloudAgentHistoryJSONSize(childState.TextHistory) > cloudAgentHistoryMaxBytes {
		t.Fatal("trimmed history still over cap")
	}
	if cloudAgentHistoryUserInstructionCount(childState.TextHistory) < 1 {
		t.Fatal("trimmed away the conversation")
	}
}

// agentImageApprovalFixture 准备一次图片生成审批：图片模型、参考素材与审批参数。
func agentImageApprovalFixture(t *testing.T) (*Service, *gorm.DB, cloudAgentMediaArgs) {
	t.Helper()
	s, db, a := agentMediaFixture(t)
	capability := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGrokImage), "grok-image")
	for _, row := range []any{
		&model.ChannelModel{ID: "grok-image", ChannelID: "channel", ModelKey: "grok-image", DisplayName: "grok-image", Capability: "image", Protocol: model.ChannelInterfaceGrokImage, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, capability), BillingMode: "fixed_request", PriceConfigured: true, Enabled: true},
		&model.ChannelModelPriceTier{ID: "grok-image-tier", ChannelModelID: "grok-image", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 1, PriceConfigured: true, Enabled: true},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	a.Mode, a.ChannelModelKey, a.Duration, a.VideoGenerateAudio = "image", "grok-image", 0, nil
	a.Size, a.Quality, a.NodeID = "1:1", "2k", "image-shot-1"
	a.ReferenceNodeIDs = []string{"cat"}
	return s, db, a
}

// agentUnrelatedCanvasWrite 模拟审批卡片出现后前端的画布自动保存：画布文本变了，
// 但本次生成的节点级依赖（目标节点、引用、来源、入边）都没变。
func agentUnrelatedCanvasWrite(t *testing.T, db *gorm.DB) {
	t.Helper()
	var canvas model.CanvasProject
	if err := db.First(&canvas, "id = ?", "agent-canvas").Error; err != nil {
		t.Fatal(err)
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := creationObjects(doc["nodes"])
	if err != nil {
		t.Fatal(err)
	}
	metadata, _ := nodes["hero"]["metadata"].(map[string]any)
	if metadata == nil {
		t.Fatal("fixture lost the unrelated reference node")
	}
	metadata["note"] = "自动保存写入的展示信息"
	doc["chatSessions"] = []any{map[string]any{"id": "session-1", "title": "生成队列"}}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.CanvasProject{}).Where("id = ?", "agent-canvas").Update("payload_json", string(raw)).Error; err != nil {
		t.Fatal(err)
	}
}

// 回归：审批创建后画布被无关写入改动（前端自动保存），用户再改画幅/质量点“同意执行”。
// 准入必须按节点级生成依赖判定内容未变，而不是回落到画布级文本哈希。
// 修复前这条路径必然 409，审批停在 waiting_approval，界面显示“点了没反应”。
func TestCloudAgentImageApprovalAcceptsEditedSettingsAfterUnrelatedCanvasWrite(t *testing.T) {
	s, db, a := agentImageApprovalFixture(t)
	run, _ := agentMediaRun(t, s, a, "request_approval")
	if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
		t.Fatal(err)
	}
	run, _ = s.repo.CloudAgent("user", run.ID)
	state, err := cloudAgentDecode(run)
	if err != nil || state.Approval == nil || state.Approval.Prepared == nil {
		t.Fatalf("missing prepared image approval: %v", err)
	}
	agentUnrelatedCanvasWrite(t, db)

	settings := CloudAgentMediaSettings{ChannelID: "channel", ChannelModelKey: "grok-image", Size: "16:9", Quality: "2k"}
	if err := s.DecideCloudAgentApproval("user", run.ID, state.Approval.ID, "approve", "", &settings); err != nil {
		t.Fatalf("unrelated canvas write blocked an edited approval: %v", err)
	}
	if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
		t.Fatal(err)
	}
	run, _ = s.repo.CloudAgent("user", run.ID)
	state, err = cloudAgentDecode(run)
	if err != nil {
		t.Fatal(err)
	}
	if state.MediaTaskID == "" {
		t.Fatalf("edited approval submitted no task: %+v", state.Events)
	}
	task, err := s.repo.TaskForUser("user", state.MediaTaskID)
	if err != nil {
		t.Fatal(err)
	}
	var input canvasGenerationInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	if input.Config.Size != settings.Size || input.Config.Quality != settings.Quality {
		t.Fatalf("approved settings were lost: %+v", input.Config)
	}
}

// 反向边界：放行无关写入不能放宽依赖校验。草稿节点的生成依赖真的变了（提示词被改写），
// 即使同时改了画幅也必须拒绝，审批保持 waiting_approval 且不产生任务。
func TestCloudAgentImageApprovalRejectsEditedSettingsAfterDependencyChange(t *testing.T) {
	s, db, a := agentImageApprovalFixture(t)
	run, _ := agentMediaRun(t, s, a, "request_approval")
	if err := s.advanceCloudAgentByID("user", run.ID); err != nil {
		t.Fatal(err)
	}
	run, _ = s.repo.CloudAgent("user", run.ID)
	state, err := cloudAgentDecode(run)
	if err != nil || state.Approval == nil || state.Approval.Prepared == nil {
		t.Fatalf("missing prepared image approval: %v", err)
	}
	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := creationObjects(doc["nodes"])
	if err != nil {
		t.Fatal(err)
	}
	metadata, _ := nodes[a.NodeID]["metadata"].(map[string]any)
	if metadata == nil {
		t.Fatal("approval did not create the draft node")
	}
	metadata["composerContent"] = "用户改写后的草稿提示词"
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(canvas).Update("payload_json", string(raw)).Error; err != nil {
		t.Fatal(err)
	}
	agentUnrelatedCanvasWrite(t, db)

	settings := CloudAgentMediaSettings{ChannelID: "channel", ChannelModelKey: "grok-image", Size: "16:9", Quality: "2k"}
	if err := s.DecideCloudAgentApproval("user", run.ID, state.Approval.ID, "approve", "", &settings); err == nil {
		t.Fatal("changed generation dependency accepted an edited approval")
	}
	pending, err := s.CloudAgentRun("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if pending.Status != "waiting_approval" {
		t.Fatalf("rejected approval changed run status: %s", pending.Status)
	}
	var count int64
	db.Model(&model.Task{}).Where("type = ?", "canvas_image").Count(&count)
	if count != 0 {
		t.Fatal("rejected approval submitted a task")
	}
}
