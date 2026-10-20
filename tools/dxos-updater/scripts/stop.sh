#!/bin/bash
# 停掉 DXOS 更新器（不影响 DXOS 与影策本身）。
set -uo pipefail
SOCKET="$HOME/.yingce/dxos-updater.sock"
PIDS="$(pgrep -f 'dxos-updater$' 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  kill $PIDS && echo "已停止 DXOS 更新器 pid $PIDS"
else
  echo "DXOS 更新器未在运行"
fi
rm -f "$SOCKET"
