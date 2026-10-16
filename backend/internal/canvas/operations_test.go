package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yingce/backend/internal/kernel"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func TestApplyCanvasOperationsReplaysSameMutationAndRejectsDifferentPayload(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if err := svc.repo.Create(&model.CanvasProject{
		ID: "canvas", UserID: "user", Title: "初始", PayloadJSON: `{"nodes":[{"id":"node","metadata":{"title":"旧","prompt":"原始"}}],"connections":[]}`,
	}); err != nil {
		t.Fatal(err)
	}
	request := CanvasOperationsRequest{
		MutationID: "mutation-1",
		Operations: []CanvasOperation{{Type: "patch_node", ID: "node", Patch: map[string]json.RawMessage{
			"metadata.title": json.RawMessage(`"新"`),
		}, Before: map[string]json.RawMessage{"metadata.title": json.RawMessage(`"旧"`)}}},
	}
	first, err := svc.ApplyUserCanvasOperations("user", "canvas", request)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 2 {
		t.Fatalf("first revision = %d, want 2", first.Revision)
	}
	second, err := svc.ApplyUserCanvasOperations("user", "canvas", request)
	if err != nil {
		t.Fatal(err)
	}
	if second.Revision != first.Revision {
		t.Fatalf("replay revision = %d, want %d", second.Revision, first.Revision)
	}
	receipt, err := svc.repo.CanvasMutationReceiptForUser("user", "canvas", "mutation-1")
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Revision != first.Revision || receipt.PayloadDigest == "" || receipt.ResultJSON == "" {
		t.Fatalf("invalid receipt: %#v", receipt)
	}

	request.Operations[0].Patch["metadata.title"] = json.RawMessage(`"冲突"`)
	_, err = svc.ApplyUserCanvasOperations("user", "canvas", request)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusConflict {
		t.Fatalf("different payload replay error = %v, want conflict", err)
	}
}

func TestApplyCanvasOperationsCreatesOnlyExplicitCanvas(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	request := CanvasOperationsRequest{MutationID: "create-canvas", Operations: []CanvasOperation{
		{Type: "create_canvas", ID: "canvas", Patch: map[string]json.RawMessage{"title": json.RawMessage(`"新画布"`)}},
		{Type: "create_node", Node: json.RawMessage(`{"id":"node","type":"text","metadata":{"content":"hello"}}`)},
	}}
	result, err := svc.ApplyUserCanvasOperations("user", "canvas", request)
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != 1 {
		t.Fatalf("created revision = %d, want 1", result.Revision)
	}
	stored, err := svc.repo.CanvasProjectForUser("user", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Title != "新画布" || !strings.Contains(stored.PayloadJSON, `"node"`) {
		t.Fatalf("created canvas payload = %s", stored.PayloadJSON)
	}
	if _, err := svc.ApplyUserCanvasOperations("user", "missing", CanvasOperationsRequest{MutationID: "missing-update", Operations: []CanvasOperation{{Type: "patch_node", ID: "node", Patch: map[string]json.RawMessage{"title": json.RawMessage(`"late"`)}, Before: map[string]json.RawMessage{"title": json.RawMessage(`null`)}}}}); err == nil {
		t.Fatal("implicit canvas creation was accepted")
	}
}
func TestApplyCanvasOperationsDoesNotRecreateDeletedNode(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if err := svc.repo.Create(&model.CanvasProject{
		ID: "canvas", UserID: "user", PayloadJSON: `{"nodes":[{"id":"node","metadata":{"title":"旧"}}],"connections":[]}`,
	}); err != nil {
		t.Fatal(err)
	}
	remove := CanvasOperationsRequest{MutationID: "remove-node", Operations: []CanvasOperation{{Type: "remove_node", ID: "node", Expected: json.RawMessage(`{"id":"node","metadata":{"title":"旧"}}`)}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", remove); err != nil {
		t.Fatal(err)
	}
	late := CanvasOperationsRequest{MutationID: "late-update", Operations: []CanvasOperation{{Type: "patch_node", ID: "node", Patch: map[string]json.RawMessage{
		"metadata.title": json.RawMessage(`"迟到"`),
	}, Before: map[string]json.RawMessage{"metadata.title": json.RawMessage(`"旧"`)}}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", late); err == nil {
		t.Fatal("late update after deletion was accepted")
	} else {
		var appError *kernel.AppError
		if !errors.As(err, &appError) || appError.Status != http.StatusConflict {
			t.Fatalf("late update error = %v, want conflict", err)
		}
	}
	stored, err := svc.UserCanvasProject("user", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Nodes []map[string]any `json:"nodes"`
	}
	if err := json.Unmarshal(stored, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Nodes) != 0 {
		t.Fatalf("late update recreated deleted node: %s", stored)
	}
}

func TestApplyCanvasOperationsRejectsConnectionWithMissingEndpoint(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if err := svc.repo.Create(&model.CanvasProject{
		ID: "canvas", UserID: "user", PayloadJSON: `{"nodes":[{"id":"from"}],"connections":[]}`,
	}); err != nil {
		t.Fatal(err)
	}
	request := CanvasOperationsRequest{MutationID: "bad-connection", Operations: []CanvasOperation{{
		Type: "create_connection", Connection: json.RawMessage(`{"id":"edge","fromNodeId":"from","toNodeId":"missing"}`),
	}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", request); err == nil {
		t.Fatal("missing connection endpoint was accepted")
	}
}

func TestApplyCanvasOperationsRejectsStaleFieldAndAllowsDisjointField(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if err := svc.repo.Create(&model.CanvasProject{
		ID: "canvas", UserID: "user", PayloadJSON: `{"nodes":[{"id":"node","metadata":{"title":"旧","prompt":"原始"}}],"connections":[]}`,
	}); err != nil {
		t.Fatal(err)
	}
	first := CanvasOperationsRequest{MutationID: "title-change", Operations: []CanvasOperation{{Type: "patch_node", ID: "node", Patch: map[string]json.RawMessage{
		"metadata.title": json.RawMessage(`"标题一"`),
	}, Before: map[string]json.RawMessage{"metadata.title": json.RawMessage(`"旧"`)}}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", first); err != nil {
		t.Fatal(err)
	}
	stale := CanvasOperationsRequest{MutationID: "stale-title", Operations: []CanvasOperation{{Type: "patch_node", ID: "node", Patch: map[string]json.RawMessage{
		"metadata.title": json.RawMessage(`"标题二"`),
	}, Before: map[string]json.RawMessage{"metadata.title": json.RawMessage(`"旧"`)}}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", stale); err == nil {
		t.Fatal("stale same-field update was accepted")
	} else {
		var appError *kernel.AppError
		if !errors.As(err, &appError) || appError.Status != http.StatusConflict {
			t.Fatalf("stale same-field error = %v, want conflict", err)
		}
	}
	disjoint := CanvasOperationsRequest{MutationID: "prompt-change", Operations: []CanvasOperation{{Type: "patch_node", ID: "node", Patch: map[string]json.RawMessage{
		"metadata.prompt": json.RawMessage(`"新的提示词"`),
	}, Before: map[string]json.RawMessage{"metadata.prompt": json.RawMessage(`"原始"`)}}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", disjoint); err != nil {
		t.Fatal(err)
	}
}

// 服务端写入（Agent、生成回写）会刷新节点 updatedAt；客户端基于旧 updatedAt 的
// 补丁不能因此整体冲突，业务字段仍按基线校验。
func TestApplyCanvasOperationsIgnoresNodeUpdatedAtBase(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if err := svc.repo.Create(&model.CanvasProject{
		ID: "canvas", UserID: "user", PayloadJSON: `{"nodes":[{"id":"node","updatedAt":"server-new","metadata":{"title":"旧"}}],"connections":[]}`,
	}); err != nil {
		t.Fatal(err)
	}
	request := CanvasOperationsRequest{MutationID: "stale-updated-at", Operations: []CanvasOperation{{Type: "patch_node", ID: "node", Patch: map[string]json.RawMessage{
		"updatedAt":      json.RawMessage(`"client-new"`),
		"metadata.title": json.RawMessage(`"新"`),
	}, Before: map[string]json.RawMessage{"updatedAt": json.RawMessage(`"client-old"`), "metadata.title": json.RawMessage(`"旧"`)}}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", request); err != nil {
		t.Fatalf("stale updatedAt base rejected: %v", err)
	}
	stale := CanvasOperationsRequest{MutationID: "stale-title-with-updated-at", Operations: []CanvasOperation{{Type: "patch_node", ID: "node", Patch: map[string]json.RawMessage{
		"metadata.title": json.RawMessage(`"再改"`),
	}, Before: map[string]json.RawMessage{"updatedAt": json.RawMessage(`"client-new"`), "metadata.title": json.RawMessage(`"旧"`)}}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", stale); err == nil {
		t.Fatal("stale business field accepted")
	}
}

func TestApplyCanvasOperationsRejectsStaleCanvasField(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if err := svc.repo.Create(&model.CanvasProject{ID: "canvas", UserID: "user", Title: "旧标题", PayloadJSON: `{"nodes":[],"connections":[],"title":"旧标题"}`}); err != nil {
		t.Fatal(err)
	}
	first := CanvasOperationsRequest{MutationID: "field-one", Operations: []CanvasOperation{{Type: "set_field", Field: "title", Value: json.RawMessage(`"新标题"`), BeforeValue: json.RawMessage(`"旧标题"`)}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", first); err != nil {
		t.Fatal(err)
	}
	stale := CanvasOperationsRequest{MutationID: "field-two", Operations: []CanvasOperation{{Type: "set_field", Field: "title", Value: json.RawMessage(`"另一个标题"`), BeforeValue: json.RawMessage(`"旧标题"`)}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", stale); err == nil {
		t.Fatal("stale canvas field update was accepted")
	} else {
		var appError *kernel.AppError
		if !errors.As(err, &appError) || appError.Status != http.StatusConflict {
			t.Fatalf("stale canvas field error = %v, want conflict", err)
		}
	}
}

// 客户端读到的 projectId/title 来自数据库列投影；payload 里缺省该字段时，
// 以投影值作为 beforeValue 的请求必须被接受，而不是误报字段冲突。
func TestApplyCanvasOperationsChecksFieldBaseAgainstProjection(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if err := svc.repo.Create(&model.CanvasProject{ID: "canvas", UserID: "user", Title: "自由画布 1", PayloadJSON: `{"nodes":[],"connections":[]}`}); err != nil {
		t.Fatal(err)
	}
	request := CanvasOperationsRequest{MutationID: "projection-base", Operations: []CanvasOperation{
		{Type: "set_field", Field: "projectId", Value: json.RawMessage(`null`), BeforeValue: json.RawMessage(`""`)},
		{Type: "set_field", Field: "title", Value: json.RawMessage(`"改名"`), BeforeValue: json.RawMessage(`"自由画布 1"`)},
	}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", request); err != nil {
		t.Fatalf("projection base rejected: %v", err)
	}
	stored, err := svc.repo.CanvasProjectForUser("user", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Title != "改名" || stored.ProjectID != "" {
		t.Fatalf("stored title=%q projectId=%q", stored.Title, stored.ProjectID)
	}
	stale := CanvasOperationsRequest{MutationID: "projection-stale", Operations: []CanvasOperation{
		{Type: "set_field", Field: "title", Value: json.RawMessage(`"再改"`), BeforeValue: json.RawMessage(`"自由画布 1"`)},
	}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", stale); err == nil {
		t.Fatal("stale title base accepted")
	}
}

func TestApplyCanvasOperationsAcceptsLegacyOmittedOptionalFieldValues(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if err := svc.repo.Create(&model.CanvasProject{ID: "canvas", UserID: "user", PayloadJSON: `{"nodes":[],"connections":[]}`}); err != nil {
		t.Fatal(err)
	}
	// Before the frontend encoded undefined as null, JSON.stringify omitted
	// beforeValue when an optional field was absent. The server must replay that
	// original request against an absent field without weakening the precondition.
	legacyCreate := CanvasOperationsRequest{MutationID: "legacy-optional-field", Operations: []CanvasOperation{{
		Type: "set_field", Field: "timeline", Value: json.RawMessage(`{"tracks":[]}`),
	}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", legacyCreate); err != nil {
		t.Fatalf("legacy optional field update failed: %v", err)
	}

	stored, err := svc.repo.CanvasProjectForUser("user", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stored.PayloadJSON, `"timeline":{"tracks":[]}`) {
		t.Fatalf("legacy optional field was not stored: %s", stored.PayloadJSON)
	}

	legacyDelete := CanvasOperationsRequest{MutationID: "legacy-optional-field-delete", Operations: []CanvasOperation{{
		Type: "set_field", Field: "timeline", BeforeValue: json.RawMessage(`{"tracks":[]}`),
	}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", legacyDelete); err != nil {
		t.Fatalf("legacy optional field deletion failed: %v", err)
	}
	stored, err = svc.repo.CanvasProjectForUser("user", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored.PayloadJSON, `"timeline"`) {
		t.Fatalf("legacy optional field was not deleted: %s", stored.PayloadJSON)
	}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", CanvasOperationsRequest{MutationID: "missing-required-field-base", Operations: []CanvasOperation{{
		Type: "set_field", Field: "title", Value: json.RawMessage(`"标题"`),
	}}}); err == nil {
		t.Fatal("missing required field precondition was accepted")
	}
}

func TestApplyCanvasOperationsDoesNotRecreateDeletedCanvas(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", CanvasOperationsRequest{MutationID: "create", Operations: []CanvasOperation{{Type: "create_canvas", ID: "canvas", Patch: map[string]json.RawMessage{"title": json.RawMessage(`"初始"`)}}}}); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteUserCanvasProject("user", "canvas"); err != nil {
		t.Fatal(err)
	}
	late := CanvasOperationsRequest{MutationID: "late-after-canvas-delete", Operations: []CanvasOperation{{Type: "patch_node", ID: "node", Patch: map[string]json.RawMessage{"title": json.RawMessage(`"迟到"`)}, Before: map[string]json.RawMessage{"title": json.RawMessage(`null`)}}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", late); err == nil {
		t.Fatal("late update recreated deleted canvas")
	}
	createAgain := CanvasOperationsRequest{MutationID: "explicit-recreate", Operations: []CanvasOperation{{Type: "create_canvas", ID: "canvas", Patch: map[string]json.RawMessage{"title": json.RawMessage(`"明确新建"`)}}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", createAgain); err != nil {
		t.Fatalf("explicit canvas creation after deletion failed: %v", err)
	}
}

func TestApplyCanvasOperationsRequiresObjectPreconditions(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if err := svc.repo.Create(&model.CanvasProject{ID: "canvas", UserID: "user", PayloadJSON: `{"nodes":[{"id":"node","title":"旧"}],"connections":[{"id":"edge","fromNodeId":"node","toNodeId":"node","label":"旧"}]}`}); err != nil {
		t.Fatal(err)
	}
	withoutPatchBase := CanvasOperationsRequest{MutationID: "missing-patch-base", Operations: []CanvasOperation{{Type: "patch_node", ID: "node", Patch: map[string]json.RawMessage{"title": json.RawMessage(`"新"`)}}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", withoutPatchBase); err == nil {
		t.Fatal("patch without field precondition was accepted")
	}
	withoutRemoveBase := CanvasOperationsRequest{MutationID: "missing-remove-base", Operations: []CanvasOperation{{Type: "remove_node", ID: "node"}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", withoutRemoveBase); err == nil {
		t.Fatal("remove without object precondition was accepted")
	}
	withoutConnectionBase := CanvasOperationsRequest{MutationID: "missing-connection-base", Operations: []CanvasOperation{{Type: "update_connection", ID: "edge", Connection: json.RawMessage(`{"id":"edge","fromNodeId":"node","toNodeId":"node","label":"新"}`)}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", withoutConnectionBase); err == nil {
		t.Fatal("connection update without object precondition was accepted")
	}
}

func newCanvasOperationTestService(t *testing.T) *Service {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "canvas-operations.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.CanvasProject{}, &model.CanvasSnapshot{}, &model.CanvasSnapshotResource{}, &model.CanvasMutationReceipt{}, &model.CanvasShare{}, &model.CanvasUnitLink{}, &model.Task{}, &model.Resource{}, &model.Asset{}); err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	return New(repository.New(db), nil)
}

// 服务端生成回写会自行补上节点 metadata.assetId（cloud_agent_media.go），
// 客户端随后按自己的本地基线提交同一个确定性身份。两者写的是同一个值，
// 客户端基线却常常滞后一轮：把它判成冲突会让整笔保存被拒，而未确认队列
// 会连同旧 before 反复重放，形成无法自愈的 409。
func TestApplyCanvasOperationsAcceptsConvergingAssetID(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if err := svc.repo.Create(&model.CanvasProject{
		ID: "canvas", UserID: "user", PayloadJSON: `{"nodes":[{"id":"shot_ep01_13","metadata":{"taskId":"task-1","assetId":"generation_same","prompt":"旧"}}],"connections":[]}`,
	}); err != nil {
		t.Fatal(err)
	}
	// 客户端基线里还没有 assetId（before=null），补丁要写的正是服务端已有的同一个值。
	request := CanvasOperationsRequest{MutationID: "converging-asset-id", Operations: []CanvasOperation{{Type: "patch_node", ID: "shot_ep01_13", Patch: map[string]json.RawMessage{
		"metadata.prompt":  json.RawMessage(`"新"`),
		"metadata.assetId": json.RawMessage(`"generation_same"`),
	}, Before: map[string]json.RawMessage{
		"metadata.prompt":  json.RawMessage(`"旧"`),
		"metadata.assetId": json.RawMessage(`null`),
	}}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", request); err != nil {
		t.Fatalf("converging assetId rejected the whole patch: %v", err)
	}
	project, err := svc.repo.CanvasProjectForUser("user", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Nodes []struct {
			Metadata map[string]any `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal([]byte(project.PayloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if got := payload.Nodes[0].Metadata["prompt"]; got != "新" {
		t.Fatalf("user edit was dropped: got %v", got)
	}
	if got := payload.Nodes[0].Metadata["assetId"]; got != "generation_same" {
		t.Fatalf("server assetId changed: got %v", got)
	}
}

// 收敛豁免只覆盖“写成当前已有的值”。客户端要把 assetId 改成别的身份，
// 说明它指向了另一个素材，仍然必须按基线拒绝。
func TestApplyCanvasOperationsRejectsDivergentAssetID(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if err := svc.repo.Create(&model.CanvasProject{
		ID: "canvas", UserID: "user", PayloadJSON: `{"nodes":[{"id":"node","metadata":{"taskId":"task-1","assetId":"generation_server"}}],"connections":[]}`,
	}); err != nil {
		t.Fatal(err)
	}
	request := CanvasOperationsRequest{MutationID: "divergent-asset-id", Operations: []CanvasOperation{{Type: "patch_node", ID: "node", Patch: map[string]json.RawMessage{
		"metadata.assetId": json.RawMessage(`"generation_client"`),
	}, Before: map[string]json.RawMessage{"metadata.assetId": json.RawMessage(`"generation_same"`)}}}}
	_, err := svc.ApplyUserCanvasOperations("user", "canvas", request)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusConflict {
		t.Fatalf("divergent assetId error = %v, want conflict", err)
	}
}

// 收敛豁免只作用于请求里真正要写的字段，不能顺手放宽其他字段的基线校验。
func TestApplyCanvasOperationsConvergenceDoesNotRelaxOtherFields(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if err := svc.repo.Create(&model.CanvasProject{
		ID: "canvas", UserID: "user", PayloadJSON: `{"nodes":[{"id":"node","metadata":{"assetId":"generation_same","prompt":"服务端新值"}}],"connections":[]}`,
	}); err != nil {
		t.Fatal(err)
	}
	request := CanvasOperationsRequest{MutationID: "converging-asset-id-stale-prompt", Operations: []CanvasOperation{{Type: "patch_node", ID: "node", Patch: map[string]json.RawMessage{
		"metadata.assetId": json.RawMessage(`"generation_same"`),
		"metadata.prompt":  json.RawMessage(`"覆盖服务端"`),
	}, Before: map[string]json.RawMessage{
		"metadata.assetId": json.RawMessage(`null`),
		"metadata.prompt":  json.RawMessage(`"客户端旧值"`),
	}}}}
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", request); err == nil {
		t.Fatal("stale sibling field was accepted")
	}
}
