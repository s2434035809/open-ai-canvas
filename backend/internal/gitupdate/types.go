// Package gitupdate 在开发部署中把上游 main 安全合并进 dev。
//
// 设计约束：
//   - 只读检查与冲突预演一律在临时 worktree 中进行，绝不改动工作区；
//   - 只有构建与测试全部通过后才真正合并，任一步失败即回到原状态；
//   - 用户未跟踪文件与未提交改动永不 stash、覆盖或删除。
package gitupdate

import "time"

type Phase string

const (
	PhaseIdle      Phase = "idle"
	PhaseChecking  Phase = "checking"
	PhaseReady     Phase = "ready"
	PhaseNoUpdate  Phase = "no_update"
	PhaseBlocked   Phase = "blocked"
	PhaseMerging   Phase = "merging"
	PhaseFailed    Phase = "failed"
	PhaseSucceeded Phase = "succeeded"
)

func (p Phase) Busy() bool {
	return p == PhaseChecking || p == PhaseMerging
}

// DisabledStatus 是未开启该能力时的状态。
// 所有切片都必须非 nil，否则序列化成 null，前端读 .length 会直接崩。
func DisabledStatus() Status {
	return Status{
		Phase:     PhaseIdle,
		Merge:     Merge{Files: []string{}, ConflictFiles: []string{}},
		Commits:   []Commit{},
		Dirty:     []string{},
		Untracked: []string{},
		Checks:    []Check{},
		Logs:      []LogEntry{},
	}
}

type Commit struct {
	Hash    string    `json:"hash"`
	Subject string    `json:"subject"`
	Author  string    `json:"author"`
	At      time.Time `json:"at"`
}

type Check struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Status   string `json:"status"`
	Detail   string `json:"detail,omitempty"`
	Blocking bool   `json:"blocking"`
}

type Merge struct {
	Branch          string   `json:"branch"`
	UpstreamRef     string   `json:"upstreamRef"`
	LocalHead       string   `json:"localHead"`
	UpstreamHead    string   `json:"upstreamHead"`
	Behind          int      `json:"behind"`
	Ahead           int      `json:"ahead"`
	IncomingCommits int      `json:"incomingCommits"`
	Files           []string `json:"files"`
	ConflictFiles   []string `json:"conflictFiles"`
	PreviewOK       bool     `json:"previewOk"`
	BuildOK         bool     `json:"buildOk"`
	TestOK          bool     `json:"testOk"`
}

type LogEntry struct {
	At      time.Time `json:"at"`
	Phase   Phase     `json:"phase"`
	Message string    `json:"message"`
}

type Status struct {
	Enabled         bool       `json:"enabled"`
	Repository      string     `json:"repository"`
	Branch          string     `json:"branch"`
	FetchError      string     `json:"fetchError,omitempty"`
	LocalHead       string     `json:"localHead"`
	UpstreamHead    string     `json:"upstreamHead"`
	UpdateAvailable bool       `json:"updateAvailable"`
	Mergeable       bool       `json:"mergeable"`
	Merge           Merge      `json:"merge"`
	Commits         []Commit   `json:"commits"`
	Dirty           []string   `json:"dirty"`
	Untracked       []string   `json:"untracked"`
	Checks          []Check    `json:"checks"`
	Phase           Phase      `json:"phase"`
	Error           string     `json:"error,omitempty"`
	StartedAt       *time.Time `json:"startedAt,omitempty"`
	FinishedAt      *time.Time `json:"finishedAt,omitempty"`
	Logs            []LogEntry `json:"logs"`
}
