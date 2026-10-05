#!/usr/bin/env bash
# 本地数据初始化的一次性验证：
# 1) 用 tsc 把 src/data、src/api 的 TS 源码擦类型转到临时目录（保留 ESM 与 @/ 别名）；
# 2) 带 scripts/ts-alias-loader.mjs 在 Node 里跑 verify-bootstrap.mjs。
# 不依赖 vite/esbuild（当前环境的 esbuild 是其它平台二进制）。
set -euo pipefail

cd "$(dirname "$0")/.."

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/env.d.ts" <<'EOF'
interface ImportMetaEnv {
  readonly DEV?: boolean
  readonly MODE?: string
  [key: string]: unknown
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
EOF

cat > "$TMP_DIR/tsconfig.verify.json" <<EOF
{
  "extends": "$(pwd)/tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": false,
    "sourceMap": false,
    "outDir": "$TMP_DIR/out",
    "baseUrl": "$(pwd)",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["$TMP_DIR/env.d.ts", "$(pwd)/src/data/**/*.ts", "$(pwd)/src/api/**/*.ts"]
}
EOF

./node_modules/.bin/tsc -p "$TMP_DIR/tsconfig.verify.json"

TS_TEST_SRC="$TMP_DIR/out" \
  node --loader "$(pwd)/scripts/ts-alias-loader.mjs" \
  "$(pwd)/scripts/verify-bootstrap.mjs"
