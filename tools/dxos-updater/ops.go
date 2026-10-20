package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"yingce/local-host-updater/hostupdate"
)

// ---------------- 预检 ----------------

func (m *dxosManager) preflight(ctx context.Context, commit string) error {
	if out, err := m.git(ctx, m.config.RepoDir, "diff", "--name-only", "HEAD"); err != nil {
		return fmt.Errorf("检查工作区失败：%s", strings.TrimSpace(out))
	}
	// DXOS 打包走 git archive，必须能确认目标提交已在仓库里。
	if out, err := m.git(ctx, m.config.RepoDir, "cat-file", "-e", commit+"^{commit}"); err != nil {
		return fmt.Errorf("提交不存在：%s（%s）", short(commit), strings.TrimSpace(out))
	}
	if _, err := exec.LookPath("python3"); err != nil {
		return errors.New("找不到 python3")
	}
	for _, tool := range []string{"docker"} {
		if _, err := m.lookTool(tool); err != nil {
			return fmt.Errorf("找不到 %s", tool)
		}
	}
	return m.checkDisk()
}

func (m *dxosManager) lookTool(name string) (string, error) {
	candidates := []string{"/usr/local/bin/" + name, "/opt/homebrew/bin/" + name, "/usr/bin/" + name}
	if home, err := os.UserHomeDir(); err == nil {
		// Docker Desktop 的 CLI 不在系统 PATH 里时，通常装在这里。
		candidates = append(candidates, filepath.Join(home, ".docker", "bin", name))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return exec.LookPath(name)
}

// ---------------- 构建 ----------------

// buildPackage 在目标提交上编译后端、构建前端并打出 DXOS ZIP，返回包路径。
//
// 构建全程在 git archive 导出的临时目录里进行：不切换分支、不碰用户当前检出，
// 所以后台点「更新」不会影响正在编辑的工作区。
func (m *dxosManager) buildPackage(ctx context.Context, commit string) (string, error) {
	stage, err := os.MkdirTemp("", "yingce-dxos-build-")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(stage) }()

	m.setPhase(hostupdate.PhasePulling, "导出目标提交源码")
	archivePath := filepath.Join(stage, "source.tar")
	if out, err := m.git(ctx, m.config.RepoDir, "archive", "--format=tar", "-o", archivePath, commit); err != nil {
		return "", fmt.Errorf("导出源码失败：%s", strings.TrimSpace(out))
	}
	sourceDir := filepath.Join(stage, "source")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		return "", err
	}
	if out, err := m.run(ctx, "", 10*time.Minute, "tar", "-C", sourceDir, "-xf", archivePath); err != nil {
		return "", fmt.Errorf("展开源码失败：%s", tail(out, 800))
	}

	m.setPhase(hostupdate.PhasePulling, "编译目标提交的后端")
	backendBin := filepath.Join(stage, "yingce-backend")
	if out, err := m.runEnv(ctx, sourceDir, 30*time.Minute,
		[]string{"YINGCE_SOURCE_ROOT=" + sourceDir},
		"python3", filepath.Join(m.config.RepoDir, "dxos-app", "build-backend.py"),
		"--output", backendBin, "--commit", commit); err != nil {
		return "", fmt.Errorf("编译后端失败：%s", tail(out, 1500))
	}

	m.setPhase(hostupdate.PhasePulling, "构建前端并打包 ZIP")
	if out, err := m.run(ctx, m.config.RepoDir, 60*time.Minute, "python3",
		filepath.Join(m.config.RepoDir, "dxos-app", "rebuild.py"),
		"--source-root", sourceDir,
		"--package-script", filepath.Join(m.config.RepoDir, "dxos-app", "build.py"),
		"--backend-bin", backendBin); err != nil {
		return "", fmt.Errorf("打包失败：%s", tail(out, 1800))
	}

	zips, err := filepath.Glob(filepath.Join(m.config.OutputDir, "yingce-main-v*.zip"))
	if err != nil || len(zips) == 0 {
		return "", errors.New("未找到生成的 DXOS 安装包")
	}
	sort.Slice(zips, func(i, j int) bool {
		left, _ := os.Stat(zips[i])
		right, _ := os.Stat(zips[j])
		if left == nil || right == nil {
			return false
		}
		return left.ModTime().After(right.ModTime())
	})
	latest := zips[0]
	stat, err := os.Stat(latest)
	if err != nil {
		return "", err
	}
	if stat.Size() > 200<<20 {
		return "", fmt.Errorf("安装包 %.1f MB 超过 DXOS 导入上限 200 MB", float64(stat.Size())/(1<<20))
	}
	return latest, nil
}

// ---------------- DXOS 交互 ----------------

type dxosApp struct {
	ID            string `json:"id"`
	Manifest      struct {
		Version string `json:"version"`
		Build   int64  `json:"build"`
	} `json:"manifest"`
}

// dxosLogin 用桌面管理员凭据换 session cookie。DXOS 只在 127.0.0.1 接受该接口。
func (m *dxosManager) dxosLogin(ctx context.Context) (string, error) {
	if m.dxosCookie != "" {
		return m.dxosCookie, nil
	}
	secret := strings.TrimSpace(os.Getenv("DXOS_DESKTOP_AUTH_SECRET"))
	if secret == "" {
		var err error
		secret, err = readDXOSDesktopSecret()
		if err != nil {
			return "", err
		}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, m.config.DXOSBaseURL+"/api/auth/desktop-session", nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("x-dx-desktop-auth", secret)
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		return "", fmt.Errorf("连接 DXOS 失败：%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 2000))
		return "", fmt.Errorf("DXOS 桌面会话失败（HTTP %d）：%s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	for _, cookie := range response.Cookies() {
		if cookie.Name == "ccs_session" {
			m.dxosCookie = cookie.Name + "=" + cookie.Value
			return m.dxosCookie, nil
		}
	}
	return "", errors.New("DXOS 未返回会话 cookie")
}

// readDXOSDesktopSecret 从正在运行的 DXOS 进程环境里读取桌面凭据。
// DXOS 由本机用户启动，凭据仅用于本地导入接口，不落盘。
func readDXOSDesktopSecret() (string, error) {
	out, err := exec.Command("lsof", "-nP", "-iTCP:5275", "-sTCP:LISTEN", "-t").Output()
	if err != nil {
		return "", errors.New("DXOS 未在运行（5275 端口无监听）")
	}
	pid := strings.TrimSpace(strings.Split(strings.TrimSpace(string(out)), "\n")[0])
	if pid == "" {
		return "", errors.New("DXOS 未在运行")
	}
	env, err := exec.Command("ps", "eww", "-p", pid).Output()
	if err != nil {
		return "", fmt.Errorf("读取 DXOS 进程环境失败：%w", err)
	}
	for _, field := range strings.Split(string(env), " ") {
		if strings.HasPrefix(field, "DX_DESKTOP_AUTH_SECRET=") {
			secret := strings.TrimPrefix(field, "DX_DESKTOP_AUTH_SECRET=")
			if len(secret) >= 32 {
				return secret, nil
			}
		}
	}
	return "", errors.New("未从 DXOS 进程读到桌面凭据")
}

func (m *dxosManager) dxosRequest(ctx context.Context, method, path string, body io.Reader, contentType string) ([]byte, error) {
	// 单次更新可能跑十几分钟，期间 DXOS 会话可能过期；401 时重新登录并重放一次。
	// body 必须是可重读的：调用方传 *bytes.Buffer / *bytes.Reader，这里统一复制一份。
	var payload []byte
	if body != nil {
		var err error
		payload, err = io.ReadAll(io.LimitReader(body, 64<<20))
		if err != nil {
			return nil, err
		}
	}
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			m.dxosCookie = ""
		}
		cookie, err := m.dxosLogin(ctx)
		if err != nil {
			return nil, err
		}
		var reader io.Reader
		if payload != nil {
			reader = bytes.NewReader(payload)
		}
		request, err := http.NewRequestWithContext(ctx, method, m.config.DXOSBaseURL+path, reader)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Cookie", cookie)
		if contentType != "" {
			request.Header.Set("Content-Type", contentType)
		}
		response, err := (&http.Client{Timeout: 5 * time.Minute}).Do(request)
		if err != nil {
			return nil, err
		}
		data, _ := io.ReadAll(io.LimitReader(response.Body, 4<<20))
		response.Body.Close()
		if response.StatusCode == http.StatusUnauthorized && attempt == 0 {
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return data, fmt.Errorf("DXOS 返回 HTTP %d：%s", response.StatusCode, strings.TrimSpace(tail(string(data), 800)))
		}
		return data, nil
	}
	return nil, errors.New("DXOS 会话认证失败")
}

// dxosInstalledApp 返回当前安装的影策版本标识（version+build）。
func (m *dxosManager) dxosInstalledApp(ctx context.Context) (string, error) {
	data, err := m.dxosRequest(ctx, http.MethodGet, "/api/market/developer-apps", nil, "")
	if err != nil {
		return "", err
	}
	var payload struct {
		Apps []dxosApp `json:"apps"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return "", fmt.Errorf("解析 DXOS 应用列表失败：%w", err)
	}
	for _, app := range payload.Apps {
		if app.ID == appID {
			return fmt.Sprintf("%s+%d", app.Manifest.Version, app.Manifest.Build), nil
		}
	}
	return "", nil
}

// installedCommit 从 DXOS 里已安装包内读取构建来源 commit。
func (m *dxosManager) installedCommit(ctx context.Context) string {
	out, err := m.run(ctx, "", 20*time.Second, "python3", "-c", installedCommitScript)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// installPackage 通过 DXOS 本地导入接口覆盖安装。
//
// 120 MB 的包上传 + 解压校验偶发失败（DXOS 侧超时或连接被重置），这类失败重放一次通常就过。
// 重试只针对导入接口本身；导入成功后版本是否正确由 waitInstalled 严格校验。
func (m *dxosManager) installPackage(ctx context.Context, zipPath string) error {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			m.setPhase(hostupdate.PhaseSwitching, "导入失败，5 秒后重试一次")
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(5 * time.Second):
			}
		}
		if err := m.installPackageOnce(ctx, zipPath); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	return lastErr
}

func (m *dxosManager) installPackageOnce(ctx context.Context, zipPath string) error {
	file, err := os.Open(zipPath)
	if err != nil {
		return err
	}
	defer file.Close()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	part, err := writer.CreateFormFile("package", filepath.Base(zipPath))
	if err != nil {
		return err
	}
	if _, err := io.Copy(part, file); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	data, err := m.dxosRequest(ctx, http.MethodPost, "/api/market/developer-apps/import", &buffer, writer.FormDataContentType())
	if err != nil {
		return err
	}
	var payload struct {
		App dxosApp `json:"app"`
	}
	_ = json.Unmarshal(data, &payload)
	return nil
}

// stopBackend 停掉当前运行的影策后端。
//
// 恢复数据目录前必须先停：SQLite 在运行时会持续写 -wal / -shm，覆盖库文件后
// 旧进程的缓冲页会把刚恢复的数据再写坏。这里按「后端二进制路径」识别进程，
// 不动 DXOS 自身。停不掉时返回错误，让调用方进入人工介入而不是带着风险继续。
func (m *dxosManager) stopBackend(ctx context.Context) error {
	out, err := m.run(ctx, "", 20*time.Second, "pgrep", "-f", "source/mcp/yingce-backend.exe")
	if err != nil && strings.TrimSpace(out) == "" {
		return nil // 没有后端在跑
	}
	for _, field := range strings.Fields(out) {
		if out, err := m.run(ctx, "", 20*time.Second, "kill", "-TERM", field); err != nil {
			return fmt.Errorf("停止后端 pid %s 失败：%s", field, strings.TrimSpace(out))
		}
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if out, err := m.run(ctx, "", 10*time.Second, "pgrep", "-f", "source/mcp/yingce-backend.exe"); err != nil || strings.TrimSpace(out) == "" {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return errors.New("后端进程 30 秒内未退出")
}

// rollbackDXOSApp 让 DXOS 回退到上一个历史版本。
func (m *dxosManager) rollbackDXOSApp(ctx context.Context) error {
	data, err := m.dxosRequest(ctx, http.MethodGet, "/api/market/developer-apps/"+appID+"/history", nil, "")
	if err != nil {
		return err
	}
	var payload struct {
		History []struct {
			HistoryID string `json:"historyId"`
		} `json:"history"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return fmt.Errorf("解析历史版本失败：%w", err)
	}
	if len(payload.History) == 0 {
		return errors.New("DXOS 没有可用历史版本")
	}
	body, _ := json.Marshal(map[string]string{"historyId": payload.History[0].HistoryID})
	_, err = m.dxosRequest(ctx, http.MethodPost, "/api/market/developer-apps/"+appID+"/rollback", bytes.NewReader(body), "application/json")
	return err
}

// runningCommit 读取影策后端 /api/health/ready 报告的构建来源。
//
// 只核对安装包里的 dxos-build-source.json 不够：DXOS 重装后连接器可能接管仍在运行的
// 旧后端进程，磁盘上换了新包、实际跑的还是旧二进制。健康接口才是真实运行版本。
func (m *dxosManager) runningCommit(ctx context.Context) (string, string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, m.config.BackendURL+"/api/health/ready", nil)
	if err != nil {
		return "", "", err
	}
	response, err := (&http.Client{Timeout: 8 * time.Second}).Do(request)
	if err != nil {
		return "", "", fmt.Errorf("连接影策后端失败：%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("影策后端健康检查返回 HTTP %d", response.StatusCode)
	}
	var payload struct {
		Data struct {
			Running bool `json:"ready"`
			Build   struct {
				Version string `json:"version"`
				Commit  string `json:"commit"`
			} `json:"build"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return "", "", fmt.Errorf("解析后端健康信息失败：%w", err)
	}
	return payload.Data.Build.Commit, payload.Data.Build.Version, nil
}

// waitInstalled 轮询直到包内来源与运行中的后端都切到目标提交。
func (m *dxosManager) waitInstalled(ctx context.Context, commit string) (string, error) {
	deadline := time.Now().Add(10 * time.Minute)
	var lastDetail string
	for time.Now().Before(deadline) {
		packaged := m.installedCommit(ctx)
		running, _, runErr := m.runningCommit(ctx)
		switch {
		case sameCommit(commit, running):
			version, err := m.dxosInstalledApp(ctx)
			if err == nil && version != "" {
				return version, nil
			}
			lastDetail = "等待 DXOS 刷新应用清单"
		case runErr != nil:
			lastDetail = "等待后端重启：" + runErr.Error()
		case !sameCommit(commit, packaged):
			lastDetail = "等待 DXOS 导入新安装包"
		default:
			// 包已换新但后端还是旧进程：连接器接管了旧后端，需要重连连接器。
			if err := m.refreshConnector(ctx); err == nil {
				lastDetail = "已重连连接器，等待新后端启动"
			} else {
				lastDetail = "重连连接器失败，等待后端重启：" + err.Error()
			}
		}
		m.setPhase(hostupdate.PhaseVerifying, lastDetail)
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(4 * time.Second):
		}
	}
	return "", fmt.Errorf("DXOS 在 10 分钟内未切换到新版本（%s）", lastDetail)
}

// refreshConnector 让 DXOS 重启影策本地连接器，从而拉起新包里的后端。
func (m *dxosManager) refreshConnector(ctx context.Context) error {
	_, err := m.dxosRequest(ctx, http.MethodPost, "/api/mcp/servers/"+connectorID+"/refresh", nil, "")
	return err
}

const installedCommitScript = `
import json,glob,os
# DXOS 在 data/developer-apps/index.json 里记录每个已装应用的 storagePath，
# 包内的 dxos-build-source.json 才是这份安装的真实构建来源。
bases=sorted(glob.glob(os.path.expanduser('~/DXOS/DXOS-Portable-*/data')),reverse=True)
if os.environ.get('DXOS_DATA_DIR'):
    bases.insert(0,os.environ['DXOS_DATA_DIR'])
for base in bases:
    index=os.path.join(base,'developer-apps','index.json')
    try:
        apps=json.load(open(index))
    except Exception:
        continue
    for app in apps if isinstance(apps,list) else []:
        if not isinstance(app,dict) or app.get('id')!='dev-yingce-main':
            continue
        storage=app.get('storagePath') or ''
        if not storage:
            continue
        source=os.path.join(base,'developer-apps',storage,'source','dxos-build-source.json')
        try:
            print(json.load(open(source)).get('commit',''))
        except Exception:
            print('')
        raise SystemExit
print('')
`

// ---------------- 备份 ----------------

func (m *dxosManager) createBackup(version string) (hostupdate.Backup, error) {
	now := time.Now().UTC()
	id := "backup-" + now.Format("20060102-150405")
	path := filepath.Join(m.config.BackupDir, id+".zip")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return hostupdate.Backup{}, err
	}
	hasher := sha256.New()
	archive := zip.NewWriter(io.MultiWriter(file, hasher))
	metadata, _ := json.MarshalIndent(map[string]any{"id": id, "version": version, "createdAt": now, "format": 1}, "", "  ")
	if err := writeZipBytes(archive, "metadata.json", metadata); err != nil {
		return hostupdate.Backup{}, err
	}
	dataDir, err := m.dxosDataDir()
	if err != nil {
		return hostupdate.Backup{}, err
	}
	entry, err := archive.CreateHeader(&zip.FileHeader{Name: "dxos-data.tar", Method: zip.Store})
	if err != nil {
		return hostupdate.Backup{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	if out, err := m.runTo(ctx, "", 30*time.Minute, entry, "tar", "-C", dataDir, "-cf", "-", "."); err != nil {
		return hostupdate.Backup{}, fmt.Errorf("备份数据目录失败：%s", tail(out, 600))
	}
	if err := archive.Close(); err != nil {
		return hostupdate.Backup{}, err
	}
	_ = file.Sync()
	if err := file.Close(); err != nil {
		return hostupdate.Backup{}, err
	}
	stat, err := os.Stat(path)
	if err != nil {
		return hostupdate.Backup{}, err
	}
	return hostupdate.Backup{ID: id, Path: path, Checksum: "sha256:" + hex.EncodeToString(hasher.Sum(nil)), Size: stat.Size(), CreatedAt: now, Version: version}, nil
}

// pruneBackups 保留最近 keep 份备份，删除更早的。
//
// 只删本更新器自己生成的 backup-*.zip；删除失败不阻断更新（磁盘告警已由 preflight 兜底）。
func (m *dxosManager) pruneBackups(keep int) {
	entries, err := filepath.Glob(filepath.Join(m.config.BackupDir, "backup-*.zip"))
	if err != nil || len(entries) <= keep {
		return
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i] > entries[j] })
	for _, path := range entries[keep:] {
		if m.status.LastBackup != nil && m.status.LastBackup.Path == path {
			continue
		}
		_ = os.Remove(path)
	}
}

func (m *dxosManager) restoreBackup(ctx context.Context, backup hostupdate.Backup) error {
	reader, err := zip.OpenReader(backup.Path)
	if err != nil {
		return fmt.Errorf("打开备份失败：%w", err)
	}
	defer reader.Close()
	tarPath := filepath.Join(m.config.StateDir, "restore-"+backup.ID+".tar")
	defer os.Remove(tarPath)
	for _, entry := range reader.File {
		if entry.Name == "dxos-data.tar" {
			if err := extractTo(entry, tarPath); err != nil {
				return err
			}
		}
	}
	if _, err := os.Stat(tarPath); err != nil {
		return errors.New("备份缺少数据目录")
	}
	dataDir, err := m.dxosDataDir()
	if err != nil {
		return err
	}
	data, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer data.Close()
	if out, err := m.runStdin(ctx, "", 30*time.Minute, data, "tar", "-C", dataDir, "-xf", "-"); err != nil {
		return fmt.Errorf("恢复数据目录失败：%s", tail(out, 600))
	}
	return nil
}

// dxosDataDir 是影策在 DXOS 里的数据目录（在安装包之外，升级不会清空）。
func (m *dxosManager) dxosDataDir() (string, error) {
	out, err := m.run(context.Background(), "", 10*time.Second, "python3", "-c", dxosDataDirScript)
	if err != nil {
		return "", fmt.Errorf("定位 DXOS 数据目录失败：%s", strings.TrimSpace(out))
	}
	dir := strings.TrimSpace(out)
	if dir == "" {
		return "", errors.New("DXOS 数据目录为空")
	}
	return dir, nil
}

const dxosDataDirScript = `
import json,glob,os
cands=[os.environ.get('DXOS_DATA_DIR','')]
cands+=sorted(glob.glob(os.path.expanduser('~/DXOS/DXOS-Portable-*/data')),reverse=True)
for base in cands:
    if not base: continue
    try:
        items=json.load(open(os.path.join(base,'mcp.json')))
    except Exception:
        continue
    for item in items:
        if item.get('id')=='yingce-local':
            print(item.get('env',{}).get('YINGCE_DATA_DIR',''))
            raise SystemExit
print('')
`

// ---------------- 工具 ----------------

func (m *dxosManager) checkDisk() error {
	out, err := m.run(context.Background(), "", 20*time.Second, "df", "-Pk", m.config.RepoDir)
	if err != nil {
		return nil
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) < 2 {
		return nil
	}
	fields := strings.Fields(lines[len(lines)-1])
	if len(fields) < 4 {
		return nil
	}
	availableKB, convErr := strconv.ParseInt(fields[3], 10, 64)
	if convErr != nil {
		return nil
	}
	if availableKB < 4<<20 {
		return fmt.Errorf("磁盘可用空间不足 4 GiB：当前 %.1f GiB", float64(availableKB)/(1<<20))
	}
	return nil
}

func (m *dxosManager) git(ctx context.Context, dir string, args ...string) (string, error) {
	return m.run(ctx, dir, 2*time.Minute, "git", args...)
}

func (m *dxosManager) run(ctx context.Context, dir string, timeout time.Duration, name string, args ...string) (string, error) {
	var buffer bytes.Buffer
	stderr, err := m.runTo(ctx, dir, timeout, &buffer, name, args...)
	if err != nil && strings.TrimSpace(buffer.String()) == "" {
		return stderr, err
	}
	return buffer.String(), err
}

func (m *dxosManager) runEnv(ctx context.Context, dir string, timeout time.Duration, extraEnv []string, name string, args ...string) (string, error) {
	var buffer bytes.Buffer
	stderr, err := m.runToEnv(ctx, dir, timeout, &buffer, extraEnv, name, args...)
	if err != nil && strings.TrimSpace(buffer.String()) == "" {
		return stderr, err
	}
	return buffer.String(), err
}

func (m *dxosManager) runToEnv(ctx context.Context, dir string, timeout time.Duration, stdout io.Writer, extraEnv []string, name string, args ...string) (string, error) {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(runCtx, name, args...)
	command.Dir = dir
	command.Env = append(append(os.Environ(), m.baseEnv()...), extraEnv...)
	var stderr bytes.Buffer
	if stdout != nil {
		command.Stdout = stdout
	}
	command.Stderr = &stderr
	err := command.Run()
	return stderr.String(), err
}

func (m *dxosManager) baseEnv() []string {
	paths := []string{"/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"}
	if home, err := os.UserHomeDir(); err == nil {
		paths = append(paths, filepath.Join(home, ".docker", "bin"), filepath.Join(home, ".local", "toolchains", "go", "bin"))
	}
	return []string{
		"PATH=" + strings.Join(paths, ":"),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=/bin/true",
	}
}

func (m *dxosManager) runTo(ctx context.Context, dir string, timeout time.Duration, stdout io.Writer, name string, args ...string) (string, error) {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(runCtx, name, args...)
	command.Dir = dir
	command.Env = append(os.Environ(), m.baseEnv()...)
	var stderr bytes.Buffer
	if stdout != nil {
		command.Stdout = stdout
	}
	command.Stderr = &stderr
	err := command.Run()
	return stderr.String(), err
}

func (m *dxosManager) runStdin(ctx context.Context, dir string, timeout time.Duration, stdin io.Reader, name string, args ...string) (string, error) {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(runCtx, name, args...)
	command.Dir = dir
	command.Env = append(os.Environ(), "PATH="+strings.Join([]string{"/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"}, ":"))
	command.Stdin = stdin
	var stderr bytes.Buffer
	command.Stderr = &stderr
	err := command.Run()
	return stderr.String(), err
}

func writeZipBytes(archive *zip.Writer, name string, data []byte) error {
	entry, err := archive.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate})
	if err != nil {
		return err
	}
	_, err = entry.Write(data)
	return err
}

func extractTo(entry *zip.File, path string) error {
	reader, err := entry.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.Copy(file, reader)
	return err
}

func parseLocalTarget(value string) (commit, version string, err error) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, "v") {
		return "", "", fmt.Errorf("目标版本格式不正确：%s", value)
	}
	value = strings.TrimPrefix(value, "v")
	index := strings.LastIndex(value, "-")
	if index <= 0 {
		return "", "", fmt.Errorf("目标版本缺少提交后缀：%s", value)
	}
	return value[index+1:], value[:index], nil
}

func sameCommit(left, right string) bool {
	left, right = strings.TrimSpace(left), strings.TrimSpace(right)
	if left == "" || right == "" {
		return false
	}
	return strings.HasPrefix(left, right) || strings.HasPrefix(right, left)
}

func short(value string) string {
	if len(value) > 7 {
		return value[:7]
	}
	return value
}

func tail(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[len(value)-limit:]
}
