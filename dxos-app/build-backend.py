#!/usr/bin/env python3
"""从当前源码编译 macOS arm64 后端二进制，供 dxos-app/build.py --backend bundled 使用。

依赖：本机 Go 1.25+ 与 Xcode 命令行工具（sqlite3 驱动走 cgo，必须有 clang）。
仓库里已有完整的 Go 模块缓存（.local/cache/go-mod），模块齐全时无需联网。
"""
import argparse, datetime, os, shutil, subprocess, sys
from pathlib import Path

APP = Path(__file__).resolve().parent
REPO = Path(os.environ.get("YINGCE_SOURCE_ROOT") or APP.parent)
DEFAULT_OUTPUT = APP / "backend-bin" / "yingce-backend"
MODCACHE = REPO / ".local" / "cache" / "go-mod"
BUILDCACHE = REPO / ".local" / "cache" / "go-build"

def find_go():
    candidates = [
        shutil.which("go"),
        str(Path.home() / ".local" / "toolchains" / "go" / "bin" / "go"),
        "/usr/local/go/bin/go",
        "/opt/homebrew/bin/go",
        str(Path.home() / "go" / "bin" / "go"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--go", default=None, help="go 可执行文件路径，默认自动探测")
    parser.add_argument("--offline", action="store_true", help="强制 GOPROXY=off，只用本地模块缓存")
    parser.add_argument("--with-migrate", action="store_true", help="同时编译 migrate-schema 备用二进制")
    parser.add_argument("--commit", default=None,
                        help="写入二进制的提交号；默认取源码根目录的 git HEAD（git archive 导出时需显式指定）")
    args = parser.parse_args()

    go = args.go or find_go()
    if not go:
        raise SystemExit(
            "未找到 Go 工具链。任选一种：\n"
            "  1) 解压官方包到 ~/.local/toolchains/go（脚本会自动探测）\n"
            "     curl -LO https://dl.google.com/go/go1.25.6.darwin-arm64.tar.gz\n"
            "     mkdir -p ~/.local/toolchains && tar -xzf go1.25.6.darwin-arm64.tar.gz -C ~/.local/toolchains\n"
            "  2) brew install go\n"
            "  3) 用 --go 显式指定 go 可执行文件路径"
        )
    if sys.platform != "darwin":
        raise SystemExit("后端二进制必须在 macOS 上编译（sqlite3 驱动需要 cgo 与 Darwin 工具链）")
    if subprocess.run(["xcode-select", "-p"], capture_output=True).returncode != 0:
        raise SystemExit("未找到 Xcode 命令行工具，请运行： xcode-select --install")

    version = (REPO / "VERSION").read_text(encoding="utf-8").strip()
    commit = (args.commit or "").strip()
    if not commit:
        try:
            commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
        except subprocess.CalledProcessError:
            raise SystemExit("源码目录不是 git 仓库，请用 --commit 指定构建来源提交")
    build_time = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ldflags = " ".join([
        "-s", "-w",
        f"-X yingce/backend/internal/buildinfo.Version={version}",
        f"-X yingce/backend/internal/buildinfo.Commit={commit}",
        f"-X yingce/backend/internal/buildinfo.BuildTime={build_time}",
    ])
    env = dict(os.environ)
    env["CGO_ENABLED"] = "1"
    env["GOOS"] = "darwin"
    env["GOARCH"] = "arm64"
    # 仓库自带模块缓存，优先用它；模块缺失时再回落到网络或用户自己的缓存。
    if MODCACHE.is_dir() and any(MODCACHE.iterdir()):
        env["GOMODCACHE"] = str(MODCACHE)
        print(f"使用仓库模块缓存：{MODCACHE}")
    if BUILDCACHE.is_dir():
        env["GOCACHE"] = str(BUILDCACHE)
    if args.offline:
        env["GOPROXY"] = "off"

    args.output.parent.mkdir(parents=True, exist_ok=True)
    targets = [("infinite-canvas-backend", "./cmd/server", args.output)]
    if args.with_migrate:
        targets.append(("migrate-schema", "./cmd/migrate-schema", args.output.parent / "migrate-schema"))
    for name, package, output in targets:
        command = [go, "build", "-trimpath", "-ldflags", ldflags, "-o", str(output), package]
        print(f"编译 {name} -> {output}")
        subprocess.run(command, cwd=REPO / "backend", env=env, check=True)
        output.chmod(0o755)
        print(f"  {name}: {output.stat().st_size / 1048576:.1f} MB")
    print(f"\n版本 {version}，提交 {commit}")
    print(f"下一步：python3 dxos-app/build.py --backend bundled --backend-bin {targets[0][2]}")

if __name__ == "__main__": main()
