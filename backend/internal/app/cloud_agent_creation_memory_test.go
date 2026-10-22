package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/model"
)

func TestCreationMemoryAdmissionAndRecallIsolation(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	now := time.Now()
	for _, item := range []model.AgentLesson{
		{ID: "smart", AuthorUserID: "user", Category: "smart_creation", Topic: "产品主图.逐项修改", Situation: "SMART_CREATION_ONLY", Lesson: "按目标图逐项修改", Status: model.AgentLessonStatusApproved},
		{ID: "canvas", AuthorUserID: "user", Category: "canvas", Topic: "画布.快照", Situation: "CANVAS_ONLY", Lesson: "先读画布", Status: model.AgentLessonStatusApproved},
		{ID: "pending", AuthorUserID: "user", Category: "smart_creation", Topic: "产品主图.待审", Situation: "PENDING_ONLY", Status: model.AgentLessonStatusPending},
		{ID: "foreign", AuthorUserID: "other", Category: "smart_creation", Topic: "产品主图.他人", Situation: "FOREIGN_ONLY", Status: model.AgentLessonStatusApproved},
	} {
		item.CreatedAt, item.UpdatedAt = now, now
		if err := db.Create(&item).Error; err != nil {
			t.Fatal(err)
		}
	}
	run, err := s.CreateCloudAgentRun("user", creationAgentRequest(), "")
	if err != nil {
		t.Fatal(err)
	}
	task, _, err := s.cloudAgentTask("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(task.InputJSON, "SMART_CREATION_ONLY") {
		t.Fatal("首页未接入智能创作记忆索引")
	}
	for _, forbidden := range []string{"CANVAS_ONLY", "PENDING_ONLY", "FOREIGN_ONLY"} {
		if strings.Contains(task.InputJSON, forbidden) {
			t.Fatalf("索引泄漏 %s", forbidden)
		}
	}
	for _, args := range []map[string]any{{}, {"keyword": "产品主图", "limit": 1}, {"category": "smart_creation"}, {"topic": "产品主图.逐项修改"}} {
		call := cloudAgentStoryboardCall(t, "recall_lessons", "memory", args)
		result, err := cloudAgentReadTool(s.repo, "user", &cloudAgentRuntime{Request: creationAgentRequest()}, call, s)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(result)
		if !strings.Contains(string(raw), "产品主图.逐项修改") || strings.Contains(string(raw), "画布.快照") {
			t.Fatalf("首页召回越界或丢失: %s", raw)
		}
	}
	call := cloudAgentStoryboardCall(t, "recall_lessons", "cross", map[string]any{"topic": "画布.快照"})
	if _, err := cloudAgentReadTool(s.repo, "user", &cloudAgentRuntime{Request: creationAgentRequest()}, call, s); err == nil {
		t.Fatal("首页按 topic 读到了画布记忆")
	}
	call = cloudAgentStoryboardCall(t, "recall_lessons", "cross", map[string]any{"topic": "产品主图.逐项修改"})
	if _, err := cloudAgentReadTool(s.repo, "user", &cloudAgentRuntime{Request: agentTestRequest()}, call, s); err == nil {
		t.Fatal("画布读到了智能创作记忆")
	}
}

func TestCreationMemoryRequiresDeliveredMediaAndUsesSmartCategory(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	state := &cloudAgentRuntime{Request: creationAgentRequest(), TaskIDs: []string{"media"}, LessonEligibleToolSuccesses: 4}
	state.Request.PermissionMode = "auto"
	call := rememberLessonCall(`{"topic":"creation.edit","category":"image","situation":"多图分别修改","lesson":"每张图绑定对应原图"}`)
	item := model.Task{ID: "media", UserID: "user", Type: "canvas_image", Status: model.TaskStatusRunning, AgentRunID: "run"}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := cloudAgentRememberLesson(s.repo, "user", state, call); err == nil {
		t.Fatal("仍在运行的任务被记成成功经验")
	}
	if err := db.Model(&item).Update("status", model.TaskStatusSucceeded).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := cloudAgentRememberLesson(s.repo, "user", state, call); err != nil {
		t.Fatal(err)
	}
	// 首页记忆同样走"成功后提交"：本轮暂存，成功结束才落成待审条目。
	if lessons, err := s.repo.UserAgentLessons("user", model.AgentLessonStatusPending, 10); err != nil || len(lessons) != 0 {
		t.Fatalf("本轮未成功结束前不应落库: %+v %v", lessons, err)
	}
	if err := cloudAgentCommitLessonDrafts(s.repo, "user", "run", state); err != nil {
		t.Fatal(err)
	}
	lessons, err := s.repo.UserAgentLessons("user", model.AgentLessonStatusPending, 10)
	if err != nil || len(lessons) != 1 || lessons[0].Category != "smart_creation" {
		t.Fatalf("首页记忆分类不正确: %+v %v", lessons, err)
	}
}

func TestMemoryCompactCannotCrossCreationSurface(t *testing.T) {
	s, _, _, _ := creationTestService(t)
	var ids []string
	for _, category := range []string{"smart_creation", "canvas"} {
		item, err := s.CreateUserAgentMemory("user", AgentMemoryRequest{Topic: category + ".edit", Category: category, Situation: "多图修改", Lesson: "按目标修改"})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, item.ID)
	}
	snapshots := make([]model.AgentMemorySnapshot, 0, len(ids))
	for _, id := range ids {
		lesson, err := s.repo.AgentLessonForUser("user", id)
		if err != nil {
			t.Fatal(err)
		}
		snapshots = append(snapshots, model.SnapshotAgentMemory(*lesson))
	}
	changes, summary := s.buildAgentMemoryProposalChanges("user", snapshots, agentMemoryCompactPlan{
		Merges:   []agentMemoryCompactMerge{{IDs: ids, Topic: "merged.edit", Category: "canvas", Situation: "多图修改", Lesson: "按目标修改"}},
		Rewrites: []agentMemoryCompactRewrite{{ID: ids[0], Topic: "rewritten.edit", Category: "image", Situation: "多图修改", Lesson: "按目标修改"}},
	})
	if len(changes) != 0 || summary.Merged != 0 || summary.Rewritten != 0 || summary.Skipped != 2 {
		t.Fatalf("压缩混淆场景: %+v %+v", changes, summary)
	}
}
