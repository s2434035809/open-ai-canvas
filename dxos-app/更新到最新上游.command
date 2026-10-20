#!/bin/zsh
# 一键更新：拉取作者上游 -> 合并 -> 编译后端 -> 构建前端 -> 打出 DX OS 安装包
set -eu
cd "$(dirname "$0")/.."

step() { printf "\n\033[1m== %s ==\033[0m\n" "$1" }

step "1/4 拉取上游（ddcat-ai/open-ai-canvas）"
git fetch upstream --prune

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BEHIND="$(git rev-list --count "HEAD..upstream/main")"
AHEAD="$(git rev-list --count "upstream/main..HEAD")"
echo "当前分支：$BRANCH"
echo "上游 main 领先本地 $BEHIND 个提交，本地领先上游 $AHEAD 个提交"

if [[ "$BEHIND" == "0" ]]; then
  echo "上游没有新提交，仍然用当前检出重新打包。"
else
  step "2/4 合并 upstream/main 到 $BRANCH"
  if ! git merge --no-edit upstream/main; then
    echo ""
    echo "合并出现冲突，已停在冲突状态。"
    echo "请手动解决冲突（git status 查看），然后重新运行本脚本。"
    exit 1
  fi
fi

step "3/4 编译 macOS arm64 后端"
python3 dxos-app/build-backend.py

step "4/4 构建前端并打包 DX OS 应用"
# 与 .local/dxos-build.sh 一致：先清陈旧注册，避免下次按应用名唤起命中旧运行时。
"$PWD/.local/dxos-unregister-stale.sh" >/dev/null 2>&1 || echo "警告：清理 DX OS 陈旧注册未通过，结束后请手动复查" >&2
python3 dxos-app/rebuild.py --ref HEAD --backend-bin dxos-app/backend-bin/yingce-backend

ZIP="$(ls -t output/dxos-app/yingce-main-v*.zip 2>/dev/null | head -1)"
printf "\n\033[1m完成\033[0m\n新安装包：%s\n" "${ZIP:-未找到}"
cat <<'TIP'

接下来在 DX OS 里：
  1. 导入上面这个 ZIP（覆盖升级，数据目录在包外，不会被清空）
  2. Cmd+Q 完全退出 DX OS 再重开（清单是 keep-alive，不彻底退出会继续跑旧代码）
  3. 打开影策，用原账号登录
TIP
echo ""
echo "按回车关闭窗口。"
read -r
