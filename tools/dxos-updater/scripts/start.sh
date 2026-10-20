#!/bin/bash
# 启动 DXOS 版影策的「后台在线更新」能力。
#
# 影策在 DXOS 里是「ZIP 应用包 + 包内后端」，更新必须重新打包并导入。
# 本脚本只起一个常驻更新器进程：
#   1) 生成/复用 token（~/.yingce/dxos-updater-token，0600）
#   2) 监听 ~/.yingce/dxos-updater.sock（0600，仅当前用户）
#   3) 脱离当前终端（python 双 fork + setsid），关掉窗口也不退出
#
# 包内后端通过 CANVAS_UPDATER_SOCKET / CANVAS_UPDATER_TOKEN 找到它，
# 由连接器在启动后端时从 ~/.yingce 读取注入，不改安装包内容。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BIN_DIR="$REPO/.local/bin"
BIN="$BIN_DIR/dxos-updater"
LOG_DIR="$REPO/.local/logs"
LOG="$LOG_DIR/dxos-updater.log"
RUNTIME="$HOME/.yingce"
SOCKET="$RUNTIME/dxos-updater.sock"
TOKEN_FILE="$RUNTIME/dxos-updater-token"

mkdir -p "$BIN_DIR" "$LOG_DIR" "$RUNTIME"
chmod 700 "$RUNTIME"

# 源码有改动时自动重编译
if [ ! -x "$BIN" ] || [ -n "$(find "$HERE" -name '*.go' -newer "$BIN" -print -quit 2>/dev/null)" ]; then
  GO_BIN="$(command -v go || true)"
  [ -z "$GO_BIN" ] && [ -x "$HOME/.local/toolchains/go/bin/go" ] && GO_BIN="$HOME/.local/toolchains/go/bin/go"
  if [ -z "$GO_BIN" ]; then
    echo "找不到 Go 工具链，无法编译 DXOS 更新器" >&2
    exit 1
  fi
  echo "编译 DXOS 更新器…"
  ( cd "$HERE" && "$GO_BIN" build -o "$BIN" . )
fi

if [ -s "$TOKEN_FILE" ] && [ "$(wc -c < "$TOKEN_FILE" | tr -d ' ')" -ge 32 ]; then
  TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
else
  TOKEN="$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
  umask 077
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "已生成更新器 token：${TOKEN_FILE}"
fi

probe() {
  curl --noproxy '*' -sS --max-time 3 -H "Authorization: Bearer $TOKEN" \
    --unix-socket "$SOCKET" http://localhost/v1/status >/dev/null 2>&1
}

if [ -S "$SOCKET" ] && probe; then
  echo "DXOS 更新器已在运行（unix://${SOCKET}）"
else
  [ -S "$SOCKET" ] && rm -f "$SOCKET"
  # 更新器从环境读 token 与仓库位置；fork 出去的进程继承这里的导出值。
  export UPDATER_TOKEN="$TOKEN"
  export UPDATER_REPO_DIR="$REPO"
  export UPDATER_SOCKET="$SOCKET"
  python3 - "$BIN" "$LOG" <<'PY'
import os, sys
bin_path, log_path = sys.argv[1], sys.argv[2]
if os.fork() > 0:
    os._exit(0)
os.setsid()
if os.fork() > 0:
    os._exit(0)
fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
os.execv(bin_path, [bin_path])
PY
  for _ in $(seq 1 30); do
    probe && break
    sleep 0.5
  done
  if ! probe; then
    echo "更新器启动失败，检查 ${LOG}" >&2
    exit 1
  fi
  echo "DXOS 更新器已启动（unix://${SOCKET}）"
fi

# 打印当前状态，便于确认连上了 DXOS
curl --noproxy '*' -sS --max-time 20 -H "Authorization: Bearer $TOKEN" \
  --unix-socket "$SOCKET" http://localhost/v1/status | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("当前已安装:", d.get("currentVersion") or "（未读到）")
print("可连接 DXOS:", "是" if d.get("connected") else "否")
print("最近阶段:", (d.get("operation") or {}).get("phase"))
'
