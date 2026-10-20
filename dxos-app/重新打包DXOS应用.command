#!/bin/zsh
set -eu
cd "$(dirname "$0")/.."
BACKEND_BIN=dxos-app/backend-bin/yingce-backend
if [[ ! -f "$BACKEND_BIN" ]]; then
  echo "未找到 $BACKEND_BIN，先运行：python3 dxos-app/build-backend.py"
  exit 1
fi
python3 dxos-app/rebuild.py --ref HEAD --backend-bin "$BACKEND_BIN"
echo ""
echo "DX OS 原生窗口 App ZIP 已生成于 output/dxos-app/。按回车关闭窗口。"
read -r
