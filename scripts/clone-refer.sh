#!/usr/bin/env bash
# 将参考仓库浅克隆到 refer/（与 docs/调研思源AI插件.md、docs/Agent底座.md 一致）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p refer

clone_if_missing() {
  local dir="$1"
  local url="$2"
  if [[ -d "refer/$dir/.git" ]]; then
    echo "skip refer/$dir (already cloned)"
    return
  fi
  rm -rf "refer/$dir"
  git clone --depth 1 "$url" "refer/$dir"
}

clone_if_missing siyuan-plugin-copilot https://github.com/Achuan-2/siyuan-plugin-copilot.git
clone_if_missing siyuan-plugins-mcp-sisyphus https://github.com/yangtaihong59/siyuan-plugins-mcp-sisyphus.git
clone_if_missing siyuan-agent https://github.com/RiviaAzusa/siyuan-agent.git
clone_if_missing siyuan-plugins-ai-cli-bridge https://github.com/yangtaihong59/siyuan-plugins-ai-cli-bridge.git
clone_if_missing siyuan-ai-assistant https://github.com/DUZSSY/siyuan-ai-assistant.git
clone_if_missing sy-f-misc https://github.com/frostime/sy-f-misc.git
clone_if_missing pi https://github.com/earendil-works/pi.git

echo "done: refer/ ready for offline reading"
