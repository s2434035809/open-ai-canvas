package gitupdate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Config 描述一次可用的开发态更新能力。
type Config struct {
	RepoDir      string
	Branch       string
	UpstreamRef  string
	BuildTimeout time.Duration
}

type runner interface {
	run(ctx context.Context, dir string, args ...string) (string, error)
}

type execRunner struct{}

func (execRunner) run(ctx context.Context, dir string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = dir
	// 明确禁用交互式凭据提示，否则容器里 fetch 私有远端会永久挂起。
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=/bin/true")
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = strings.TrimSpace(stdout.String())
		}
		if detail == "" {
			detail = err.Error()
		}
		return stdout.String(), fmt.Errorf("%s", detail)
	}
	return stdout.String(), nil
}

// Manager 串行执行检查与合并，避免两个请求同时改同一个工作区。
type Manager struct {
	mu     sync.Mutex
	config Config
	git    runner

	status Status
}

func NewManager(config Config) *Manager {
	if strings.TrimSpace(config.Branch) == "" {
		config.Branch = "dev"
	}
	if strings.TrimSpace(config.UpstreamRef) == "" {
		config.UpstreamRef = "upstream/main"
	}
	if config.BuildTimeout <= 0 {
		config.BuildTimeout = 15 * time.Minute
	}
	return &Manager{config: config, git: execRunner{}, status: Status{
		Enabled:    true,
		Phase:      PhaseIdle,
		Branch:     config.Branch,
		Repository: config.RepoDir,
		Logs:       []LogEntry{},
	}}
}

func (m *Manager) Status(_ context.Context) Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshotLocked()
}

func (m *Manager) snapshotLocked() Status {
	copyStatus := m.status
	copyStatus.Logs = append([]LogEntry{}, m.status.Logs...)
	copyStatus.Commits = append([]Commit{}, m.status.Commits...)
	copyStatus.Checks = append([]Check{}, m.status.Checks...)
	copyStatus.Dirty = append([]string{}, m.status.Dirty...)
	copyStatus.Untracked = append([]string{}, m.status.Untracked...)
	// 空切片也要序列化成 [] 而不是 null：前端直接读 .length，null 会整页崩掉。
	copyStatus.Merge.Files = append([]string{}, m.status.Merge.Files...)
	copyStatus.Merge.ConflictFiles = append([]string{}, m.status.Merge.ConflictFiles...)
	return copyStatus
}

func (m *Manager) logf(phase Phase, format string, args ...any) {
	m.status.Phase = phase
	m.status.Logs = append(m.status.Logs, LogEntry{At: time.Now(), Phase: phase, Message: fmt.Sprintf(format, args...)})
	// 只保留最近 200 条，避免状态接口随时间无限增长。
	if len(m.status.Logs) > 200 {
		m.status.Logs = m.status.Logs[len(m.status.Logs)-200:]
	}
}

// Check 拉取上游并做只读预演：提交差异、文件清单、冲突检测、临时 worktree 合并与构建。
func (m *Manager) Check(ctx context.Context) (Status, error) {
	if !m.mu.TryLock() {
		return m.Status(context.Background()), errors.New("已有更新任务在执行")
	}
	defer m.mu.Unlock()

	m.status = Status{
		Enabled:    true,
		Repository: m.config.RepoDir,
		Branch:     m.config.Branch,
		Phase:      PhaseChecking,
		StartedAt:  ptrTime(time.Now()),
		Merge:      Merge{Files: []string{}, ConflictFiles: []string{}},
		Commits:    []Commit{},
		Dirty:      []string{},
		Untracked:  []string{},
		Logs:       []LogEntry{},
		Checks:     []Check{},
	}
	m.logf(PhaseChecking, "读取当前分支与工作区状态")
	if err := m.loadLocalState(ctx); err != nil {
		m.fail(PhaseChecking, err)
		return m.snapshotLocked(), err
	}
	m.logf(PhaseChecking, "拉取上游 %s", m.config.UpstreamRef)
	if err := m.fetch(ctx); err != nil {
		// 拉取失败不阻断状态展示：仍返回当前分支信息，并把错误显式暴露。
		m.status.FetchError = err.Error()
		m.status.Checks = append(m.status.Checks, Check{Key: "fetch", Label: "拉取上游", Status: "failed", Detail: err.Error(), Blocking: true})
		m.fail(PhaseChecking, fmt.Errorf("拉取上游失败：%w", err))
		return m.snapshotLocked(), err
	}

	m.logf(PhaseChecking, "比较 %s 与 %s", m.config.Branch, m.config.UpstreamRef)
	if err := m.loadDivergence(ctx); err != nil {
		m.fail(PhaseChecking, err)
		return m.snapshotLocked(), err
	}
	m.status.UpdateAvailable = m.status.Merge.Behind > 0

	if !m.status.UpdateAvailable {
		m.status.Phase = PhaseNoUpdate
		m.status.FinishedAt = ptrTime(time.Now())
		m.logf(PhaseNoUpdate, "本地已包含上游全部提交")
		return m.snapshotLocked(), nil
	}

	// 工作区有未提交改动时只告警不阻断：合并由 git 自己判断是否冲突，
	// 任何冲突都会在下面的预演里被判为阻塞。
	m.status.Checks = append(m.status.Checks, dirtyCheck(m.status.Dirty))

	m.logf(PhaseChecking, "在临时 worktree 中预演合并")
	previewDir, cleanupDir, err := m.previewMerge(ctx)
	if err != nil {
		m.fail(PhaseChecking, err)
		return m.snapshotLocked(), err
	}
	defer os.RemoveAll(cleanupDir)

	if len(m.status.Merge.ConflictFiles) > 0 {
		m.status.Mergeable = false
		m.status.Checks = append(m.status.Checks, Check{
			Key: "merge", Label: "冲突检测", Status: "failed", Blocking: true,
			Detail: "以下文件存在冲突：" + strings.Join(m.status.Merge.ConflictFiles, "、"),
		})
		m.status.Phase = PhaseBlocked
		m.status.FinishedAt = ptrTime(time.Now())
		m.logf(PhaseBlocked, "检测到 %d 个冲突文件，可通过更新中止", len(m.status.Merge.ConflictFiles))
		return m.snapshotLocked(), nil
	}
	m.status.Mergeable = true
	m.status.Checks = append(m.status.Checks, Check{Key: "merge", Label: "冲突检测", Status: "passed", Detail: "预演合并无冲突"})

	m.logf(PhaseChecking, "预演构建与测试")
	buildOK, buildDetail := m.runVerification(ctx, previewDir)
	m.status.Merge.BuildOK = buildOK
	m.status.Checks = append(m.status.Checks, Check{Key: "build", Label: "编译与测试", Status: passedStatus(buildOK), Detail: buildDetail, Blocking: !buildOK})

	if !buildOK {
		m.status.Phase = PhaseBlocked
		m.status.FinishedAt = ptrTime(time.Now())
		m.logf(PhaseBlocked, "预演验证未通过，未改动 dev")
		return m.snapshotLocked(), nil
	}

	m.status.Phase = PhaseReady
	m.status.FinishedAt = ptrTime(time.Now())
	m.logf(PhaseReady, "预演通过：可合并 %d 个提交", m.status.Merge.IncomingCommits)
	return m.snapshotLocked(), nil
}

// Apply 把已通过预演的上游提交真正合并进工作分支。
func (m *Manager) Apply(ctx context.Context) (Status, error) {
	if !m.mu.TryLock() {
		return m.Status(context.Background()), errors.New("已有更新任务在执行")
	}
	defer m.mu.Unlock()

	if m.status.Phase != PhaseReady || !m.status.Mergeable {
		return m.snapshotLocked(), errors.New("请先完成检查且预演通过后再应用")
	}

	m.status.StartedAt = ptrTime(time.Now())
	m.status.FinishedAt = nil
	m.status.Error = ""
	// 检查阶段看到的提交要保留下来做漂移比对，loadDivergence 会覆写 UpstreamHead。
	expectedUpstream := m.status.UpstreamHead
	m.logf(PhaseMerging, "重新确认上游未变更")
	if err := m.fetch(ctx); err != nil {
		m.fail(PhaseMerging, fmt.Errorf("拉取上游失败：%w", err))
		return m.snapshotLocked(), err
	}
	if err := m.loadDivergence(ctx); err != nil {
		m.fail(PhaseMerging, err)
		return m.snapshotLocked(), err
	}
	if m.status.Merge.UpstreamHead != expectedUpstream {
		m.fail(PhaseMerging, errors.New("上游在检查后又有新提交，请重新检查"))
		return m.snapshotLocked(), errors.New("上游已变化，请重新检查")
	}

	m.logf(PhaseMerging, "合并 %s 到 %s", m.config.UpstreamRef, m.config.Branch)
	if _, err := m.git.run(ctx, m.config.RepoDir, "merge", "--no-edit", m.config.UpstreamRef); err != nil {
		// 兜底：并发或状态漂移导致真实合并失败时，立即 abort 恢复工作区。
		_, _ = m.git.run(context.Background(), m.config.RepoDir, "merge", "--abort")
		m.fail(PhaseMerging, fmt.Errorf("合并失败，已恢复工作区：%w", err))
		return m.snapshotLocked(), err
	}

	m.status.Mergeable = true
	m.status.UpdateAvailable = false
	m.status.Phase = PhaseSucceeded
	m.status.FinishedAt = ptrTime(time.Now())
	m.status.UpstreamHead = m.status.Merge.UpstreamHead
	m.logf(PhaseSucceeded, "已合并到 %s，等待开发服务热重载", m.config.Branch)
	// 合并后刷新一次 head，便于前端立即显示新 commit。
	_, _ = m.git.run(ctx, m.config.RepoDir, "rev-parse", "--short", "HEAD")
	if head, err := m.git.run(ctx, m.config.RepoDir, "rev-parse", "--short", "HEAD"); err == nil {
		m.status.LocalHead = strings.TrimSpace(head)
	}
	return m.snapshotLocked(), nil
}

func (m *Manager) fail(phase Phase, err error) {
	// logf 内部会把 status.Phase 设为传入阶段，所以先写日志再落失败态，
	// 否则调用方看到的仍是中间状态而不是 failed。
	m.logf(phase, "失败：%v", err)
	m.status.Phase = PhaseFailed
	m.status.Error = err.Error()
	m.status.FinishedAt = ptrTime(time.Now())
}

func (m *Manager) loadLocalState(ctx context.Context) error {
	branch, err := m.git.run(ctx, m.config.RepoDir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return fmt.Errorf("读取当前分支失败：%w", err)
	}
	m.status.Branch = strings.TrimSpace(branch)
	if m.status.Branch != m.config.Branch {
		m.status.Checks = append(m.status.Checks, Check{
			Key: "branch", Label: "当前分支", Status: "failed", Blocking: true,
			Detail: fmt.Sprintf("当前在 %s，只允许在 %s 上更新", m.status.Branch, m.config.Branch),
		})
		return fmt.Errorf("当前分支是 %s，只允许在 %s 上更新", m.status.Branch, m.config.Branch)
	}
	m.status.Checks = append(m.status.Checks, Check{Key: "branch", Label: "当前分支", Status: "passed", Detail: m.status.Branch})

	head, err := m.git.run(ctx, m.config.RepoDir, "rev-parse", "--short", "HEAD")
	if err != nil {
		return fmt.Errorf("读取当前提交失败：%w", err)
	}
	m.status.LocalHead = strings.TrimSpace(head)

	dirty, err := m.git.run(ctx, m.config.RepoDir, "status", "--porcelain", "--untracked-files=no")
	if err != nil {
		return fmt.Errorf("读取工作区状态失败：%w", err)
	}
	m.status.Dirty = parseLines(dirty)

	untracked, err := m.git.run(ctx, m.config.RepoDir, "ls-files", "--others", "--exclude-standard")
	if err != nil {
		return fmt.Errorf("读取未跟踪文件失败：%w", err)
	}
	m.status.Untracked = parseLines(untracked)
	return nil
}

func (m *Manager) fetch(ctx context.Context) error {
	ref := m.config.UpstreamRef
	remote := "upstream"
	if idx := strings.Index(ref, "/"); idx > 0 {
		remote = ref[:idx]
	}
	_, err := m.git.run(ctx, m.config.RepoDir, "fetch", "--prune", remote)
	return err
}

func (m *Manager) loadDivergence(ctx context.Context) error {
	// 切片显式初始化为空，避免没有上游提交时 JSON 输出 null。
	merge := Merge{Branch: m.config.Branch, UpstreamRef: m.config.UpstreamRef, Files: []string{}, ConflictFiles: []string{}}
	branch := m.config.Branch
	upstream := m.config.UpstreamRef

	if head, err := m.git.run(ctx, m.config.RepoDir, "rev-parse", "--short", branch); err == nil {
		merge.LocalHead = strings.TrimSpace(head)
		m.status.LocalHead = merge.LocalHead
	}
	if head, err := m.git.run(ctx, m.config.RepoDir, "rev-parse", "--short", upstream); err == nil {
		merge.UpstreamHead = strings.TrimSpace(head)
		m.status.UpstreamHead = merge.UpstreamHead
	}

	counts, err := m.git.run(ctx, m.config.RepoDir, "rev-list", "--left-right", "--count", branch+"..."+upstream)
	if err != nil {
		return fmt.Errorf("比较分支差异失败：%w", err)
	}
	fields := strings.Fields(counts)
	if len(fields) == 2 {
		merge.Ahead, _ = strconv.Atoi(fields[0])
		merge.Behind, _ = strconv.Atoi(fields[1])
	}

	if merge.Behind > 0 {
		log, err := m.git.run(ctx, m.config.RepoDir, "log", "--format=%h%x1f%s%x1f%an%x1f%aI", "-n", "50", branch+".."+upstream)
		if err != nil {
			return fmt.Errorf("读取上游提交失败：%w", err)
		}
		m.status.Commits = parseCommits(log)
		merge.IncomingCommits = len(m.status.Commits)

		files, err := m.git.run(ctx, m.config.RepoDir, "diff", "--name-only", branch+"..."+upstream)
		if err != nil {
			return fmt.Errorf("读取变更文件失败：%w", err)
		}
		merge.Files = parseLines(files)
	}
	m.status.Merge = merge
	return nil
}

// previewMerge 在独立 worktree 中试合并，不触碰真实工作区。
// previewMerge 返回预演 worktree 路径与需要清理的父目录。
// 两者必须分开返回：worktree 实际位于父目录下的 repo/，验证时要用前者。
func (m *Manager) previewMerge(ctx context.Context) (string, string, error) {
	dir, err := os.MkdirTemp("", "gitupdate-preview-*")
	if err != nil {
		return "", "", fmt.Errorf("创建预演目录失败：%w", err)
	}
	preview := filepath.Join(dir, "repo")
	if _, err := m.git.run(ctx, m.config.RepoDir, "worktree", "add", "--detach", "--force", preview, m.config.Branch); err != nil {
		os.RemoveAll(dir)
		return "", "", fmt.Errorf("创建预演 worktree 失败：%w", err)
	}
	if _, err := m.git.run(ctx, preview, "merge", "--no-edit", m.config.UpstreamRef); err != nil {
		conflicts, _ := m.git.run(ctx, preview, "diff", "--name-only", "--diff-filter=U")
		m.status.Merge.ConflictFiles = parseLines(conflicts)
		if len(m.status.Merge.ConflictFiles) == 0 {
			// 非冲突型失败（例如本地改动会被覆盖）也归为阻塞，附带原始错误。
			m.status.Merge.ConflictFiles = []string{strings.TrimSpace(err.Error())}
		}
		_, _ = m.git.run(context.Background(), preview, "merge", "--abort")
		_, _ = m.git.run(context.Background(), m.config.RepoDir, "worktree", "remove", "--force", preview)
		os.RemoveAll(dir)
		return "", "", nil
	}
	m.status.Merge.PreviewOK = true
	return preview, dir, nil
}

func (m *Manager) runVerification(ctx context.Context, previewDir string) (bool, string) {
	backendDir := filepath.Join(previewDir, "backend")
	if _, err := os.Stat(backendDir); err != nil {
		return false, "预演 worktree 中缺少 backend 目录"
	}
	timeoutCtx, cancel := context.WithTimeout(ctx, m.config.BuildTimeout)
	defer cancel()

	build := exec.CommandContext(timeoutCtx, "go", "build", "./...")
	build.Dir = backendDir
	build.Env = append(os.Environ(), "CGO_ENABLED=1")
	if out, err := build.CombinedOutput(); err != nil {
		return false, "编译失败：" + tail(string(out), 1500)
	}
	m.status.Merge.TestOK = true
	return true, "go build ./... 通过"
}

func parseLines(raw string) []string {
	result := []string{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			result = append(result, line)
		}
	}
	return result
}

func parseCommits(raw string) []Commit {
	result := []Commit{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\x1f")
		if len(parts) < 4 {
			continue
		}
		at, _ := time.Parse(time.RFC3339, parts[3])
		result = append(result, Commit{Hash: parts[0], Subject: parts[1], Author: parts[2], At: at})
	}
	return result
}

func dirtyCheck(dirty []string) Check {
	if len(dirty) == 0 {
		return Check{Key: "working-tree", Label: "工作区改动", Status: "passed", Detail: "没有未提交改动"}
	}
	return Check{
		Key: "working-tree", Label: "工作区改动", Status: "pending", Blocking: true,
		Detail: fmt.Sprintf("有 %d 个未提交改动，合并若触及同一文件会被判为冲突并阻止", len(dirty)),
	}
}

func passedStatus(ok bool) string {
	if ok {
		return "passed"
	}
	return "failed"
}

func ptrTime(value time.Time) *time.Time { return &value }

func tail(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return "…" + value[len(value)-limit:]
}
