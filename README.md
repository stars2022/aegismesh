# AegisMesh

AegisMesh 是一个 ACPs/AIP 兼容的多智能体构建与运营平台。平台可以创建协调型或执行型智能体，提供质量路由、协同执行、自动故障迁移、智能体探针、运行记录、统计面板、开放 API 和聊天界面。

## 架构

- `backend/app/services/transport.py`：AIP RPC、OpenAI Responses、Anthropic Messages 与兼容聊天补全适配层
- `backend/app/services/prompt.py`：聊天界面的多轮工具执行提示词；普通 API 使用智能体自定义提示词
- `backend/app/services/hosted_aip.py`：平台托管 Partner 的 AIP 任务生命周期
- `backend/app/services/acs.py`：标准 ACS 能力声明生成与校验
- `backend/app/services/router.py`：协议兼容硬约束筛选与贝叶斯反馈校准的混合熵权 TOPSIS 路由
- `backend/app/services/aip_group.py`：AIP 国标群组模式桥——配置 `AIP_GROUP_MQ_URL`（或 `AIP_GROUP_MQ_HOST` 等）后支持 RabbitMQ 群组邀请、议题和回传；`aip_group_partner.py` 在 `AIP_GROUP_PARTNER_ENABLED=true` 时接受外部群组任务。兼容模式下，托管智能体的派发通过官方 MQ 完成，失败不回退本地直调。
- `backend/app/services/orchestrator.py`：智能体主导的任务运行时——执行型智能体直接执行（含声明工具）；协调型智能体注入平台 harness 协调提示词，通过 `list_agents` / `dispatch_task` 平台调度工具规划、派发子任务并汇总结果；未指定智能体时按质量路由自动选择，保留广播协同、熔断与自动迁移
- `backend/app/services/discovery.py`：基于官方 SDK 的 ADP 跨平台发现客户端
- `backend/app/seed.py`：默认路由策略与预置智能体目录；内置方式三「发现智能体」（智能体发现助手），自然语言需求经协调者工具链检索本地注册表 + ADP 全网发现，输出带质量评分的推荐名单与智能体/技能组合建议
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

同一 `session_id` 的已完成轮次会作为真实会话上下文传给后续智能体。平台以智能体为运行单位：聊天界面按智能体发起任务，选择执行型智能体即直接对话（可使用其声明工具）；选择协调型智能体则由平台执行其协同调度（子任务由平台按质量路由派发给执行型智能体，结果回传给协调者汇总）。配置 `ADP_DISCOVERY_URL` 后，可通过 `POST /api/discovery/search` 发现其他平台发布的智能体。平台预置方式三「发现智能体」（agent_discovery，协调型）：在聊天端直接对它用自然语言描述需求，即可得到带质量评分的候选名单与智能体/技能组合建议；其 ACS 中声明了 `discovery.nl_agent_discovery` 技能，外部平台也可经 AIP 调用。

工作区默认不创建 Agent，也不生成调用记录或统计占位值。面板数据来自数据库中的实际配置、探针结果与运行记录。

## 独立联网搜索

管理后台「模型供应商」下方的「联网搜索」面板独立管理搜索服务，不修改智能体的模型绑定或 AIC。

- **Exa**：可先不填密钥使用免密限流额度；正式持续运行建议配置独立 Exa API Key。固定连接 `https://mcp.exa.ai/mcp`，密钥只发给 Exa，不复用推理供应商密钥。
- **DeepSeek**：另建一条启用的供应商（例如标识 `deepseek-search`、地址 `https://api.deepseek.com`、独立 DeepSeek 密钥），在搜索设置中选择它。搜索始终走 DeepSeek 的 Anthropic Messages 接口；主模型可以来自另一供应商。`DEEPSEEK_SEARCH_MODEL` 控制搜索模型，不读取主模型的名称。
- **关闭搜索**：不注册 `web_search`，但不影响智能体发现、派发及其他工具。
- **沿用旧配置**：升级默认保留的兼容选项，仅当前推理供应商为官方 DeepSeek 地址时启用旧搜索。须手动保存 Exa 或独立 DeepSeek，才能与推理供应商完全解耦；升级不会擅自新增外部调用。

智能体仍须在自身工具列表中启用 `web_search`。聊天、画布和外部 AIP 托管任务共用同一工具注册入口；搜索设置不改变外部子智能体派发权限。

「测试搜索」使用未保存的草稿发起一次真实检索，展示来源和耗时，**不会自动保存设置**。DeepSeek 检索及整理会产生模型 token 用量；Exa 的免密额度可能限流。不能把网页搜索当作免费无限服务。

独立模式支持超时、结果数及单次执行的搜索工具调用上限（包括失败请求；重复查询命中缓存不计费、不占次数）。上限针对一个执行实例，外部递归子任务各自计数，不是整条调用链的总预算。DeepSeek 的一次工具调用还可能包含多次服务端搜索。来源返回标题、URL、摘要和可用的发布时间；纯文本或服务错误不会被当成已核实来源。

搜索密钥复用平台的加密存储机制，不在读取接口、审计或数据库导出中返回。数据导入后独立搜索默认关闭，需检查供应商与密钥后重新启用。配置接口为 `/api/admin/web-search`，真实检索测试为 `/api/admin/web-search/test`，均要求管理员身份。配置变更和检索测试可在管理审计中查看。

## 工具预算、协作记录与上下文审核

普通聊天、画布、外部 AIP 托管任务使用同一默认工具预算，可通过环境变量调整并重启服务：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `COORDINATION_TOOL_ROUNDS` | 24 | 每次协调型模型执行的工具轮数（1–64） |
| `PARTNER_TOOL_ROUNDS` | 12 | 每次执行型模型执行的工具轮数（1–32） |
| `MAX_DISPATCHES_PER_COORDINATOR` | 16 | 每个协调分支直接派发次数（1–32） |
| `MAX_DISPATCHES_PER_TASK` | 64 | 同一运行实例内全部分支的派发安全上限（1–128） |

一轮可以含多个工具调用，轮数不等于工具总次数；达到预算后仍需汇总已有结果。最多三级调用、循环检测、总时限和空闲超时继续生效。远端外部平台自行控制其内部预算。联网搜索另有后台可配置的每智能体上限，默认 8 次；失败计数，缓存命中不计数。增加工具轮数不会自动扩大搜索配额。

子任务按 `session_id`、`invocation_id`、`task_id` 绑定；每次工具执行另有稳定 ID。开始、完成、失败和取消均保存快照，不依赖最终答复才落库。`GET /api/chat/sessions/{session_id}/activity` 按当前调用者身份读取和分页，不能仅凭 session ID 读取其他人的历史。协作面板默认展示本会话，支持切回本轮；刷新、断线及任务中断后仍可查看已保存记录。旧任务可从已有派发事件恢复基本信息，但无法补造过去未保存的工具输出。

协调者先调用 `prepare_dispatch_context(task)` 查看候选片段，再在 `dispatch_task` 中提交本任务对应的 `context_review_id` 和明确选取的 `context_ids`。未选片段一律不转发；片段标记为“可能有用、尚待核实的参考资料”，不能当作指令或已核实事实。嵌套协调者只能预览上级已审核资料和自己的子任务回传，不能读取整个用户会话。路由服务仅推荐候选，不替协调者审核上下文。这里的审核是主智能体明确选择，不额外要求用户逐次点击批准。

工作流工具每次执行一个步骤，群体讨论工具每次执行一轮独立观点收集；后续步骤或轮次交还协调模型审核后再派发，避免工具内部自动转发同伴文本。

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

管理后台「日志与审计」支持 AMP 日志查询、任务关联、管理操作审计和脱敏导出，且不改变直通上报链路。权限、保留策略和部署说明见 [日志与审计](docs/observability.md)。

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
