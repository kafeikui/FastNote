#!/usr/bin/env bash
# 从 macOS 系统代理写入项目 .npmrc（供 pnpm / npm 使用）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NPMRC="$ROOT/.npmrc"

read_proxy() {
  scutil --proxy 2>/dev/null | awk -v key="$1" '$1 == key":" { print $3; exit }'
}

HTTP_ENABLE=$(read_proxy HTTPEnable)
HTTPS_ENABLE=$(read_proxy HTTPSEnable)
HTTP_HOST=$(read_proxy HTTPProxy)
HTTP_PORT=$(read_proxy HTTPPort)
HTTPS_HOST=$(read_proxy HTTPSProxy)
HTTPS_PORT=$(read_proxy HTTPSPort)

if [[ "$HTTP_ENABLE" != "1" && "$HTTPS_ENABLE" != "1" ]]; then
  echo "系统未启用 HTTP/HTTPS 代理，跳过写入 .npmrc"
  exit 0
fi

HOST="${HTTPS_HOST:-$HTTP_HOST}"
PORT="${HTTPS_PORT:-$HTTP_PORT}"

if [[ -z "$HOST" || -z "$PORT" ]]; then
  echo "无法读取系统代理地址" >&2
  exit 1
fi

PROXY="http://${HOST}:${PORT}"

cat > "$NPMRC" <<EOF
# 由 scripts/sync-proxy.sh 自动生成（$(date '+%Y-%m-%d %H:%M')）
# 重新检测：pnpm proxy:sync
proxy=${PROXY}
https-proxy=${PROXY}
EOF

echo "已写入 ${NPMRC}"
echo "  proxy=${PROXY}"
echo "  https-proxy=${PROXY}"
