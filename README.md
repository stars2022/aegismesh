# AegisMesh

AegisMesh 是一个 ACPs/AIP 兼容的多智能体构建与运营平台。平台可以创建协调型或执行型智能体，提供质量路由、协同执行、自动故障迁移、智能体探针、运行记录、统计面板、开放 API 和聊天界面。

## 架构

- `backend/app/services/transport.py`：AIP RPC、OpenAI Responses、Anthropic Messages 与兼容聊天补全适配层
- `backend/app/services/prompt.py`：聊天界面的多轮工具执行提示词；普通 API 使用智能体自定义提示词
- `backend/app/services/hosted_aip.py`：平台托管 Partner 的 AIP 任务生命周期
- `backend/app/services/acs.py`：标准 ACS 能力声明生成与校验
- `backend/app/services/router.py`：协议兼容硬约束筛选与贝叶斯反馈校准的混合熵权 TOPSIS 路由
- `backend/app/services/orchestrator.py`：智能体主导的任务运行时——执行型智能体直接执行（含声明工具）；协调型智能体注入平台 harness 协调提示词，通过 `list_agents` / `dispatch_task` 平台调度工具规划、派发子任务并汇总结果；未指定智能体时按质量路由自动选择，保留广播协同、熔断与自动迁移
- `backend/app/services/discovery.py`：基于官方 SDK 的 ADP 跨平台发现客户端
- `backend/app/services/tools.py`：受控工具注册与执行
- `backend/app/services/probe.py`：ACS/AIP 探针与兼容性分析
- `frontend/`：根路径聊天端与 `/admin` 管理后台

内部运行状态与 AIP 协议状态分离。对外任务通信只使用官方 SDK 定义的 `TaskCommand`、`TaskResult` 和 `TaskState`。

## 本地启动

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[test]'
.venv/bin/uvicorn app.main:app --app-dir backend --reload
```

另开终端：

```bash
cd frontend
npm install
npm run dev
```

- 聊天入口：`http://localhost:5173`
- 管理后台：`http://localhost:5173/admin`
- OpenAPI：`http://localhost:8000/docs`
- 平台 ACS：`http://localhost:8000/.well-known/acs.json`

## 真实 AIP Partner

在 Agent Studio 中将传输方式改为 `AIP Direct RPC`，填写 Partner 的 `/rpc` 地址与 AIC。运行时会通过官方 `AipRpcClient` 发送标准命令并轮询标准任务状态。

平台内创建的 Partner 同时提供 `/api/agents/{agent_id}/acs` 能力声明和 `/aip/{agent_id}/rpc` JSON-RPC 端点，可接受 AIP `start`、`get`、`complete`、`cancel` 与 `continue` 命令。

智能体可单独开启“实时流式输出”。开启后，兼容聊天补全、OpenAI Responses 与 Anthropic Messages 的模型增量会直接传递到 `/api/chat/stream`、聊天界面和 AIP `/stream`；关闭后只返回最终结果，ACS 中的 `capabilities.streaming` 同步为 `false`。

在管理后台“模型供应商”中可以添加兼容聊天补全、OpenAI Responses 和 Anthropic Messages 配置，填写接口地址、密钥与默认模型，并进行真实连接测试。智能体可选择其中一个供应商，也可接入外部 AIP RPC。

同一 `session_id` 的已完成轮次会作为真实会话上下文传给后续智能体。平台以智能体为运行单位：聊天界面按智能体发起任务，选择执行型智能体即直接对话（可使用其声明工具）；选择协调型智能体则由平台执行其协同调度（子任务由平台按质量路由派发给执行型智能体，结果回传给协调者汇总）。配置 `ADP_DISCOVERY_URL` 后，可通过 `POST /api/discovery/search` 发现其他平台发布的智能体。

工作区默认不创建 Agent，也不生成调用记录或统计占位值。面板数据来自数据库中的实际配置、探针结果与运行记录。

## 多维度质量路由

平台采用“贝叶斯反馈校准的混合熵权 TOPSIS”完成异构智能体排序，可作为项目的核心路由创新点：

1. 先根据能力声明、输入输出格式、安全方案、传输方式、健康状态与熔断状态构造可行候选域，避免高分智能体绕过协议约束。
2. 对能力匹配、历史可靠性、用户反馈、响应延迟、实时负载、健康状态和成本七个指标统一正向化。可靠性与用户反馈使用 Beta 先验平滑，冷启动保持中性，少量极端评价不会直接主导路由。
3. 管理员配置形成主观权重；每次请求再根据候选矩阵的信息熵计算客观区分度，按 `72% 主观权重 + 28% 熵权` 动态融合。某个指标在当前候选间越有区分力，获得的请求级权重越高。
4. 对加权矩阵计算正、负理想解及欧氏距离，得到 TOPSIS 贴近度；最终分数以 `80% 理想解贴近度 + 20% 绝对效用` 校准，避免候选很少或表现接近时相对排名失真。
5. 用户对真实完成任务的评价通过对象级授权写回所选智能体，并进入后续路由；运行成功率、延迟、负载和健康度同样来自实际调用记录，形成可解释的在线反馈闭环。

该方法不依赖额外训练服务，计算复杂度随候选数和指标数线性增长，适合在路由热路径实时执行；管理后台保留各维度权重，运行侧展示最终排名与分项依据。

开放 API 必须使用 `X-API-Key`。可在管理后台“访问与数据”中设置 Key、配置聊天访问密码，并导出或导入业务数据库。环境变量 `PUBLIC_API_KEY` 可覆盖后台配置的开放 API Key。

## 管理员登录

首次部署可运行：

```bash
./scripts/setup-admin.sh
```

脚本会启用 `ADMIN_AUTH_ENABLED`、生成会话密钥与供应商密钥加密密钥，并交互式创建管理员。后续修改账户或密码：

```bash
PYTHONPATH=backend .venv/bin/python -m app.cli admin set --username admin
```

管理员接口默认拒绝未完成初始化的访问。生产部署脚本要求提供 `TLS_CERT_FILE` 与
`TLS_KEY_FILE`，自动启用 HTTPS、HTTP 重定向、HSTS 和 Secure 管理员 Cookie。

## 注册、审核与证书

对接官方 registry-server 与 ca-server 的完整链路：

- 创建智能体时可选择“本地创建”或“已有可信 AIC”。本地创建无需填写 AIC，可直接用于平台内部调度；已有可信 AIC 可按配置对外提供服务。
- 配置 `REGISTRY_API_URL`、`REGISTRY_USERNAME`、`REGISTRY_PASSWORD` 后，本地智能体可在卡片上“提交验证”。平台按照官方流程创建草稿并提交审核，初次提交的 ACS 中 AIC 为空。
- 默认注册服务地址为 `https://wt.ioa.pub/registry-server/api/v1`，与 `https://wt.ioa.pub/registry/` 管理页面使用的是同一个后端。网页用于人工操作，平台通过同一组接口自动完成草稿、提交和同步。
- “同步审核”读取注册服务的审核状态。审核通过后，注册服务分配的 AIC 会回写本地，随后可调整为对外服务。
- “签发证书”向注册服务获取 EAB 凭据，再通过 CA 签发 mTLS 客户端证书。
- 配置 `PUBLIC_BASE_URL` 后，平台会将公开的托管 AIP 地址写入提交的 ACS；未配置时使用当前请求的服务地址。
- **EAB 与证书签发**：`POST /api/agents/{id}/eab` 用 AIC 换取一次性 EAB 凭据；`POST /api/agents/{id}/certificate` 基于官方 `acps-cli` 的 ACME 客户端向 `CA_SERVER_URL` 完成账户绑定、下单与签发，证书/私钥/CSR 落盘到 `CERTS_DIR`。把 `AIP_CERT_FILE`、`AIP_KEY_FILE`、`AIP_CA_FILE` 指向签发产物即可启用出站 mTLS。
- **入站 mTLS**：托管 AIP 端点必须使用独立监听。配置 `AIP_IDENTITY_BINDING_ENABLED=true`、`AIP_TLS_CERTFILE`、`AIP_TLS_KEYFILE`、`AIP_TLS_CLIENT_CA_FILE`、`AIP_TLS_PORT` 与指向该监听的 HTTPS `PUBLIC_BASE_URL`，再用 `PYTHONPATH=backend .venv/bin/python -m scripts.serve` 启动。普通 Web Nginx 入口不会转发 `/aip/*`。
- **通知回调**：仅允许 `AIP_NOTIFICATION_ALLOWED_ORIGINS` 中显式列出的 HTTPS 来源；以逗号分隔多个来源。私有、环回、链路本地和保留地址会被拒绝。

本地开发可以使用纯 HTTP，但管理员接口仍需先运行 `scripts/setup-admin.sh` 完成初始化。

## 测试

```bash
.venv/bin/pytest
cd frontend && npm run build
```

## 界面版本切换

生产环境可保留多个前端静态版本，切换时会自动再保存一次当前界面：

```bash
./scripts/ui-release.sh save classic-20260921
./scripts/ui-release.sh list
./scripts/ui-release.sh switch classic-20260921
```

默认线上目录为 `/var/www/aegismesh`，版本目录为
`/var/www/aegismesh-releases`。可分别通过 `AEGISMESH_UI_LIVE_DIR` 与
`AEGISMESH_UI_RELEASE_DIR` 调整。
