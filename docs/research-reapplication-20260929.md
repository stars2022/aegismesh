# 四个科研智能体重申请 — 2026-09-29

用户明确授权四个科研智能体重新申请并各自分配端口。保留原名称，以 `2.0.0`
另建替代注册记录；没有删除、取消或修改原 APPROVED 记录，也没有更改旅行和新闻的八个身份。
新 AIC 的平台积分不能假定继承旧 AIC。

## 已提交的替代记录

| 本地 ID / 名称 | 新注册记录 ID | 新 HTTPS 端口 | 当前状态 |
| --- | --- | --- | --- |
| research_leader / 科研智能体协作工作台 | 01a0eb79-fb2f-7443-bdc0-ec3070631285 | 8458 | APPROVED |
| docs_overview / 文献检索与知识综述智能体 | 01a0eb7a-043d-7699-b70d-e63bd3eb2f6e | 8459 | APPROVED |
| empirical_design / 研究设计与数据分析智能体 | 01a0eb7a-0953-7439-a5cd-6348aa8d6949 | 8460 | APPROVED |
| peer_review / 论文评审与学术写作智能体 | 01a0eb7a-15b0-779c-b32b-e9a5c8dc3647 | 8461 | APPROVED |

四份申请首次提交返回 PENDING，随后官方读回均为 APPROVED。新 AIC：

| 本地 ID | 新 AIC |
| --- | --- |
| research_leader | 1.2.156.3088.1.BUPT.L2K8YU.7LFQWP.QT8L11.1BF9 |
| docs_overview | 1.2.156.3088.1.BUPT.L2K8YU.SJKLDA.578Y8P.19DJ |
| empirical_design | 1.2.156.3088.1.BUPT.L2K8YU.7AS8QU.INQ4LY.0WL6 |
| peer_review | 1.2.156.3088.1.BUPT.L2K8YU.Q8JP6H.1DNDU6.190G |

四张 clientAuth、四张 serverAuth 已由官方 CA 签发，身份、单一 EKU、密钥匹配、信任链与
serverAuth 的 DNS SAN 均通过校验。证书和私钥仅保存在服务器，未同步到本地或代码仓库。

端点格式为 `https://aip.demmo.cc.cd:<端口>/aip/<本地 ID>/rpc`。
每条 ACS 在提审前均包含：

- 空 `aic`，由官方审核时生成，绝不沿用旧 AIC；
- `certificate.altNames.dns = ["aip.demmo.cc.cd"]`；
- 独立 HTTPS authority 与 `mutualTLS` 安全声明；
- 官方 AMQPS 入口、`inbox_{AIC}` 审批替换占位符及 `amqp:0.9.1` 能力；
- 原有业务能力和已配置工具，协调者仍通过发现服务选择伙伴，不固定科研小组。

## 旧身份保留

| 本地 ID | 原注册记录 ID | 原 AIC 后缀（共同前缀 `1.2.156.3088.1.BUPT.L2K8YU`） |
| --- | --- | --- |
| research_leader | 01a0c919-7e20-71b5-8a1c-0e17466c4403 | 9FTJ5K.FUG31M.0VW4 |
| docs_overview | 01a0c919-7244-73c6-adaf-5fd2cfbfc794 | GVNLWG.B3FPY7.15VB |
| empirical_design | 01a0c919-79db-77f8-898c-766ca1dd2993 | 9MQAHM.WDOPTX.07US |
| peer_review | 01a0c919-7b59-7639-a4a0-84dab0b09024 | 9J8SQZ.G4PJHU.01U7 |

用户明确回复“授权切换”后，四个线上 Agent 绑定已切换到新 AIC、注册记录与证书。
原官方注册记录没有删除或改写，历史调用与本地业务 ID 保留；旅行/新闻 8450–8457 的八个身份不变。
旧 `aegismesh-mtls.service`（8443）已停止并禁用自启动，旧配置、证书和发布目录仍可恢复。

切换后再次核验旧 8443 所用 `.serverauth.pem`：实际 EKU 只有 `clientAuth`，没有 DNS SAN，
CN/URI 是原科研协调者 AIC。使用官方信任包、`sslserver` 用途与 `aip.demmo.cc.cd` 主机名校验，
同时返回 error 26（`unsuitable certificate purpose`）与 error 62（`hostname mismatch`）。
因此不只是另外三个 AIC 身份不匹配，连该证书对应的旧协调者也不能通过标准 HTTPS 服务端校验。
文件名不等于证书用途；客户端证书仍可用于其身份获准的客户端认证，但不能据此宣称旧 HTTPS 入站可用。

## 可恢复执行与切换记录

使用 `scripts/reapply_research_agents.py`，不要执行早期的 `scripts/reapply_agents.py`。
新脚本固定仅处理上述四个 ID，按名称、版本及 ACS 恢复已创建草稿，在提交之前落盘新记录 ID，
进程锁避免并发重复申请。PENDING/APPROVED 不再次提交；REJECTED 需先人工检查。

生产检查点（仅服务器，权限 0600）：
`/home/zcode/aegismesh/backend/data/research-reapplication-20260929.json`。
包含原公开 ACS 快照、新 ACS、新旧注册对应关系及审核状态，不包含密码、EAB 或私钥。
当前代码目录是 `/home/zcode/aegismesh-release-research-identity-20260929`。
执行时需加载该目录的 `public-aip.env`，并使用现有服务器环境配置。

```sh
PYTHONPATH=backend /home/zcode/aegismesh/.venv/bin/python -m scripts.reapply_research_agents \
  --state /home/zcode/aegismesh/backend/data/research-reapplication-20260929.json --sync
```

只有官方 APPROVED 后才可 `--certificates`，分别签发并验证 clientAuth / serverAuth：
AIC、EKU、私钥匹配、信任链与 DNS SAN 必须同时通过。此命令仍不会自动启用身份。

最初公网探针未通过。用户随后确认已放行 TCP **8458–8461**；再次使用四个新 AIC 的真实证书
启动临时预检监听，从外网已逐个完成官方 CA 信任链、DNS 主机名、证书 CN/AIC 和实际响应校验，
四个入口均通过 TLS 1.3；服务器本机也通过四组双向 TLS 握手。临时探针不执行业务任务，自动退出。

首次线上切换命令被执行审批拦截后没有绕过。用户随后明确回复“授权切换”，才重新执行。
一次启动因缺少 Python 模块搜索路径在变更之前退出；修正启动路径后切换完成。
新发布目录 `/home/zcode/aegismesh-release-research-identity-20260929` 已启用；
检查点记录 `activation=active`、`publicPortsVerified=true`、启用时间、发布目录与备份位置。

同时部署的小范围修正：`AIP_AGENT_VERSIONS` 保证科研公开 ACS 与新审批版本 `2.0.0` 一致；
`AIP_RETIRED_AICS` 仅屏蔽本次被替换旧 AIC 的路由资格，保留旧官方身份及历史数据，
也不将新身份偷偷替代用户明确指定的旧 AIC。新版本完整后端 **336 项通过**。

实际切换顺序：核对四条 APPROVED → 验证两类证书 → 公网隔离预检 → 确认没有活跃任务 →
备份数据库、四条绑定、检查点与两个 systemd override → 协调切换绑定、Leader 配置与独立 origin →
启动主 API 和十二个独立 TLS worker → 逐个验证新入口后停用旧服务自启动。
独立 worker 使用新数据库身份及对应证书；只有主 API 负责 MQ 消费、心跳与日志索引。

切换后的实测：

- 四个真实业务监听 8458–8461 均从外网通过官方 CA、DNS 主机名、证书 CN/AIC 及 RPC ping 校验。
- 无客户端身份的 Start 被 401 拒绝；客户端证书与 senderId 不一致被 403 拒绝；
  将其他智能体的路径发给当前专用监听被 421 拒绝，均未启动业务任务。
- API 与十二个 TLS worker 为 active；十二个 MQ Partner 全部报告就绪，其中科研四条均为新 AIC。
- `aegismesh-fluentbit.service` 保持 active，未修改上报配置。
- 全局 `interop_compatibility=false`、`external_delegation_enabled=true` 保持原值。
  普通页面仍按既有模式运行；外部协调任务的下级调用继续强制官方 AIP，不回退本地。

备份位于新发布目录的 `deployment-backup`，包含 `database.sqlite3`、`agent-bindings-before.json`、
`research-manifest-before.json` 和两个旧 override（均仅服务器保存）。原发布目录
`/home/zcode/aegismesh-release-recursive-tools-v2-20260929` 保留。
回退应先检查活跃任务，再按备份恢复指定身份字段和服务配置；不要整库覆盖回退而丢失切换后的新任务。
原 8443 证书本来不满足服务端校验，恢复它仅是恢复原状态，不代表修好了旧入口。

## 切换后的真实协作验收

2026-09-29 05:13 UTC，追踪标识 `research-mtls-99575e2f5090`。
验收脚本以现有新闻协调者的真实客户端身份，通过实时 ADP 发现新科研协调者，再发起官方 AIP 任务。
这一入口由验收脚本发起，不声称是新闻模型自主选择科研协调者。
科研模型实际执行 `list_agents` 精确发现新文献 AIC，并执行一次 `dispatch_task` 等待回传；
脚本没有替模型派发子任务，两段均使用 HTTPS AIP/mTLS，`transport_policy=official-only`。

| 链路 | 官方 taskId | 结果 |
| --- | --- | --- |
| 验收客户端（新闻身份）→ 新科研协调者 | task-cbe26034-a566-4e7a-a2d3-4cb2eadda6c0 | completed |
| 新科研协调者 → 新文献智能体 | task-384fa81c-5024-4e34-9ec0-5c285d814526 | completed |

两个 taskId 均有双方身份的 AMP Access 200，文献返回真实 `web_search` 工具结果。
检查结束无 accepted/working 托管任务，全局策略前后未改变。原始验收记录仅在服务器及本机
`/tmp/research-mtls-99575e2f5090.json`，未提交业务载荷或凭据。

边界：本次没有测试 MQ 业务递归，只确认十二个 MQ Partner 连接就绪；未验证榜单增分，
轮询产生的多条 Access 不能算多次任务。检索结果是工具返回的线索，不等于全文核实。
测试提示要求一次搜索，文献模型实际并行搜索了两次（各返回八条来源），根协调者如实指出偏差；
因此链路与工具可用已确认，但自然语言的单次搜索限制不能当作已被运行时强制执行。

测试：申请阶段的注册与证书相关 **48 项通过**；本轮新增公开版本与退役身份发现回归，完整后端 **336 项通过**。

## 官方依据

[官方注册命令实现](https://github.com/AIP-PUB/ACPs-community/blob/v2.2.0/registry-server/app/agent/service_command.py)
按名称和版本检查重复记录，审批中的记录不应当被重建或覆盖。
证书 SAN 依据见 [此前 mTLS 根因记录](wutong-mtls-repair.md)。
