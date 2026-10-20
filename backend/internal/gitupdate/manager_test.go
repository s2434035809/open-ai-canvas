package gitupdate

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeRunner 记录调用并按脚本返回结果，用于验证分支校验与冲突归类逻辑，
// 避免测试依赖真实远端和网络。
type fakeRunner struct {
	calls [][]string
	reply func(args []string) (string, error)
}

func (f *fakeRunner) run(_ context.Context, _ string, args ...string) (string, error) {
	f.calls = append(f.calls, args)
	if f.reply == nil {
		return "", nil
	}
	return f.reply(args)
}

func TestCheckRejectsUnexpectedBranch(t *testing.T) {
	runner := &fakeRunner{reply: func(args []string) (string, error) {
		switch {
		case has(args, "rev-parse") && has(args, "--abbrev-ref"):
			return "main\n", nil
		default:
			return "", nil
		}
	}}
	manager := NewManager(Config{RepoDir: "/repo", Branch: "dev"})
	manager.git = runner

	status, err := manager.Check(context.Background())
	if err == nil {
		t.Fatal("expected branch guard to reject non-dev branch")
	}
	if status.Phase != PhaseFailed {
		t.Fatalf("phase = %s, want failed", status.Phase)
	}
	if len(status.Checks) == 0 || status.Checks[0].Key != "branch" || status.Checks[0].Status != "failed" {
		t.Fatalf("unexpected checks: %+v", status.Checks)
	}
	for _, call := range runner.calls {
		if has(call, "merge") {
			t.Fatalf("merge must not run on wrong branch: %v", call)
		}
	}
}

func TestCheckReportsNoUpdateWithoutPreview(t *testing.T) {
	runner := &fakeRunner{reply: func(args []string) (string, error) {
		switch {
		case has(args, "--abbrev-ref"):
			return "dev\n", nil
		case has(args, "rev-parse"):
			return "abc1234\n", nil
		case has(args, "rev-list"):
			return "0\t0\n", nil
		default:
			return "", nil
		}
	}}
	manager := NewManager(Config{RepoDir: "/repo", Branch: "dev"})
	manager.git = runner

	status, err := manager.Check(context.Background())
	if err != nil {
		t.Fatalf("check failed: %v", err)
	}
	if status.Phase != PhaseNoUpdate {
		t.Fatalf("phase = %s, want no_update", status.Phase)
	}
	if status.UpdateAvailable {
		t.Fatal("updateAvailable should be false when behind is zero")
	}
	for _, call := range runner.calls {
		if has(call, "worktree") {
			t.Fatalf("preview worktree should not be created without incoming commits: %v", call)
		}
	}
}

func TestApplyRequiresReadyPreview(t *testing.T) {
	manager := NewManager(Config{RepoDir: "/repo", Branch: "dev"})
	manager.git = &fakeRunner{}

	if _, err := manager.Apply(context.Background()); err == nil {
		t.Fatal("apply must refuse without a passed check")
	}
}

func TestApplyRejectsUpstreamDrift(t *testing.T) {
	manager := NewManager(Config{RepoDir: "/repo", Branch: "dev"})
	manager.status = Status{Phase: PhaseReady, Mergeable: true, UpstreamHead: "old0000", Branch: "dev"}
	manager.git = &fakeRunner{reply: func(args []string) (string, error) {
		switch {
		case has(args, "fetch"):
			return "", nil
		case has(args, "rev-list"):
			return "0\t1\n", nil
		case has(args, "rev-parse") && has(args, "upstream/main"):
			return "new0000\n", nil
		case has(args, "rev-parse"):
			return "dev1234\n", nil
		default:
			return "", nil
		}
	}}

	if _, err := manager.Apply(context.Background()); err == nil {
		t.Fatal("apply must refuse when upstream moved after check")
	}
	for _, call := range manager.git.(*fakeRunner).calls {
		if has(call, "merge") && !has(call, "--abort") {
			t.Fatalf("merge must not run on drifted upstream: %v", call)
		}
	}
}

func TestMergeFailureAbortsWorkingTree(t *testing.T) {
	manager := NewManager(Config{RepoDir: "/repo", Branch: "dev"})
	manager.status = Status{Phase: PhaseReady, Mergeable: true, UpstreamHead: "same000", Branch: "dev"}
	manager.git = &fakeRunner{reply: func(args []string) (string, error) {
		switch {
		case has(args, "merge") && has(args, "--abort"):
			return "", nil
		case has(args, "merge"):
			return "", errors.New("CONFLICT (content): Merge conflict in backend/x.go")
		case has(args, "rev-list"):
			return "0\t1\n", nil
		case has(args, "rev-parse"):
			return "same000\n", nil
		default:
			return "", nil
		}
	}}

	status, err := manager.Apply(context.Background())
	if err == nil {
		t.Fatal("expected merge error")
	}
	if status.Phase != PhaseFailed {
		t.Fatalf("phase = %s, want failed", status.Phase)
	}
	if !strings.Contains(status.Error, "CONFLICT") {
		t.Fatalf("error should surface git conflict, got %q", status.Error)
	}
	aborted := false
	for _, call := range manager.git.(*fakeRunner).calls {
		if has(call, "merge") && has(call, "--abort") {
			aborted = true
		}
	}
	if !aborted {
		t.Fatal("merge failure must abort to restore working tree")
	}
}

func TestParseCommits(t *testing.T) {
	raw := "abc123\x1ffix: 修复\x1fAlice\x1f2026-10-20T12:00:00+08:00\n"
	commits := parseCommits(raw)
	if len(commits) != 1 || commits[0].Hash != "abc123" || commits[0].Subject != "fix: 修复" {
		t.Fatalf("unexpected commits: %+v", commits)
	}
}

func has(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
