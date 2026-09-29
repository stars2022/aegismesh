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

运行中的 Agent 行、环境变量、在用证书与服务未切换。旧 8443 的证书问题因此仍存在；
“新身份及证书已就绪”不等于“旧入口已修复”。原 MQ 与旅行/新闻 8450–8457 服务保持运行。

## 可恢复执行与后续切换

使用 `scripts/reapply_research_agents.py`，不要执行早期的 `scripts/reapply_agents.py`。
新脚本固定仅处理上述四个 ID，按名称、版本及 ACS 恢复已创建草稿，在提交之前落盘新记录 ID，
进程锁避免并发重复申请。PENDING/APPROVED 不再次提交；REJECTED 需先人工检查。

生产检查点（仅服务器，权限 0600）：
`/home/zcode/aegismesh/backend/data/research-reapplication-20260929.json`。
包含原公开 ACS 快照、新 ACS、新旧注册对应关系及审核状态，不包含密码、EAB 或私钥。
当前代码目录是 `/home/zcode/aegismesh-release-recursive-tools-v2-20260929`。
执行时需加载该目录的 `public-aip.env`，并使用现有服务器环境配置。

```sh
PYTHONPATH=backend /home/zcode/aegismesh/.venv/bin/python -m scripts.reapply_research_agents \
  --state /home/zcode/aegismesh/backend/data/research-reapplication-20260929.json --sync
```

只有官方 APPROVED 后才可 `--certificates`，分别签发并验证 clientAuth / serverAuth：
AIC、EKU、私钥匹配、信任链与 DNS SAN 必须同时通过。此命令仍不会自动启用身份。

端口分配完成，但正式切换还需要云防火墙放行 TCP **8458–8461**。临时标记探针已确认四个端口
可在服务器本机监听、读回；主机 iptables 策略为 ACCEPT。公网收到的响应未通过验证，不能以
TCP connect 成功替代真实收包，更不能以它证明 TLS 可用。临时探针自动退出，不作为业务入口。

正式切换前应：核对审批结果 → 验证两类证书 → 通过隔离的预检监听从公网严格验证主机名和每个新 AIC。
随后在没有活跃任务时备份数据库及配置，保留原历史对应关系，协调切换本地注册绑定、Leader 配置、
每智能体独立 origin 与四个独立 TLS worker。再次验证真实 RPC、MQ Partner 和 AMP 上报身份，
最后执行有限的真实协作验证。独立 worker 会从数据库读取 AIC，不能只改端口而仍绑定旧身份；
不得在新证书和公网端口验证前停止旧服务。

测试：15 项重申请流程测试；连同现有注册与证书测试共 **48 项通过**；完整后端 **334 项通过**。

## 官方依据

[官方注册命令实现](https://github.com/AIP-PUB/ACPs-community/blob/v2.2.0/registry-server/app/agent/service_command.py)
按名称和版本检查重复记录，审批中的记录不应当被重建或覆盖。
证书 SAN 依据见 [此前 mTLS 根因记录](wutong-mtls-repair.md)。
