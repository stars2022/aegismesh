#!/usr/bin/env bash
set -euo pipefail

LIVE_DIR="${AEGISMESH_UI_LIVE_DIR:-/var/www/aegismesh}"
RELEASE_DIR="${AEGISMESH_UI_RELEASE_DIR:-/var/www/aegismesh-releases}"

usage() {
    echo "用法："
    echo "  $0 save <版本名> [构建目录]"
    echo "  $0 switch <版本名>"
    echo "  $0 list"
}

validate_name() {
    local release_name="$1"
    if [[ ! "$release_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
        echo "版本名只能包含字母、数字、点、下划线和短横线。" >&2
        exit 2
    fi
}

command_name="${1:-}"

case "$command_name" in
    save)
        release_name="${2:-}"
        source_dir="${3:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../frontend/dist" && pwd)}"
        [[ -n "$release_name" ]] || { usage; exit 2; }
        validate_name "$release_name"
        [[ -f "$source_dir/index.html" ]] || {
            echo "构建目录无效：$source_dir" >&2
            exit 1
        }
        if sudo test -e "$RELEASE_DIR/$release_name"; then
            echo "版本已存在，不会覆盖：$release_name" >&2
            exit 1
        fi
        sudo mkdir -p "$RELEASE_DIR/$release_name"
        sudo rsync -a --delete "$source_dir/" "$RELEASE_DIR/$release_name/"
        echo "已保存界面版本：$release_name"
        ;;
    switch)
        release_name="${2:-}"
        [[ -n "$release_name" ]] || { usage; exit 2; }
        validate_name "$release_name"
        [[ -f "$RELEASE_DIR/$release_name/index.html" ]] || {
            echo "找不到界面版本：$release_name" >&2
            exit 1
        }
        rollback_name="rollback-$(date +%Y%m%d-%H%M%S)"
        sudo mkdir -p "$RELEASE_DIR/$rollback_name"
        sudo rsync -a --delete "$LIVE_DIR/" "$RELEASE_DIR/$rollback_name/"
        sudo rsync -a --delete "$RELEASE_DIR/$release_name/" "$LIVE_DIR/"
        echo "已切换到：$release_name"
        echo "切换前的界面已保存为：$rollback_name"
        ;;
    list)
        if ! sudo test -d "$RELEASE_DIR"; then
            echo "还没有保存界面版本。"
            exit 0
        fi
        sudo find "$RELEASE_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
        ;;
    *)
        usage
        exit 2
        ;;
esac
