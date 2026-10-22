#!/usr/bin/env bash
# Install the exact source revision used by the macOS Auto .9 hotfix on Linux.
# Run as the Linux account that owns the existing Botmux installation.
set -euo pipefail

if [ "$(uname -s)" != 'Linux' ]; then
  printf '请在运行小希儿的 Linux 机器上执行此脚本。\n' >&2
  exit 1
fi
for bmx_required_command in node git curl; do
  if ! command -v "$bmx_required_command" >/dev/null 2>&1; then
    printf '缺少命令：%s。请先安装后重试。\n' "$bmx_required_command" >&2
    exit 1
  fi
done
node -e 'if(Number(process.versions.node.split(".")[0])<22)throw Error("需要 Node.js 22 或更高版本")'

bmx_test_version='3.48.0-hotfix.skill-snapshot.auto-model.9'
bmx_test_commit='cf9cadb0101b15340ea6c58eed93004ddf705a9a'
mkdir -p "$HOME/.botmux/builds" "$HOME/.botmux/bin"
bmx_test_dir=$(mktemp -d "$HOME/.botmux/builds/auto-model.9.XXXXXX")
printf '执行账号：%s；构建目录：%s\n' "$(id -un)" "$bmx_test_dir"

if [ "$(bun --version 2>/dev/null || true)" != '1.4.3' ]; then
  if ! command -v unzip >/dev/null 2>&1; then
    printf '安装 Bun 1.4.3 需要 unzip，请先安装 unzip 后重试。\n' >&2
    exit 1
  fi
  curl -fsSL https://bun.sh/install -o "$bmx_test_dir/install-bun.sh"
  BUN_INSTALL="$bmx_test_dir/bun" bash "$bmx_test_dir/install-bun.sh" bun-v1.4.3
  export PATH="$bmx_test_dir/bun/bin:$PATH"
fi

git clone --depth 1 --single-branch --branch test/traex-auto-model-v348-9 \
  https://github.com/xinna2001/botmux.git "$bmx_test_dir/src"
cd "$bmx_test_dir/src"
if [ "$(git rev-parse HEAD)" != "$bmx_test_commit" ]; then
  printf '源码提交与 .9 固定提交不一致，安装已中止。\n' >&2
  exit 1
fi
bun install --frozen-lockfile
bun run build
BOTMUX_VERIFY_BAKED_VERSION="$bmx_test_version" bun run build:bun
if [ "$(./dist-bin/botmux --version)" != "$bmx_test_version" ]; then
  printf '新二进制版本检查未通过，安装已中止。\n' >&2
  exit 1
fi

if [ -e "$HOME/.botmux/bin/botmux" ]; then
  cp -pL "$HOME/.botmux/bin/botmux" "$bmx_test_dir/botmux-before"
  printf '旧程序备份：%s\n' "$bmx_test_dir/botmux-before"
fi
bmx_test_entry=$(mktemp "$HOME/.botmux/bin/.auto-model.9.XXXXXX")
trap 'rm -f -- "$bmx_test_entry"' EXIT
install -m 755 ./dist-bin/botmux "$bmx_test_entry"
mv -f "$bmx_test_entry" "$HOME/.botmux/bin/botmux"
export PATH="$HOME/.botmux/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"
"$HOME/.botmux/bin/botmux" restart
"$HOME/.botmux/bin/botmux" --version
"$HOME/.botmux/bin/botmux" status
