#!/usr/bin/env bash
# ==============================================================================
# AegisMesh - AMP 可观测性 Forwarder (Fluent Bit) 自动化安装与配置脚本
# 功能：
#   1. 检测并安装 Fluent Bit (官方 apt 软件源或官方安装脚本)
#   2. 生成标准 parsers.conf 与 fluent-bit.conf
#   3. 尾追本地 logs/amp_*.jsonl 日志，转发至官方 Kafka 集群 (wt.ioa.pub:19092)
#   4. 配置并拉起 aegismesh-fluentbit systemd 守护进程
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs"
CONFIG_DIR="${ROOT_DIR}/backend/config/fluent-bit"
KAFKA_BROKER="${AMP_KAFKA_BROKER:-wt.ioa.pub:19092}"

echo "=================================================="
echo "  AegisMesh AMP Fluent Bit 部署脚本"
echo "  工作目录:   ${ROOT_DIR}"
echo "  日志目录:   ${LOG_DIR}"
echo "  上报端点:   ${KAFKA_BROKER}"
echo "=================================================="

mkdir -p "${LOG_DIR}"
mkdir -p "${ROOT_DIR}/backend/logs"
ln -sfn "${LOG_DIR}" "${ROOT_DIR}/backend/logs_link" 2>/dev/null || true
mkdir -p "${CONFIG_DIR}"
mkdir -p /tmp/aegismesh-fluentbit-db

# 1. 检测并安装 Fluent Bit
if ! command -v fluent-bit >/dev/null 2>&1 && [ ! -x /opt/fluent-bit/bin/fluent-bit ]; then
    echo "[1/4] 安装 Fluent Bit..."
    if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        sudo apt-get update && sudo apt-get install -y gpg gnupg curl
        curl -fsSL https://raw.githubusercontent.com/fluent/fluent-bit/master/install.sh | sh
    elif command -v brew >/dev/null 2>&1; then
        brew install fluent-bit
    else
        echo "未识别的包管理器，请手动安装 Fluent Bit 后重新运行此脚本。"
        exit 1
    fi
fi

if [ -x /opt/fluent-bit/bin/fluent-bit ] && ! command -v fluent-bit >/dev/null 2>&1; then
    sudo ln -sf /opt/fluent-bit/bin/fluent-bit /usr/local/bin/fluent-bit 2>/dev/null || true
fi

echo "[1/4] Fluent Bit 已就绪: $(command -v fluent-bit || echo /opt/fluent-bit/bin/fluent-bit) ($(fluent-bit --version 2>&1 | head -n 1 || true))"

# 2. 生成 parsers.conf
echo "[2/4] 写入 parsers.conf..."
cat << 'EOF' > "${CONFIG_DIR}/parsers.conf"
[PARSER]
    Name        amp_audit_json
    Format      json
    Time_Key    timestamp
    Time_Format %Y-%m-%dT%H:%M:%S.%L%z
    Time_Keep   On
EOF

# 3. 生成 fluent-bit.conf
echo "[3/4] 写入 fluent-bit.conf..."
cat << EOF > "${CONFIG_DIR}/fluent-bit.conf"
[SERVICE]
    Flush           1
    Log_Level       info
    Parsers_File    ${CONFIG_DIR}/parsers.conf

# ── Heartbeat ──────────────────────────────────────────────
[INPUT]
    Name             tail
    Path             ${LOG_DIR}/amp_heartbeat*.jsonl
    Tag              amp.heartbeat
    Parser           amp_audit_json
    Refresh_Interval 2
    Read_From_Head   True
    DB               /tmp/aegismesh-fluentbit-db/heartbeat.db

[OUTPUT]
    Name                              kafka
    Match                             amp.heartbeat
    Brokers                           ${KAFKA_BROKER}
    Topics                            amp.heartbeat
    Workers                           1
    rdkafka.log.connection.close      false
    rdkafka.request.required.acks     1
    rdkafka.allow.auto.create.topics  false

# ── Access (双向撮合与排行榜核心) ──────────────────────────
[INPUT]
    Name             tail
    Path             ${LOG_DIR}/amp_access*.jsonl
    Tag              amp.access
    Parser           amp_audit_json
    Refresh_Interval 2
    Read_From_Head   True
    DB               /tmp/aegismesh-fluentbit-db/access.db

[OUTPUT]
    Name                              kafka
    Match                             amp.access
    Brokers                           ${KAFKA_BROKER}
    Topics                            amp.access
    Workers                           1
    rdkafka.log.connection.close      false
    rdkafka.request.required.acks     1
    rdkafka.allow.auto.create.topics  false

# ── Metrics ────────────────────────────────────────────────
[INPUT]
    Name             tail
    Path             ${LOG_DIR}/amp_metrics*.jsonl
    Tag              amp.metrics
    Parser           amp_audit_json
    Refresh_Interval 2
    Read_From_Head   True
    DB               /tmp/aegismesh-fluentbit-db/metrics.db

[OUTPUT]
    Name                              kafka
    Match                             amp.metrics
    Brokers                           ${KAFKA_BROKER}
    Topics                            amp.metrics
    Workers                           1
    rdkafka.log.connection.close      false
    rdkafka.request.required.acks     1
    rdkafka.allow.auto.create.topics  false

# ── System ─────────────────────────────────────────────────
[INPUT]
    Name             tail
    Path             ${LOG_DIR}/amp_system*.jsonl
    Tag              amp.system
    Parser           amp_audit_json
    Refresh_Interval 2
    Read_From_Head   True
    DB               /tmp/aegismesh-fluentbit-db/system.db

[OUTPUT]
    Name                              kafka
    Match                             amp.system
    Brokers                           ${KAFKA_BROKER}
    Topics                            amp.system
    Workers                           1
    rdkafka.log.connection.close      false
    rdkafka.request.required.acks     1
    rdkafka.allow.auto.create.topics  false

# ── Message (群组模式) ─────────────────────────────────────
[INPUT]
    Name             tail
    Path             ${LOG_DIR}/amp_message*.jsonl
    Tag              amp.message
    Parser           amp_audit_json
    Refresh_Interval 2
    Read_From_Head   True
    DB               /tmp/aegismesh-fluentbit-db/message.db

[OUTPUT]
    Name                              kafka
    Match                             amp.message
    Brokers                           ${KAFKA_BROKER}
    Topics                            amp.message
    Workers                           1
    rdkafka.log.connection.close      false
    rdkafka.request.required.acks     1
    rdkafka.allow.auto.create.topics  false

# ── Audit ──────────────────────────────────────────────────
[INPUT]
    Name             tail
    Path             ${LOG_DIR}/amp_audit*.jsonl
    Tag              amp.audit
    Parser           amp_audit_json
    Refresh_Interval 2
    Read_From_Head   True
    DB               /tmp/aegismesh-fluentbit-db/audit.db

[OUTPUT]
    Name                              kafka
    Match                             amp.audit
    Brokers                           ${KAFKA_BROKER}
    Topics                            amp.audit
    Workers                           1
    timestamp_key                     _fb_ts
    rdkafka.log.connection.close      false
    rdkafka.request.required.acks     1
    rdkafka.allow.auto.create.topics  true
EOF

# 4. 配置 systemd 服务（如果在 Linux 环境下）
if [ "$(uname -s)" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
    echo "[4/4] 配置 systemd 服务 aegismesh-fluentbit.service..."
    FLUENT_BIN="$(command -v fluent-bit || echo '/opt/fluent-bit/bin/fluent-bit')"
    
    sudo tee /etc/systemd/system/aegismesh-fluentbit.service > /dev/null << EOF
[Unit]
Description=AegisMesh AMP Fluent Bit Log Forwarder
After=network.target

[Service]
Type=simple
ExecStart=${FLUENT_BIN} -c ${CONFIG_DIR}/fluent-bit.conf
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable aegismesh-fluentbit.service
    sudo systemctl restart aegismesh-fluentbit.service
    echo "✓ aegismesh-fluentbit 服务已启动并设置开机自启！"
    sudo systemctl status aegismesh-fluentbit.service --no-pager || true
else
    echo "[4/4] 非 Linux systemd 环境，可通过前台命令启动:"
    echo "  fluent-bit -c ${CONFIG_DIR}/fluent-bit.conf"
fi

echo "=================================================="
echo "  AMP Fluent Bit 转发链路配置完成！"
echo "=================================================="
