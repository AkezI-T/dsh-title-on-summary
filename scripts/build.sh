#!/bin/bash
# dsh-title-on-summary copy build: pure-JS host half (no tsc), src/*.js -> lib/.
# The loader entry reads package.json "main" (lib/index.js).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p lib
# 只清掉上一轮的构建产物（lib/*.js）；lib/ 里的其它文件不动。
rm -f lib/*.js
# 骨架阶段 src/ 里可能一个 .js 都还没有（宿主入口由他人提交），此时构建应成功而不是报错。
if compgen -G "src/*.js" > /dev/null; then
  cp src/*.js lib/
fi
echo "=== build complete ==="
ls lib/
