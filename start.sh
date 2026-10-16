#!/usr/bin/env bash
set -e
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 22.12+（含 npm）：https://nodejs.org/"
  if [[ -t 0 ]]; then read -r -p "按回车关闭…"; fi
  exit 1
fi

# Replace this shell so closing the terminal also stops the service.
exec node scripts/start.mjs "$@"
