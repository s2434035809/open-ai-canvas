package app

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

// approvalPauseRoot 建立 Pi 模式的运行（root 任务不占活动任务位，模型步走 /model 桥）。
func approvalPauseRoot(t *testing.T) (*Service, *gorm.DB, *CloudAgentRun) {
	t.Helper()
	s, db, _, _ := creationTestService(t)
	s.legacyCloudAgentRootTask = false
	if err := db.Create(&model.CanvasProject{ID: "agent-canvas", UserID: "user", PayloadJSON: `{"nodes":[]}`}).Error; err != nil {
		t.Fatal(err)
	}
	root, err := s.CreateCloudAgentRun("user", agentTestRequest(), "")
	if err != nil {
		t.Fatal(err)
	}
	return s, db, root
}

// approvalPauseStage 把运行摆进等待审批状态：挂起的工具调用与审批一一对应
// （检查点校验要求 Approval.Call 与 Calls[CallIndex] 一致）。
func approvalPauseStage(t *testing.T, s *Service, db *gorm.DB, run *model.CloudAgentExecution, state *cloudAgentRuntime) {
	t.Helper()
	call := cloudAgentCall{ID: "call-1"}
	call.Function.Name = "generate_media"
	call.Function.Arguments = "{}"
	run.Status = "waiting_approval"
	state.Calls = []cloudAgentCall{call}
	state.CallIndex = 0
	state.Approval = &cloudAgentApproval{ID: "ap-1", Call: call}
	if state.Decisions == nil {
		state.Decisions = map[string]string{}
	}
	approvalPauseSaveState(t, s, db, run, state)
}

// approvalPauseSaveState 用生产同款 CAS 路径落库改过的运行态（直接 db.Save 会把
// Transcript 关联行追加而不是替换，污染下一次 decode 的 canonical）。
func approvalPauseSaveState(t *testing.T, s *Service, db *gorm.DB, run *model.CloudAgentExecution, state *cloudAgentRuntime) {
	t.Helper()
	if err := s.repo.MutateCloudAgent(run.UserID, run.ID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = run.Status
		return cloudAgentSave(current, state)
	}); err != nil {
		t.Fatal(err)
	}
}

// approvalPauseModelPayload 组装运行时风格的 /model 请求（conversation）。
func approvalPauseModelPayload(t *testing.T, messages []map[string]any) map[string]json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(messages)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]json.RawMessage{
		"modelId":       json.RawMessage(`"text-test"`),
		"purpose":       json.RawMessage(`"conversation"`),
		"messages":      encoded,
		"thinkingLevel": json.RawMessage(`"off"`),
	}
}

// 运行时在审批暂停后中止会话是异步的，可能抢在中止生效前再请求一步模型。
// 这一步不能入队：否则多计一次费，返回的新工具调用还会顶掉待审批的调用，
// 让整轮以「approval does not match current call」的检查点校验失败收场。
func TestCloudAgentPiModelStepRefusedWhileAwaitingApproval(t *testing.T) {
	s, db, root := approvalPauseRoot(t)
	run, state := agentInterjectionState(t, s, root.ID)
	approvalPauseStage(t, s, db, run, &state)
	before, stateBefore := agentInterjectionState(t, s, root.ID)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	messages := []map[string]any{{"role": "user", "content": []any{map[string]any{"type": "text", "text": "继续"}}}}
	_, err := s.cloudAgentPiModel(ctx, "user", root.ID, approvalPauseModelPayload(t, messages))
	if !errors.Is(err, errCloudAgentAwaitingApproval) {
		t.Fatalf("model step during approval wait: err=%v, want errCloudAgentAwaitingApproval", err)
	}

	after, stateAfter := agentInterjectionState(t, s, root.ID)
	if after.Status != "waiting_approval" || stateAfter.Approval == nil || stateAfter.Approval.ID != stateBefore.Approval.ID {
		t.Fatalf("approval was disturbed: status=%s approval=%#v", after.Status, stateAfter.Approval)
	}
	if stateAfter.Step != stateBefore.Step || stateAfter.ActiveTaskID != "" || after.Revision != before.Revision {
		t.Fatalf("a model step was scheduled: step %d→%d activeTask=%q revision %d→%d", stateBefore.Step, stateAfter.Step, stateAfter.ActiveTaskID, before.Revision, after.Revision)
	}
	var steps int64
	if err := db.Model(&model.Task{}).Where("agent_run_id = ? AND operation = ?", root.ID, cloudAgentStepOperation).Count(&steps).Error; err != nil {
		t.Fatal(err)
	}
	if steps != 0 {
		t.Fatalf("%d billable model step task(s) were created while awaiting approval", steps)
	}
}

// 会话可能在审批暂停后被其它入口重新拉起（幂等重放、媒体回写、节点代提交、
// 恢复扫描后的重启）。此时新会话的首个 /model 会撞上仍挂着的审批并被拒；
// 旧逻辑只在 Tool 桥置位 pausedForApproval 才兜底，于是这一拒被一路上抛成
// 整轮 failed，用户手里的审批卡片随即失效（点「同意执行」也没人接管）。
func TestCloudAgentPiSessionErrorCoveredByPendingApproval(t *testing.T) {
	s, db, root := approvalPauseRoot(t)
	run, state := agentInterjectionState(t, s, root.ID)
	approvalPauseStage(t, s, db, run, &state)

	// 会话重启路径：pausedForApproval 从未置位，错误来自被拒的首个模型步。
	if !s.cloudAgentRunAwaitingApproval("user", root.ID) {
		t.Fatal("pending approval was not detected; a restarted session cannot be covered")
	}

	// 没有待审批时不得吞掉真实失败。
	run, state = agentInterjectionState(t, s, root.ID)
	state.Approval = nil
	run.Status = "running"
	approvalPauseSaveState(t, s, db, run, &state)
	if s.cloudAgentRunAwaitingApproval("user", root.ID) {
		t.Fatal("running run without approval must not be treated as awaiting approval")
	}
}
