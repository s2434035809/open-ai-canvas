// Command dxos-updater 是 DXOS 版影策的宿主更新器。
//
// DXOS 里的影策是「ZIP 应用包 + 包内原生后端」，更新必须重新导入安装包。
// 本进程跑在 macOS 宿主机上，监听 unix socket，向包内 backend 暴露与官方
// Host Updater 相同的 HTTP 协议；backend 通过 CANVAS_UPDATER_SOCKET 直接连接。
package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"yingce/local-host-updater/hostupdate"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	token := strings.TrimSpace(os.Getenv("UPDATER_TOKEN"))
	manager, err := newDXOSManager()
	if err != nil {
		return err
	}
	server, err := hostupdate.NewServer(manager, token)
	if err != nil {
		return err
	}

	// 默认 unix socket（仅本机、仅当前用户）；设 UPDATER_LISTEN_ADDR 时改走 TCP。
	network, address, socketPath := "unix", "", env("UPDATER_SOCKET", defaultSocketPath())
	if addr := strings.TrimSpace(os.Getenv("UPDATER_LISTEN_ADDR")); addr != "" {
		network, address = "tcp", addr
	}
	if socketPath != "" && network == "unix" {
		if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
			return err
		}
		removeStaleSocket(socketPath)
	}
	listener, err := net.Listen(network, addressFor(network, address, socketPath))
	if err != nil {
		return err
	}
	defer listener.Close()
	if network == "unix" {
		defer os.Remove(socketPath)
		// 只有当前用户能连；backend 以同一用户身份运行。
		if err := os.Chmod(socketPath, 0o600); err != nil {
			return err
		}
	}
	httpServer := &http.Server{Handler: server.Handler(), ReadHeaderTimeout: 5 * time.Second}
	serveErr := make(chan error, 1)
	go func() { serveErr <- httpServer.Serve(listener) }()
	if network == "unix" {
		log.Printf("dxos host updater listening on unix://%s", socketPath)
	} else {
		log.Printf("dxos host updater listening on tcp://%s", address)
	}
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return httpServer.Shutdown(shutdownCtx)
	case err := <-serveErr:
		return err
	}
}

func addressFor(network, address, socketPath string) string {
	if network == "unix" {
		return socketPath
	}
	return address
}

func removeStaleSocket(path string) {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		return
	}
	_ = os.Remove(path)
}

func defaultSocketPath() string {
	if dir := strings.TrimSpace(os.Getenv("UPDATER_RUNTIME_DIR")); dir != "" {
		return filepath.Join(dir, "dxos-updater.sock")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "yingce-dxos-updater.sock")
	}
	return filepath.Join(home, ".yingce", "dxos-updater.sock")
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
