#!/usr/bin/env bash
#
# support-vision 安裝指令碼（Mac / Linux / WSL）
#
# 用法:
#   bash install.sh                    # 安裝到預設目錄
#   bash install.sh --dir /path/to/dir # 指定目錄
#   bash install.sh --uninstall        # 解除安裝
#
# 一行安裝:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/a-lang/support-vision/main/install.sh)"
#

set -e

SKILL_NAME="support-vision"
REPO_URL="https://github.com/a-lang/support-vision.git"

# 顏色
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
  echo "  │           support-vision 安裝               │"
  echo "  └──────────────────────────────────────────────┘"
  echo ""
}

# 檢查 git
check_git() {
  if ! command -v git &>/dev/null; then
    err "需要 git，請先安裝: https://git-scm.com"
    exit 1
  fi
}

# 檢查 node
check_node() {
  if ! command -v node &>/dev/null; then
    err "需要 Node.js 18+，請先安裝: https://nodejs.org"
    exit 1
  fi
}

# 偵測 skill 目錄
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

# 安裝
do_install() {
  banner
  check_git
  check_node

  local target_dir="${1:-$(detect_dir)}"
  local dest="$target_dir/$SKILL_NAME"

  mkdir -p "$target_dir"

  # 如果已存在，先刪除
  if [ -d "$dest" ]; then
    warn "已存在: $dest"
    read -p "  是否覆蓋？[Y/n] " confirm
    confirm="${confirm:-Y}"
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      rm -rf "$dest"
    else
      info "已取消"
      exit 0
    fi
  fi

  # 複製整個 repo 到暫存目錄，複製技能檔案
  local tmp_dir="$(mktemp -d)"
  info "正在下載..."
  git clone --depth 1 "$REPO_URL" "$tmp_dir" 2>/dev/null || {
    err "複製失敗，請檢查網路"
    rm -rf "$tmp_dir"
    exit 1
  }

  # 檢查技能檔案存在
  if [ ! -f "$tmp_dir/SKILL.md" ]; then
    err "未找到技能檔案: SKILL.md"
    rm -rf "$tmp_dir"
    exit 1
  fi

  # 複製技能檔案
  cp -r "$tmp_dir/scripts" "$tmp_dir/SKILL.md" "$tmp_dir/config.example.json" "$tmp_dir/references" "$dest"
  rm -rf "$tmp_dir"

  ok "已安裝到: $dest"
  echo ""
  echo "  ━━━ 下一步 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  1. 初始化模型:"
  echo ""
  echo "     node $dest/scripts/vision.mjs init"
  echo ""

  # 詢問是否初始化
  read -p "  現在初始化？[Y/n] " do_init
  do_init="${do_init:-Y}"
  if [[ "$do_init" =~ ^[Yy]$ ]]; then
    echo ""
    node "$dest/scripts/vision.mjs" init
  fi

  echo ""
  ok "安裝完成！"
}

# 解除安裝
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
    info "未偵測到已安裝的 support-vision"
    exit 0
  fi

  read -p "  確認解除安裝？[y/N] " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    for dir in "$home/.agents/skills" "$home/.pi/agent/skills"; do
      if [ -d "$dir/$SKILL_NAME" ]; then
        rm -rf "$dir/$SKILL_NAME"
        ok "已刪除: $dir/$SKILL_NAME"
      fi
    done
    echo ""
    ok "解除安裝完成"
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
