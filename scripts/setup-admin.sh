#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if [[ ! -x ".venv/bin/python" ]]; then
  echo "请先创建 .venv 并安装项目依赖。" >&2
  exit 1
fi

if [[ ! -f ".env" ]]; then
  cp .env.example .env
fi

read -r -p "管理员用户名：" ADMIN_NAME
read -r -s -p "管理员密码（至少 8 位）：" ADMIN_PASSWORD
echo
read -r -s -p "再次输入密码：" ADMIN_PASSWORD_CONFIRM
echo

if [[ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]]; then
  echo "两次输入的密码不一致。" >&2
  exit 1
fi

SESSION_SECRET="$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(48))')"
PROVIDER_SECRET="$(.venv/bin/python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"

set_env() {
  local key="$1"
  local value="$2"
  local temp_file
  temp_file="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $0 ~ "^" key "=" { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' .env > "$temp_file"
  mv "$temp_file" .env
}

set_env "ADMIN_AUTH_ENABLED" "true"
set_env "ADMIN_SESSION_SECRET" "$SESSION_SECRET"
set_env "PROVIDER_ENCRYPTION_KEY" "$PROVIDER_SECRET"
chmod 600 .env

printf '%s\n' "$ADMIN_PASSWORD" | PYTHONPATH=backend .venv/bin/python -m app.cli admin set \
  --username "$ADMIN_NAME" --password-stdin

echo "后台安全登录已启用。"
