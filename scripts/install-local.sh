#!/usr/bin/env bash
# 把本插件以 link: 依赖装进 desktop profile，并加入 bundle 栈。
# 不重启任何进程：安装完成后由你重启 DeepSeek Harness 生效。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
PKG="$PROFILE/package.json"

if [ ! -f "$PKG" ]; then
  echo "找不到 $PKG" >&2
  exit 1
fi

BACKUP="$PKG.bak-before-protocol-matrix-$(date +%Y%m%d-%H%M%S)"
cp "$PKG" "$BACKUP"
echo "已备份: $BACKUP"

node - "$PKG" "$ROOT" <<'NODE'
const fs = require('fs');
const [pkgPath, root] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.dependencies = { ...(pkg.dependencies ?? {}), 'dsh-model-protocol-matrix': 'link:' + root };
const bundles = [...(pkg.dsh?.profile?.bundles ?? [])];
if (!bundles.includes('dsh-model-protocol-matrix')) bundles.push('dsh-model-protocol-matrix');
pkg.dsh = {
  ...(pkg.dsh ?? {}),
  profile: { ...(pkg.dsh?.profile ?? {}), bundles },
};
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('package.json 已更新（dependency + bundles）');
NODE

cd "$PROFILE"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install
else
  echo '未找到 pnpm：请在 profile 目录手动安装依赖后重启。' >&2
  exit 2
fi

echo
echo '安装完成。重启 DeepSeek Harness 后打开:'
echo '  http://127.0.0.1:<DSH 端口>/protocol-matrix/ui'
echo '卸载: 从 package.json 移除依赖与 bundles 条目，再 pnpm install 并重启。'
