# 梧桐公开 HTTPS 入口修复交接

**2026-09-29 更新：**用户已明确授权四个科研智能体重新申请，不再以保留原 AIC 作为唯一修复路径。
四个替代身份的 `2.0.0` 申请均已获批并取得正确的两类证书，已在用户明确“授权切换”后启用
8458–8461，四个新入口的公网 TLS 与 RPC 探活均通过。旧记录保留，旧 8443 服务已停用而非删除。
当前进展与操作边界见 [重申请记录](research-reapplication-20260929.md)。下面保留 09-28 的排查证据。

以下为 2026-09-28 的历史实测：当时公开 HTTPS 入站尚未修复，MQ 调用成功不能替代该项验收。

本轮 API 防错修复已发布至 `aegismesh-release-mtls-guard-20260928`，隔离环境完整后端测试 **290 项通过**。发布后 health / 日志中心均为 200，4/4 MQ Partner 就绪，四张原 clientAuth 证书校验通过，兼容模式仍为 false。mTLS 服务未切换，仍在 `observability-20260928`；新入口的严格启动检查尚未用于生产监听。旧 API systemd override 保存在新发布目录的 `api-override-before.conf`，可独立回退，不覆盖数据。

## 已确认的根因

1. 当前 8443 的 `.serverauth.pem` 实际只有 clientAuth EKU；标准 TLS 客户端报 `unsuitable certificate purpose`。
2. 四个 AIC 共用 `aip.demmo.cc.cd:8443`，只有 Leader 证书。URL 路径无法决定 TLS 握手时的证书，其他智能体必然身份不匹配。
3. 2026-09-28 14:57 UTC 经官方 ACME 为文献智能体新签 serverAuth，EKU 已正确，但没有 DNS/IP SAN。原 ACS 无 `certificate` 字段。官方 CA 从 **ACS certificate.altNames** 取主机名，不从 CSR 或 endPoints 推断。
4. 尝试仅给原文献 AIC 补 `certificate.altNames.dns`，官方返回 HTTP 400：`Agents in APPROVED status cannot be updated`。读回仍是原 AIC、APPROVED，资料未变；未删除、取消审核或重新注册。

## 请平台方保留原 AIC 与审核状态修改

所有记录增加：

```json
{"certificate":{"altNames":{"dns":["aip.demmo.cc.cd"]}}}
```

为四个 AIC 分配独立 TLS authority（下面为待协调的端口方案，尚未启用）：

| 本地 ID | 原注册记录 ID | HTTPS RPC 地址 |
| --- | --- | --- |
| research_leader | 01a0c919-7e20-71b5-8a1c-0e17466c4403 | https://aip.demmo.cc.cd:8443/aip/research_leader/rpc |
| docs_overview | 01a0c919-7244-73c6-adaf-5fd2cfbfc794 | https://aip.demmo.cc.cd:8444/aip/docs_overview/rpc |
| empirical_design | 01a0c919-79db-77f8-898c-766ca1dd2993 | https://aip.demmo.cc.cd:8445/aip/empirical_design/rpc |
| peer_review | 01a0c919-7b59-7639-a4a0-84dab0b09024 | https://aip.demmo.cc.cd:8446/aip/peer_review/rpc |

平台若可开放已审核记录的安全更新接口，也可由我们更新。不要删除智能体、重新生成 AIC、降级 TLS 或改成共用 Leader 身份。

`scripts/prepare_mtls_repair.py` 从官方注册详情生成逐项 `before` / `requestedAcs` 文件，只修改 HTTPS 端口和证书 SAN；不发送更新请求、不改变能力/模型/审核状态、不包含凭据。应用前需核对原资料未被其他人更新。

本次导出的完整公开 ACS 对照：[协调智能体](mtls-repair-20260928/research_leader.json)、[文献智能体](mtls-repair-20260928/docs_overview.json)、[研究设计智能体](mtls-repair-20260928/empirical_design.json)、[论文评审智能体](mtls-repair-20260928/peer_review.json)。

## 我方修复与后续切换

- 签发证书在临时目录完成：验证单一 EKU、有效期、CN/URI AIC、私钥匹配、官方信任链、DNS/IP 主机名后才启用。续签复用原私钥；失败不替换正在使用的证书、私钥或信任包。
- ACS 构建补上官方 `certificate.altNames`（锁定的 SDK 模型会丢掉该可选字段，因此显式保留）。
- `AIP_AGENT_PUBLIC_URLS` 支持每智能体独立 HTTPS origin；`AIP_TLS_AGENT_ID` 让监听器选择对应 AIC 的 serverAuth。错误目标路径返回 421，不串用其他 AIC 的证书。
- `scripts/check_aip_tls.py` / 部署检查验证实际证书，不再将“文件存在、进程 active”当作 mTLS 可用。

平台资料更新后：读回 ACS 和原审核状态 → 确認 8444–8446 的主机/云防火墙可达 → 四个 AIC 分别签发 serverAuth → 采用官方双根信任包校验客户端 → 配置独立监听 → 标准 TLS 域名与 AIC 双重验证 → 逐个验证 RPC/发送方身份绑定 → 再让用户从梧桐重试。新签证书即使 EKU 正确但 SAN 缺失，也不得投入使用。

## 官方依据

- [CA 的 SAN 生成逻辑](https://github.com/AIP-PUB/ACPs-community/blob/v2.2.0/ca-server/app/core/ca_manager.py)：SAN 来自 ACS certificate.altNames。
- [注册服务更新限制](https://github.com/AIP-PUB/ACPs-community/blob/v2.2.0/registry-server/app/agent/service.py)：APPROVED/PENDING 不允许客户端更新。
- [梧桐接入说明](https://wt.ioa.pub/docs.html)。公开 OpenAPI 与生产返回确认当前更新仍受此限制。
