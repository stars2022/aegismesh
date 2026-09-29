#!/usr/bin/env bash
set -euo pipefail

# This installer predates release directories and the independent mTLS worker.
# Never overwrite an existing production installation by merely running it.
if [[ "${1:---check}" == "--check" ]]; then
    exec bash "$(dirname "${BASH_SOURCE[0]}")/deploy-check.sh"
fi
if [[ "${1:-}" != "--bootstrap" ]]; then
    echo "Usage: $0 --check | --bootstrap (new host only)" >&2
    exit 2
fi
if systemctl cat aegismesh.service >/dev/null 2>&1; then
    echo "已有 AegisMesh 服务：禁止旧安装流程覆盖现网。请使用分版本发布并保留现有 Nginx/mTLS/日志配置。" >&2
    exit 1
fi

echo "=== [1/6] 检查与安装系统基础依赖 ==="
sudo apt-get update -y
sudo apt-get install -y python3-pip python3-venv git curl nginx build-essential

# 安装 Node.js 20+
if ! command -v node &> /dev/null || [ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 18 ]; then
    echo "正在安装 Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo "Node.js 版本: $(node -v)"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CURRENT_USER="$(whoami)"
echo "项目路径: $APP_DIR"
echo "运行用户: $CURRENT_USER"

echo "=== [2/6] 安装后端依赖 ==="
cd "$APP_DIR"
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -e '.[test]'

if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "已生成 .env 文件，请稍后检查配置"
fi

read_env() {
    local key="$1"
    awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' .env
}

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

if [[ "$(read_env ADMIN_AUTH_ENABLED)" != "true" ]] || [[ -z "$(read_env ADMIN_SESSION_SECRET)" ]]; then
    echo "公开部署前必须完成管理员安全初始化。"
    "$APP_DIR/scripts/setup-admin.sh"
fi
set_env "ADMIN_AUTH_ENABLED" "true"
set_env "ADMIN_COOKIE_SECURE" "true"
chmod 600 .env

TLS_CERT_FILE="$(read_env TLS_CERT_FILE)"
TLS_KEY_FILE="$(read_env TLS_KEY_FILE)"
if [[ -z "$TLS_CERT_FILE" ]] || [[ -z "$TLS_KEY_FILE" ]]; then
    echo "公开部署要求在 .env 中配置 TLS_CERT_FILE 与 TLS_KEY_FILE。" >&2
    exit 1
fi
if [[ "$TLS_CERT_FILE" != /* ]]; then
    TLS_CERT_FILE="$APP_DIR/$TLS_CERT_FILE"
fi
if [[ "$TLS_KEY_FILE" != /* ]]; then
    TLS_KEY_FILE="$APP_DIR/$TLS_KEY_FILE"
fi
if [[ ! -r "$TLS_CERT_FILE" ]] || [[ ! -r "$TLS_KEY_FILE" ]]; then
    echo "TLS 证书或私钥不可读，部署已停止。" >&2
    exit 1
fi

echo "=== [3/6] 编译前端静态资源 ==="
cd "$APP_DIR/frontend"
npm ci
npm run build

echo "=== [4/6] 配置 Systemd 后端常驻服务 ==="
cat <<EOF | sudo tee /etc/systemd/system/aegismesh.service
[Unit]
Description=AegisMesh Multi-Agent Platform
After=network.target

[Service]
User=$CURRENT_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/.venv/bin/uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3
Environment="PYTHONPATH=backend"
EnvironmentFile=$APP_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable aegismesh
sudo systemctl restart aegismesh

echo "=== [5/6] 配置 Nginx 反向代理 ==="
cat <<EOF | sudo tee /etc/nginx/sites-available/aegismesh
limit_req_zone \$binary_remote_addr zone=aegismesh_auth:10m rate=5r/m;

server {
    listen 80;
    server_name _;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name _;

    ssl_certificate $TLS_CERT_FILE;
    ssl_certificate_key $TLS_KEY_FILE;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        root $APP_DIR/frontend/dist;
        index index.html;
        try_files \$uri \$uri/ /index.html;
    }

    location ^~ /aip/ {
        return 404;
    }

    location ~ ^/(api|\.well-known|docs|openapi\.json) {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    location = /api/admin/login {
        limit_req zone=aegismesh_auth burst=3 nodelay;
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location = /api/demo/login {
        limit_req zone=aegismesh_auth burst=3 nodelay;
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/aegismesh /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

echo "=== [6/7] 配置 AMP Fluent Bit 日志转发 ==="
bash "$APP_DIR/scripts/setup_fluentbit.sh"

echo "=== [7/7] 部署完成！==="
PUBLIC_IP=$(curl -s ifconfig.me || echo "你的公网IP")
echo "服务已成功启动："
echo "- 前端聊天界面: https://$PUBLIC_IP/"
echo "- 管理后台控制台: https://$PUBLIC_IP/admin"
echo "- 标准能力规范: https://$PUBLIC_IP/.well-known/acs.json"
echo "- OpenAPI 文档: https://$PUBLIC_IP/docs"
