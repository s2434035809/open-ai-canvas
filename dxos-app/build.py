#!/usr/bin/env python3
"""Package the current web/dist as a DX OS native-window application."""
import argparse, json, os, posixpath, re, shutil, subprocess, tempfile, time, zipfile
from pathlib import Path

APP = Path(__file__).resolve().parent
REPO = APP.parent
# 适配层（mcp/、assets/、agent.tools.json）与 dxos-app 一起维护，始终取当前仓库；
# 目标提交里的 plugin-packages 则由 --repo-dir 指定，保证插件与后端同源。
SOURCE_ROOT = REPO
DIST = REPO / "web" / "dist"
OUTPUT = REPO / "output" / "dxos-app"
STATE = REPO / ".local" / "dxos-app-last-build.json"
# DX OS 0.5.1 rejects these web assets at install time. They are optional
# demos/models; keeping them would make the whole APP impossible to import.
HOST_UNSUPPORTED_SUFFIXES = {".mp4", ".glb", ".gltf", ".tflite"}
HOST_ALLOWED_SUFFIXES = {".html", ".css", ".js", ".mjs", ".ts", ".tsx", ".json", ".txt", ".md", ".yaml", ".yml", ".toml", ".py", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".wav", ".ogg", ".webm", ".wasm", ".mix", ".map", ".csf", ".fbx"}
# 与宿主 developerApps.ts 的 ALLOWED_MCP_RUNTIME_EXTENSIONS 保持一致：原生运行时与
# 压缩包只允许出现在 mcp/ 下。后端二进制因此改名成 .exe，插件包改名成 .zip。
MCP_RUNTIME_SUFFIXES = {".pyd", ".dll", ".node", ".so", ".dylib", ".exe", ".pem", ".cfg", ".cat", "._pth", ".zip"}
# 宿主安装校验的硬限制，提前在打包阶段拦截，避免用户导入时才失败。
MAX_PACKAGE_BYTES = 200 * 1024 * 1024
MAX_UNPACKED_BYTES = 500 * 1024 * 1024
MAX_ENTRIES = 2048
# 1.6.2 上游新增 355 张灵感缩略图，直接把包顶到宿主 2048 条上限之上。
# 缩略图改成打包时收进 mcp/ 下一个 ZIP（宿主只允许 mcp/ 放 .zip），
# 由连接器的本地媒体代理按 /api/dxos-thumbs/<相对路径> 提供，文件树里不再展开。
THUMBS_DIR_NAME = "inspiration-thumbs"
THUMBS_ZIP_NAME = "inspiration-thumbs.zip"
THUMBS_API_PREFIX = "/api/dxos-thumbs/"
def default_backend_bin():
    # 优先使用 build-backend.py 编译出的当前版本后端；缺失时才回退到仓库里的历史二进制。
    compiled = APP / "backend-bin" / "yingce-backend"
    return compiled if compiled.is_file() else REPO / "backend" / "server"


DEFAULT_BACKEND_BIN = default_backend_bin()
DEFAULT_BACKEND_URL = "http://127.0.0.1:3003"
# 媒体元素（img/video/audio）不经过 fetch 桥，只能直连后端，因此端口必须固定。
# 与 mcp/server.js 的 DEFAULT_BACKEND_PORT、assets/dxos-bootstrap.js 的占位符保持一致。
BACKEND_PORT = 1724
BOOTSTRAP_PORT_TOKEN = "__YINGCE_BACKEND_PORT__"
PAYMENT_PLUGIN_KEYWORDS = ("payment", "alipay", "wechat", "xunhupay", "zhifufm", "epay")

def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()

def next_build():
    previous = 0
    if STATE.exists():
        try: previous = int(json.loads(STATE.read_text(encoding="utf-8"))["build"])
        except (ValueError, KeyError, json.JSONDecodeError): pass
    return max(int(time.time()), previous + 1)

def dxos_semver(raw):
    """DX OS 宿主只接受三段 SemVer（见 shared/appLifecycle.ts 的 SEMVER_RE）。

    上游会出现四段补丁版本（v1.6.6.1、v1.6.8.1），四段会被宿主 developerApps.ts
    直接拒绝导入。归一化为三段 + build metadata（1.6.8.1 -> 1.6.8+1）：
    仍是合法 SemVer，core 版本保持可比，补丁号也不丢。
    """
    value = str(raw).strip().removeprefix("v")
    parts = value.split(".")
    if len(parts) > 3 and all(part.isdigit() for part in parts):
        return ".".join(parts[:3]) + "+" + ".".join(parts[3:])
    return value

def rewrite_public_refs(root):
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".html", ".js", ".css", ".json"}: continue
        try: text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError: continue
        if path.suffix == '.js' and '__vite__mapDeps' in text:
            # Older root-base Vite output builds preload URLs at runtime.
            # Literal /assets replacements alone cannot fix this expression.
            text = re.sub(r'function\(([A-Za-z_$][\w$]*)\)\{return`/`\+\1\}',
                          lambda match: 'function(' + match[1] + '){return new URL("../"+' + match[1] + ',import.meta.url).href}', text)
        # Make root-style references relative to the file that contains them.
        # A chunk under assets/ needs ./chunk.js; index.html needs ./assets/chunk.js.
        relative = lambda target: posixpath.relpath(target, path.relative_to(root).parent.as_posix() or ".")
        # `/assets/` 这类前缀同时是静态资源目录和后端 API 路径（/api/assets/...、
        # /api/<渠道>/images/generations）。无脑改写会把素材库接口和模型代理路径
        # 一起改坏，所以先把 api 段遮蔽掉，只重写真正的静态资源引用。
        api_guard = "\x00dxos-api\x00"
        for prefix in ("assets", "images", "welcome", "live2d"):
            text = text.replace("api/" + prefix + "/", api_guard + prefix + "/")
        for prefix in ("assets", "images", "welcome", "live2d"):
            target = relative(prefix) + "/"
            # Template literals starting with /${prefix}/ in JS chunks are
            # backend API endpoints (axios baseURL=/api), not static assets.
            # Rewriting them breaks requests (e.g. /assets/folder -> ./folder).
            replacements = [
                (f'"/{prefix}/', f'"{target}'),
                (f"'/{prefix}/", f"'{target}"),
                (f'url(/{prefix}/', f'url({target}'),
            ]
            for old, new in replacements:
                text = text.replace(old, new)
        for prefix in ("assets", "images", "welcome", "live2d"):
            text = text.replace(api_guard + prefix + "/", "api/" + prefix + "/")
        path.write_text(text, encoding="utf-8")

def copy_dist_without_host_unsupported_assets(destination):
    def ignore(_directory, names):
        return {name for name in names if Path(name).suffix.lower() in HOST_UNSUPPORTED_SUFFIXES}
    shutil.copytree(DIST, destination, dirs_exist_ok=True, ignore=ignore)

# Agent 运行时（backend/agent-runtime/pi）含 node_modules，文件数和后缀都
# 超出宿主对 APP 包的限制，所以精简后打成一个 zip 交给 mcp/（宿主允许 .zip）。
RUNTIME_EXCLUDE_SUFFIXES = {".ts", ".mts", ".cts", ".map", ".md", ".tsbuildinfo", ".npmignore"}
RUNTIME_EXCLUDE_DIRS = {"__tests__", "test", "tests", ".github", ".idea", ".vscode"}
def stage_agent_runtime(root):
    source = REPO / "backend" / "agent-runtime" / "pi"
    if not (source / "agent-runtime.mjs").is_file():
        return 0
    target = root / "mcp" / "agent-runtime.zip"
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        for name in ("agent-runtime.mjs", "package.json", "package-lock.json"):
            path = source / name
            if path.is_file(): archive.write(path, name)
        modules = source / "node_modules"
        if modules.is_dir():
            for path in sorted(modules.rglob("*")):
                relative = path.relative_to(modules)
                if set(relative.parts) & RUNTIME_EXCLUDE_DIRS: continue
                if path.suffix.lower() in RUNTIME_EXCLUDE_SUFFIXES: continue
                if not path.is_file() and not path.is_symlink(): continue
                if path.is_symlink() and not path.exists(): continue
                archive.write(path, (Path("node_modules") / relative).as_posix())
    return target.stat().st_size

def stage_inspiration_thumbs(root):
    """把灵感画廊缩略图收进 mcp/inspiration-thumbs.zip，并从文件树里移走。

    宿主按 ZIP 中央目录条目数硬校验 2048 条；1.6.2 的 355 张 webp 会顶爆这个上限。
    webp 本身已是压缩格式，这里用 STORED 存，连接器可以直接按偏移切片返回，不必解压。
    """
    source = root / THUMBS_DIR_NAME
    if not source.is_dir():
        return 0
    target = root / "mcp" / THUMBS_ZIP_NAME
    target.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(source).as_posix())
                count += 1
    shutil.rmtree(source)
    return count

def rewrite_inspiration_thumbs_refs(root):
    """把引用改成 /api/dxos-thumbs/...，让适配层把媒体地址直连到连接器代理。

    走 /api/ 前缀是必须的：dxos-bootstrap.js 只对 /api/ 媒体地址做直连改写，
    其余根绝对路径会被当成应用自身静态资源、落到包内文件树里（那里已经没有这些文件了）。
    """
    replaced = 0
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".json", ".js", ".css", ".html"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if "/" + THUMBS_DIR_NAME + "/" not in text:
            continue
        updated = text.replace("/" + THUMBS_DIR_NAME + "/", THUMBS_API_PREFIX)
        path.write_text(updated, encoding="utf-8")
        replaced += 1
    return replaced

def mcp_manifest(mode, backend_url):
    # 两种模式都写显式 YINGCE_BACKEND_MODE：DX OS 升级时会沿用上一版 env 里用户没改过的键，
    # 只靠「有没有 YINGCE_BACKEND_URL」判断会让历史 external 地址劫持新的 bundled 包。
    environment = ({"YINGCE_BACKEND_MODE": "bundled", "YINGCE_BACKEND_PORT": str(BACKEND_PORT)} if mode == "bundled"
                   else {"YINGCE_BACKEND_MODE": "external", "YINGCE_BACKEND_URL": backend_url})
    return {
        "format": "dx-mcp/v1",
        "mcpServers": {
            "yingce-local": {
                "name": "影策本地后端连接器",
                "command": "node",
                "args": ["server.js"],
                "cwd": "mcp",
                "autoStart": True,
                "env": environment,
            }
        },
    }

def stage_bundled_backend(root, binary, with_payment_plugins):
    if not binary.is_file():
        raise SystemExit(f"找不到后端二进制：{binary}\n先运行 python3 dxos-app/build-backend.py 或传入 --backend-bin")
    staged_binary = root / "mcp" / "yingce-backend.exe"
    shutil.copy2(binary, staged_binary)
    staged_binary.chmod(0o755)
    plugin_source = SOURCE_ROOT / "plugin-packages"
    plugin_target = root / "mcp" / "plugins"
    plugin_target.mkdir(parents=True, exist_ok=True)
    staged_plugins = 0
    for path in sorted(plugin_source.glob("*.yingce-plugin")):
        name = path.name.lower()
        if not with_payment_plugins and any(keyword in name for keyword in PAYMENT_PLUGIN_KEYWORDS):
            continue
        shutil.copy2(path, plugin_target / (path.name[: -len(".yingce-plugin")] + ".zip"))
        staged_plugins += 1
    # 缺官方插件目录时后端会在启动阶段直接失败，这里必须至少带上一批。
    if not staged_plugins:
        raise SystemExit(f"没有在 {plugin_source} 找到任何官方插件包，后端将无法启动")
    return staged_plugins, staged_binary.stat().st_size

def staged_bootstrap():
    """注入后端端口，让媒体元素能直连包内后端而不是落到宿主源。"""
    source = (APP / "assets" / "dxos-bootstrap.js").read_text(encoding="utf-8")
    if BOOTSTRAP_PORT_TOKEN not in source:
        raise SystemExit(f"assets/dxos-bootstrap.js 缺少 {BOOTSTRAP_PORT_TOKEN} 端口占位符")
    return source.replace(BOOTSTRAP_PORT_TOKEN, str(BACKEND_PORT))

def manifest(version, build, channel, mode):
    description = ("直接在 DX OS 内运行的影策工作台，后端随包内置，无需另行安装 Docker 或启动本地服务。"
                   if mode == "bundled" else "直接在 DX OS 内运行的影策前端工作台。")
    return {
        "format": "dx-app/v2", "id": "yingce-main", "version": version,
        "build": build, "releaseChannel": channel, "minSystemVersion": "0.3.9", "dataVersion": 1,
        "name": "影策", "subtitle": "AI 影视与短剧创作工作台",
        "description": description, "category": "software",
        "entry": "index.html", "defaultSize": {"width": 1440, "height": 900},
        "backgroundMode": "keep-alive",
        "icon": {"gradient": "linear-gradient(145deg, #1c1c1e, #000000)", "svg": "<svg viewBox='0 0 64 64'><path d='M19.57 8.03 A27.00 27.00 0 0 1 44.43 8.03 L37.25 22.91 L26.75 22.91 ZM46.55 9.25 A27.00 27.00 0 0 1 58.97 30.78 L42.50 32.00 L37.25 22.91 ZM58.97 33.22 A27.00 27.00 0 0 1 46.55 54.75 L37.25 41.09 L42.50 32.00 ZM44.43 55.97 A27.00 27.00 0 0 1 19.57 55.97 L26.75 41.09 L37.25 41.09 ZM17.45 54.75 A27.00 27.00 0 0 1 5.03 33.22 L21.50 32.00 L26.75 41.09 ZM5.03 30.78 A27.00 27.00 0 0 1 17.45 9.25 L26.75 22.91 L21.50 32.00 Z' fill='#fff'/></svg>"},
        # file.write 是下载按钮的前提：宿主 file.export 会先校验 app.<id>.file.write
        # （DeveloperAppHost 的 nt("write")）。缺它时沙箱内 blob 下载也被拦，用户看到"点了没反应"。
        # ui.notify 用于把下载失败原因告诉用户，否则失败只剩诊断日志。
        "permissions": ["app.yingce-main.open", "app.yingce-main.yingce.request", "app.yingce-main.project.read", "app.yingce-main.project.write", "app.yingce-main.project.delete", "app.yingce-main.file.write", "app.yingce-main.ui.notify"],
        "dependencies": [{"type": "mcp", "id": "yingce-local", "name": "影策本地后端连接器", "required": True, "source": "bundled", "path": "mcp/mcp.json", "installHint": "MCP 已封装在影策 APP 内，无需另行安装。"}],
        "agent": {"summary": "为影策前端提供本机后端请求能力。", "toolManifest": "agent.tools.json"}
    }

def validate(root, info):
    if info["format"] != "dx-app/v2" or not (root / info["entry"]).is_file(): raise ValueError("DX OS manifest or entry is missing")
    if not re.fullmatch(r"[a-z][a-z0-9-]{2,42}", info["id"]): raise ValueError("Invalid DX OS app id")
    # 与宿主 shared/appLifecycle.ts 的 SEMVER_RE 保持一致，接受三段 + 可选 prerelease/build。
    semver = r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
    if not re.fullmatch(semver, info["version"]): raise ValueError("Invalid SemVer")
    if not isinstance(info["build"], int) or info["build"] < 1: raise ValueError("Invalid build")
    files = [path for path in root.rglob("*") if path.is_file()]
    invalid = [str(path.relative_to(root)) for path in files if path.suffix.lower() not in HOST_ALLOWED_SUFFIXES and not (str(path.relative_to(root)).startswith("mcp/") and path.suffix.lower() in MCP_RUNTIME_SUFFIXES)]
    if invalid: raise ValueError(f"DX OS 不允许的文件类型：{', '.join(invalid[:8])}")
    # 宿主按中央目录条目数和解压总量做硬校验，超限的包导入时会被直接拒绝。
    if len(files) > MAX_ENTRIES: raise ValueError(f"包内文件数 {len(files)} 超过 DX OS 上限 {MAX_ENTRIES}")
    unpacked = sum(path.stat().st_size for path in files)
    if unpacked > MAX_UNPACKED_BYTES: raise ValueError(f"解压后 {unpacked / 1048576:.1f} MB 超过 DX OS 上限 {MAX_UNPACKED_BYTES / 1048576:.0f} MB")
    html = (root / info["entry"]).read_text(encoding="utf-8")
    for resource in re.findall(r"(?:src|href)=[\"']([^\"']+)[\"']", html):
        if resource.startswith("data:"): continue
        if resource.startswith(("http:", "https:", "file:", "/", "../")) or not (root / resource).is_file(): raise ValueError(f"Invalid or missing entry resource: {resource}")

def main():
    global DIST, SOURCE_ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel", choices=("dev", "beta", "stable"), default="dev")
    parser.add_argument("--dist", type=Path, default=DIST)
    parser.add_argument("--backend", choices=("bundled", "external"), default="bundled",
                        help="bundled：把后端打进包并由包内连接器拉起；external：只打包前端，连外部后端")
    parser.add_argument("--backend-bin", type=Path, default=DEFAULT_BACKEND_BIN, help="bundled 模式使用的后端二进制")
    parser.add_argument("--backend-url", default=DEFAULT_BACKEND_URL, help="external 模式连接的后端地址")
    parser.add_argument("--with-payment-plugins", action="store_true", help="同时打入支付插件包（约 85 MB）")
    parser.add_argument("--repo-dir", type=Path, default=None,
                        help="目标提交导出的仓库根，用于取同源的 plugin-packages；默认当前仓库")
    args = parser.parse_args()
    DIST = args.dist.resolve()
    global SOURCE_ROOT
    if args.repo_dir:
        SOURCE_ROOT = args.repo_dir.resolve()
        if not (SOURCE_ROOT / "plugin-packages").is_dir():
            raise SystemExit(f"--repo-dir 下缺少 plugin-packages：{SOURCE_ROOT}")

    if not (DIST / "index.html").is_file(): raise SystemExit("web/dist 不存在，请先运行 cd web && bun run build")
    provenance = DIST / "dxos-build-source.json"
    if not provenance.is_file():
        raise SystemExit("缺少 DX OS 构建来源记录。请运行 python3 dxos-app/rebuild.py，避免打包过期或未经适配的 dist。")
    source = json.loads(provenance.read_text())
    version = dxos_semver(source["version"])
    build, commit = next_build(), source["commit"]
    with tempfile.TemporaryDirectory(prefix="yingce-dxos-") as temp:
        root = Path(temp); copy_dist_without_host_unsupported_assets(root); rewrite_public_refs(root)
        html = (root / "index.html").read_text(encoding="utf-8")
        html = html.replace("<head>", '<head>\n    <script src="./dxos-bootstrap.js"></script>', 1)
        (root / "index.html").write_text(html, encoding="utf-8")
        (root / "dxos-bootstrap.js").write_text(staged_bootstrap(), encoding="utf-8")
        shutil.copytree(APP / "mcp", root / "mcp")
        staged_thumbs = stage_inspiration_thumbs(root)
        rewrite_inspiration_thumbs_refs(root)
        shutil.copy2(APP / "agent.tools.json", root / "agent.tools.json")
        (root / "mcp" / "mcp.json").write_text(json.dumps(mcp_manifest(args.backend, args.backend_url), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        staged_plugins = staged_backend_bytes = staged_runtime = 0
        if args.backend == "bundled":
            staged_plugins, staged_backend_bytes = stage_bundled_backend(root, args.backend_bin.resolve(), args.with_payment_plugins)
            staged_runtime = stage_agent_runtime(root)
        info = manifest(version, build, args.channel, args.backend)
        (root / "dx-app.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        validate(root, info)
        OUTPUT.mkdir(parents=True, exist_ok=True); target = OUTPUT / f"yingce-main-v{version}-b{build}.zip"; temp_zip = target.with_suffix(".zip.tmp")
        try:
            with zipfile.ZipFile(temp_zip, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                for path in root.rglob("*"):
                    if path.is_file(): archive.write(path, path.relative_to(root).as_posix())
            if temp_zip.stat().st_size > MAX_PACKAGE_BYTES:
                raise ValueError(f"压缩包 {temp_zip.stat().st_size / 1048576:.1f} MB 超过 DX OS 上限 {MAX_PACKAGE_BYTES / 1048576:.0f} MB")
            with zipfile.ZipFile(temp_zip) as archive:
                if archive.testzip() is not None or "dx-app.json" not in archive.namelist() or "index.html" not in archive.namelist(): raise ValueError("ZIP verification failed")
            os.replace(temp_zip, target)
        finally: temp_zip.unlink(missing_ok=True)
    STATE.parent.mkdir(parents=True, exist_ok=True); STATE.write_text(json.dumps({"build": build}) + "\n", encoding="utf-8")
    print(target); print("source commit:", commit); print("backend mode:", args.backend)
    if args.backend == "bundled":
        print(f"bundled backend: {staged_backend_bytes / 1048576:.1f} MB, plugins: {staged_plugins}")
        print(f"agent runtime: {staged_runtime / 1048576:.1f} MB")
    if staged_thumbs:
        print(f"inspiration thumbs packed into mcp/{THUMBS_ZIP_NAME}: {staged_thumbs}")

if __name__ == "__main__": main()
