package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"yingce/local-host-updater/hostupdate"
)

const (
	appID          = "dev-yingce-main"
	appManifestID  = "yingce-main"
	connectorID    = "yingce-local"
	dxosSessionEsc = "dxos"
)

// dxosConfig 描述 DXOS 版影策的构建形态：跟随 dev 分支，打 ZIP 包，交给 DXOS 导入。
type dxosConfig struct {
	RepoDir     string
	StateDir    string
	BackupDir   string
	OutputDir   string
	DXOSBaseURL string
	BackendURL  string
	UpstreamRef string
	Branch      string
	StepTimeout time.Duration
	StableWindow time.Duration
}

type dxosManager struct {
	mu     sync.Mutex
	config dxosConfig
	status hostupdate.Status
	// dxosCookie 是 DXOS 桌面会话 cookie，运行期缓存；失效时重新登录。
	dxosCookie string
}

type dxosPersistedState struct {
	LatestRelease   *hostupdate.Release  `json:"latestRelease,omitempty"`
	LastBackup      *hostupdate.Backup   `json:"lastBackup,omitempty"`
	RollbackVersion string               `json:"rollbackVersion,omitempty"`
	Operation       hostupdate.Operation `json:"operation"`
}

// defaultRepoDir 假定二进制在 <repo>/tools/dxos-updater 或 <repo>/bin 下，
// 这样换机器/换目录不用改代码；不成立时用当前工作目录。
func defaultRepoDir() string {
	if executable, err := os.Executable(); err == nil {
		dir := filepath.Dir(executable)
		for i := 0; i < 3; i++ {
			if _, err := os.Stat(filepath.Join(dir, "dxos-app", "build.py")); err == nil {
				return dir
			}
			dir = filepath.Dir(dir)
		}
	}
	if wd, err := os.Getwd(); err == nil {
		return wd
	}
	return "."
}

func newDXOSManager() (*dxosManager, error) {
	repo := env("UPDATER_REPO_DIR", defaultRepoDir())
	stateDir := filepath.Join(repo, ".local", "state", "dxos-updater")
	backupDir := filepath.Join(repo, ".local", "backups", "dxos-updater")
	for _, dir := range []string{stateDir, backupDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	config := dxosConfig{
		RepoDir:     repo,
		StateDir:    stateDir,
		BackupDir:   backupDir,
		OutputDir:   env("UPDATER_OUTPUT_DIR", filepath.Join(repo, "output", "dxos-app")),
		DXOSBaseURL: env("UPDATER_DXOS_URL", "http://127.0.0.1:5275"),
		BackendURL:  env("UPDATER_BACKEND_URL", "http://127.0.0.1:1724"),
		UpstreamRef: env("UPDATER_UPSTREAM_REF", "upstream/main"),
		Branch:      env("UPDATER_BRANCH", "dev"),
		StepTimeout: 60 * time.Minute,
		StableWindow: 15 * time.Second,
	}
	manager := &dxosManager{
		config: config,
		status: hostupdate.Status{
			Supported:  true,
			Connected:  true,
			Repository: "local:dev",
			Deployment: "dxos-zip",
			Checks:     []hostupdate.Check{},
			Operation:  hostupdate.Operation{Phase: hostupdate.PhaseIdle, Logs: []hostupdate.LogEntry{}},
		},
	}
	manager.loadState()
	// 启动时尽力探一次已安装版本；DXOS 没起来也不影响进程可用。
	initCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	if installed, err := manager.dxosInstalledApp(initCtx); err == nil && installed != "" {
		manager.status.CurrentVersion = installed
	}
	cancel()
	return manager, nil
}

// ---------------- 对外接口 ----------------

func (m *dxosManager) Snapshot() hostupdate.Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshotLocked()
}

func (m *dxosManager) Check(ctx context.Context) (hostupdate.Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.status.Operation.Phase = hostupdate.PhaseChecking
	m.logLocked(hostupdate.PhaseChecking, "读取上游 main 与 dev 分支")
	m.saveLocked()

	installed, err := m.dxosInstalledApp(ctx)
	if err != nil {
		m.status.Connected = false
		m.status.Operation.Phase = hostupdate.PhaseFailed
		m.status.Operation.Error = "连接 DXOS 失败：" + err.Error()
		m.logLocked(hostupdate.PhaseFailed, m.status.Operation.Error)
		m.saveLocked()
		return m.snapshotLocked(), err
	}
	m.status.Connected = true
	m.status.CurrentVersion = installed
	release, targetCommit, err := m.resolveTarget(ctx)
	if err != nil {
		m.status.Operation.Phase = hostupdate.PhaseFailed
		m.status.Operation.Error = err.Error()
		m.logLocked(hostupdate.PhaseFailed, "检查更新失败："+err.Error())
		m.saveLocked()
		return m.snapshotLocked(), err
	}
	currentCommit := m.installedCommit(ctx)
	m.status.LatestRelease = release
	m.status.UpdateAvailable = !sameCommit(targetCommit, currentCommit)
	if m.status.UpdateAvailable {
		m.status.Operation.Phase = hostupdate.PhaseReady
		m.logLocked(hostupdate.PhaseReady, fmt.Sprintf("可更新到 %s（dev %s）", release.Version, short(targetCommit)))
	} else {
		m.status.Operation.Phase = hostupdate.PhaseNoUpdate
		m.logLocked(hostupdate.PhaseNoUpdate, "DXOS 影策已是最新 dev 提交")
	}
	m.status.Operation.Error = ""
	m.saveLocked()
	return m.snapshotLocked(), nil
}

func (m *dxosManager) StartUpdate(targetVersion string) (hostupdate.Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.status.Operation.Phase.Active() {
		return m.snapshotLocked(), errors.New("已有更新操作正在进行")
	}
	if m.status.LatestRelease == nil || m.status.LatestRelease.Version != targetVersion {
		return m.snapshotLocked(), errors.New("目标版本与最近一次检查结果不一致，请重新检查")
	}
	fromVersion := m.status.CurrentVersion
	now := time.Now().UTC()
	m.status.Operation = hostupdate.Operation{
		ID:            short(fmt.Sprintf("%d", now.UnixNano())),
		Phase:         hostupdate.PhasePreflight,
		FromVersion:   fromVersion,
		TargetVersion: targetVersion,
		StartedAt:     &now,
		Logs:          []hostupdate.LogEntry{{At: now, Phase: hostupdate.PhasePreflight, Message: "开始更新前检查"}},
	}
	m.saveLocked()
	go m.runUpdate(fromVersion, targetVersion)
	return m.snapshotLocked(), nil
}

func (m *dxosManager) StartRollback(reason string) (hostupdate.Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.status.Operation.Phase.Active() {
		return m.snapshotLocked(), errors.New("已有更新操作正在进行")
	}
	if m.status.RollbackVersion == "" || m.status.LastBackup == nil {
		return m.snapshotLocked(), errors.New("没有可用的回退版本或已校验备份")
	}
	if m.status.RollbackVersion == m.status.CurrentVersion {
		return m.snapshotLocked(), errors.New("当前版本与可回退版本相同，无需回退")
	}
	now := time.Now().UTC()
	target := m.status.RollbackVersion
	m.status.Operation = hostupdate.Operation{
		ID:            short(fmt.Sprintf("%d", now.UnixNano())),
		Phase:         hostupdate.PhaseRollingBack,
		FromVersion:   m.status.CurrentVersion,
		TargetVersion: target,
		StartedAt:     &now,
		Logs:          []hostupdate.LogEntry{{At: now, Phase: hostupdate.PhaseRollingBack, Message: "管理员发起回退：" + strings.TrimSpace(reason)}},
	}
	backup := *m.status.LastBackup
	m.saveLocked()
	go m.runRollback(target, backup)
	return m.snapshotLocked(), nil
}

// ---------------- 状态 ----------------

func (m *dxosManager) snapshotLocked() hostupdate.Status {
	status := m.status
	status.Supported = true
	status.Checks = []hostupdate.Check{
		{Key: "updater", Label: "DXOS 更新器", Status: "passed", Detail: "unix socket", Blocking: true},
		{Key: "dxos", Label: "DXOS 宿主", Status: "passed", Detail: m.config.DXOSBaseURL, Blocking: true},
		{Key: "backup", Label: "数据目录备份", Status: "pending", Detail: "开始更新后自动创建", Blocking: true},
		{Key: "build", Label: "后端与前端构建", Status: "pending", Detail: "在 dev 上编译后端并打包 ZIP", Blocking: true},
		{Key: "install", Label: "DXOS 导入安装", Status: "pending", Detail: "通过 DXOS 本地导入接口覆盖安装", Blocking: true},
	}
	if m.status.LastBackup != nil {
		status.Checks[2].Status = "passed"
		status.Checks[2].Detail = m.status.LastBackup.ID
	}
	if status.CurrentVersion != "" {
		status.Checks[3].Status = "passed"
		status.Checks[3].Detail = status.CurrentVersion
	}
	if status.CurrentVersion != "" && m.status.Connected {
		status.Checks[4].Status = "passed"
		status.Checks[4].Detail = "已安装 " + status.CurrentVersion
	}
	status.Operation.Logs = append([]hostupdate.LogEntry{}, status.Operation.Logs...)
	return status
}

func (m *dxosManager) logLocked(phase hostupdate.Phase, message string) {
	m.status.Operation.Logs = append(m.status.Operation.Logs, hostupdate.LogEntry{At: time.Now().UTC(), Phase: phase, Message: message})
	if len(m.status.Operation.Logs) > 200 {
		m.status.Operation.Logs = m.status.Operation.Logs[len(m.status.Operation.Logs)-200:]
	}
}

func (m *dxosManager) setPhase(phase hostupdate.Phase, message string) {
	m.mu.Lock()
	m.status.Operation.Phase = phase
	m.logLocked(phase, message)
	m.saveLocked()
	m.mu.Unlock()
}

func (m *dxosManager) statePath() string { return filepath.Join(m.config.StateDir, "state.json") }

func (m *dxosManager) loadState() {
	data, err := os.ReadFile(m.statePath())
	if err != nil {
		return
	}
	var state dxosPersistedState
	if json.Unmarshal(data, &state) != nil {
		return
	}
	m.status.LatestRelease = state.LatestRelease
	m.status.LastBackup = state.LastBackup
	m.status.RollbackVersion = state.RollbackVersion
	if state.Operation.Phase != "" {
		m.status.Operation = state.Operation
	}
	if m.status.Operation.Logs == nil {
		m.status.Operation.Logs = []hostupdate.LogEntry{}
	}
	if m.status.Operation.Phase.Active() {
		m.status.Operation.Phase = hostupdate.PhaseManualIntervention
		m.status.Operation.Error = "更新器在操作期间退出，请检查 DXOS 与数据目录后手工处理"
	}
}

func (m *dxosManager) saveLocked() {
	state := dxosPersistedState{
		LatestRelease:   m.status.LatestRelease,
		LastBackup:      m.status.LastBackup,
		RollbackVersion: m.status.RollbackVersion,
		Operation:       m.status.Operation,
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return
	}
	temporary := m.statePath() + ".tmp"
	if os.WriteFile(temporary, data, 0o600) == nil {
		_ = os.Rename(temporary, m.statePath())
	}
}

// ---------------- 上游解析 ----------------

func (m *dxosManager) resolveTarget(ctx context.Context) (*hostupdate.Release, string, error) {
	if out, err := m.git(ctx, m.config.RepoDir, "fetch", "upstream", "--prune"); err != nil {
		return nil, "", fmt.Errorf("拉取上游失败：%s", strings.TrimSpace(out))
	}
	devOut, err := m.git(ctx, m.config.RepoDir, "rev-parse", m.config.Branch)
	if err != nil {
		return nil, "", fmt.Errorf("解析 %s 失败：%s", m.config.Branch, strings.TrimSpace(devOut))
	}
	upstreamOut, err := m.git(ctx, m.config.RepoDir, "rev-parse", m.config.UpstreamRef)
	if err != nil {
		return nil, "", fmt.Errorf("解析上游提交失败：%s", strings.TrimSpace(upstreamOut))
	}
	dev := strings.TrimSpace(devOut)
	upstream := strings.TrimSpace(upstreamOut)
	behind, _ := m.git(ctx, m.config.RepoDir, "rev-list", "--count", dev+".."+upstream)
	versionOut, err := m.git(ctx, m.config.RepoDir, "show", dev+":VERSION")
	if err != nil {
		return nil, "", fmt.Errorf("读取 VERSION 失败：%s", strings.TrimSpace(versionOut))
	}
	version := strings.TrimPrefix(strings.TrimSpace(versionOut), "v")
	subjectOut, _ := m.git(ctx, m.config.RepoDir, "log", "-1", "--format=%s", dev)
	dateOut, _ := m.git(ctx, m.config.RepoDir, "log", "-1", "--format=%cI", dev)
	publishedAt, _ := time.Parse(time.RFC3339, strings.TrimSpace(dateOut))
	body := fmt.Sprintf("跟随 dev：%s\n\n提交：%s\n上游 main：%s（落后 %s 个提交）\n构建方式：本机编译后端 + 打包 DXOS ZIP",
		strings.TrimSpace(subjectOut), dev, short(upstream), strings.TrimSpace(behind))
	release := &hostupdate.Release{
		Version:     "v" + version + "-" + short(dev),
		Name:        "dev " + version + " · " + short(dev),
		Body:        body,
		URL:         "https://github.com/ddcat-ai/open-ai-canvas/commit/" + dev,
		PublishedAt: publishedAt,
		Prerelease:  true,
	}
	return release, dev, nil
}

// ---------------- 更新主流程 ----------------

func (m *dxosManager) runUpdate(fromVersion, targetVersion string) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Minute)
	defer cancel()

	commit, _, err := parseLocalTarget(targetVersion)
	if err != nil {
		m.fail(hostupdate.PhaseFailed, err)
		return
	}

	m.setPhase(hostupdate.PhasePreflight, "校验工作区与工具链")
	if err := m.preflight(ctx, commit); err != nil {
		m.fail(hostupdate.PhaseFailed, err)
		return
	}

	m.setPhase(hostupdate.PhaseBackingUp, "备份 DXOS 数据目录")
	// 影策数据目录约 600 MB，无上限保留会很快吃满磁盘；只留最近几份。
	m.pruneBackups(3)
	backup, err := m.createBackup(fromVersion)
	if err != nil {
		m.fail(hostupdate.PhaseFailed, err)
		return
	}
	m.mu.Lock()
	m.status.LastBackup = &backup
	m.status.RollbackVersion = fromVersion
	m.saveLocked()
	m.mu.Unlock()

	m.setPhase(hostupdate.PhasePulling, "编译后端并构建前端（约 10-20 分钟）")
	zipPath, err := m.buildPackage(ctx, commit)
	if err != nil {
		m.fail(hostupdate.PhaseFailed, err)
		return
	}

	m.setPhase(hostupdate.PhaseSwitching, "通过 DXOS 导入接口安装")
	if err := m.installPackage(ctx, zipPath); err != nil {
		// 导入失败 = 应用根本没被替换，当前安装还是原版本。
		// 此时绝不能调 DXOS 回退：那会退到更早的历史版本（可能是别的包），
		// 还会白白覆盖一遍数据目录。只如实报错，让用户重试。
		m.fail(hostupdate.PhaseFailed, fmt.Errorf("导入安装包失败，当前版本未改动：%w", err))
		return
	}

	m.setPhase(hostupdate.PhaseVerifying, "验证 DXOS 已加载新版本")
	installed, err := m.waitInstalled(ctx, commit)
	if err != nil {
		// 包已经换掉了但新后端没起来，这才需要恢复数据并回退应用。
		m.rollbackTo(fromVersion, backup, fmt.Errorf("新版本未生效：%w", err))
		return
	}

	m.mu.Lock()
	now := time.Now().UTC()
	m.status.Operation.Phase = hostupdate.PhaseSucceeded
	m.status.Operation.FinishedAt = &now
	m.status.Operation.Error = ""
	m.status.RollbackVersion = fromVersion
	m.status.CurrentVersion = installed
	m.status.UpdateAvailable = false
	m.logLocked(hostupdate.PhaseSucceeded, fmt.Sprintf("DXOS 影策已更新到 %s（dev %s）", installed, short(commit)))
	m.saveLocked()
	m.mu.Unlock()
}

func (m *dxosManager) runRollback(targetVersion string, backup hostupdate.Backup) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()
	m.setPhase(hostupdate.PhaseRollingBack, "恢复数据目录并回退 DXOS 应用")
	if err := m.stopBackend(ctx); err != nil {
		m.manual(fmt.Errorf("无法停止影策后端，已中止回退：%w", err))
		return
	}
	if err := m.restoreBackup(ctx, backup); err != nil {
		m.manual(fmt.Errorf("恢复数据目录失败：%w", err))
		return
	}
	if err := m.rollbackDXOSApp(ctx, targetVersion); err != nil {
		m.manual(err)
		return
	}
	_ = m.refreshConnector(ctx)
	installed, _ := m.dxosInstalledApp(ctx)
	m.mu.Lock()
	now := time.Now().UTC()
	m.status.Operation.Phase = hostupdate.PhaseRolledBack
	m.status.Operation.FinishedAt = &now
	if installed != "" {
		m.status.RollbackVersion = m.status.CurrentVersion
		m.status.CurrentVersion = installed
	}
	m.logLocked(hostupdate.PhaseRolledBack, "已回退到 "+installed)
	m.saveLocked()
	m.mu.Unlock()
}

func (m *dxosManager) rollbackTo(fromVersion string, backup hostupdate.Backup, cause error) {
	// 失败原因必须留在操作记录里：否则用户只看到"自动回退完成"，不知道新版本为什么没装上。
	m.mu.Lock()
	m.status.Operation.Error = cause.Error()
	m.logLocked(hostupdate.PhaseRollingBack, "更新失败："+cause.Error())
	m.mu.Unlock()
	m.setPhase(hostupdate.PhaseRollingBack, "更新失败，自动回退")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	if err := m.stopBackend(ctx); err != nil {
		m.manual(fmt.Errorf("无法停止影策后端，已中止回退：%w", err))
		return
	}
	if err := m.restoreBackup(ctx, backup); err != nil {
		m.manual(err)
		return
	}
	if err := m.rollbackDXOSApp(ctx, fromVersion); err != nil {
		m.manual(err)
		return
	}
	_ = m.refreshConnector(ctx)
	installed, _ := m.dxosInstalledApp(ctx)
	m.mu.Lock()
	now := time.Now().UTC()
	m.status.Operation.Phase = hostupdate.PhaseRolledBack
	m.status.Operation.FinishedAt = &now
	m.status.Operation.AutomaticRollback = true
	if installed != "" {
		// 回退成功后把「可回退目标」换成刚被换下的版本；否则重复点回退会一路退到更老的版本。
		m.status.RollbackVersion = m.status.CurrentVersion
		m.status.CurrentVersion = installed
	}
	m.logLocked(hostupdate.PhaseRolledBack, "自动回退完成："+installed+errSuffix(m.status.Operation.Error))
	m.saveLocked()
	m.mu.Unlock()
}

func errSuffix(err string) string {
	if strings.TrimSpace(err) == "" {
		return ""
	}
	return "（失败原因：" + err + "）"
}

func (m *dxosManager) fail(phase hostupdate.Phase, err error) {
	m.mu.Lock()
	m.status.Operation.Phase = phase
	m.status.Operation.Error = err.Error()
	m.logLocked(phase, err.Error())
	m.saveLocked()
	m.mu.Unlock()
}

func (m *dxosManager) manual(err error) {
	m.mu.Lock()
	m.status.Operation.Phase = hostupdate.PhaseManualIntervention
	m.status.Operation.Error = err.Error()
	m.logLocked(hostupdate.PhaseManualIntervention, err.Error())
	m.saveLocked()
	m.mu.Unlock()
}
