#!/usr/bin/env bash
#
# support-vision 安装脚本（Mac / Linux / WSL）
#
# 用法:
#   bash install.sh                    # 安装到默认目录
#   bash install.sh --dir /path/to/dir # 指定目录
#   bash install.sh --uninstall        # 卸载
#
# 一行安装:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/a-lang/support-vision/main/install.sh)"
#

set -e

SKILL_NAME="support-vision"
REPO_URL="https://github.com/a-lang/support-vision.git"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "  ${CYAN}ℹ${NC} $1"; }
ok()    { echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { echo -e "  ${YELLOW}⚠${NC} $1"; }
err()   { echo -e "  ${RED}✖${NC} $1"; }

banner() {
  echo ""
  echo "  ┌──────────────────────────────────────────────┐"
  echo "  │           support-vision 安装               │"
  echo "  └──────────────────────────────────────────────┘"
  echo ""
}

# 检查 git
check_git() {
  if ! command -v git &>/dev/null; then
    err "需要 git，请先安装: https://git-scm.com"
    exit 1
  fi
}

# 检查 node
check_node() {
  if ! command -v node &>/dev/null; then
    err "需要 Node.js 18+，请先安装: https://nodejs.org"
    exit 1
  fi
}

# 检测 skill 目录
detect_dir() {
  local home="$HOME"
  if [ -d "$home/.agents/skills" ]; then
    echo "$home/.agents/skills"
  elif [ -d "$home/.pi/agent/skills" ]; then
    echo "$home/.pi/agent/skills"
  else
    echo "$home/.agents/skills"
  fi
}

# 安装
do_install() {
  banner
  check_git
  check_node

  local target_dir="${1:-$(detect_dir)}"
  local dest="$target_dir/$SKILL_NAME"

  mkdir -p "$target_dir"

  # 如果已存在，先删除
  if [ -d "$dest" ]; then
    warn "已存在: $dest"
    read -p "  是否覆盖？[Y/n] " confirm
    confirm="${confirm:-Y}"
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      rm -rf "$dest"
    else
      info "已取消"
      exit 0
    fi
  fi

  # 克隆整个 repo 到临时目录，复制技能文件
  local tmp_dir="$(mktemp -d)"
  info "正在下载..."
  git clone --depth 1 "$REPO_URL" "$tmp_dir" 2>/dev/null || {
    err "克隆失败，请检查网络"
    rm -rf "$tmp_dir"
    exit 1
  }

  # 检查技能文件存在
  if [ ! -f "$tmp_dir/SKILL.md" ]; then
    err "未找到技能文件: SKILL.md"
    rm -rf "$tmp_dir"
    exit 1
  fi

  # 复制技能文件
  cp -r "$tmp_dir/scripts" "$tmp_dir/SKILL.md" "$tmp_dir/config.example.json" "$tmp_dir/references" "$dest"
  rm -rf "$tmp_dir"

  ok "已安装到: $dest"
  echo ""
  echo "  ━━━ 下一步 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  1. 初始化模型:"
  echo ""
  echo "     node $dest/scripts/vision.mjs init"
  echo ""

  # 询问是否初始化
  read -p "  现在初始化？[Y/n] " do_init
  do_init="${do_init:-Y}"
  if [[ "$do_init" =~ ^[Yy]$ ]]; then
    echo ""
    node "$dest/scripts/vision.mjs" init
  fi

  echo ""
  ok "安装完成！"
}

# 卸载
do_uninstall() {
  banner
  local home="$HOME"
  local found=0

  for dir in "$home/.agents/skills" "$home/.pi/agent/skills"; do
    if [ -d "$dir/$SKILL_NAME" ]; then
      echo "  找到: $dir/$SKILL_NAME"
      found=1
    fi
  done

  if [ $found -eq 0 ]; then
    info "未检测到已安装的 support-vision"
    exit 0
  fi

  read -p "  确认卸载？[y/N] " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    for dir in "$home/.agents/skills" "$home/.pi/agent/skills"; do
      if [ -d "$dir/$SKILL_NAME" ]; then
        rm -rf "$dir/$SKILL_NAME"
        ok "已删除: $dir/$SKILL_NAME"
      fi
    done
    echo ""
    ok "卸载完成"
  else
    info "已取消"
  fi
}

# 主入口
case "${1:-}" in
  --uninstall|-u)
    do_uninstall
    ;;
  --dir)
    do_install "$2"
    ;;
  *)
    do_install "$1"
    ;;
esac
