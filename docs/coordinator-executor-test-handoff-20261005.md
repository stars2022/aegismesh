# AegisMesh 协调执行联调交接文档

本文交接 2026 年 10 月 5 日用户授权的 100 轮协调与执行智能体联调，供下一位工程师或执行代理接手。目标是让科研协调模型实际调用文献执行模型，再收回结果并汇总，不是分别直调两者，也不是把发送方证书名称当作模型已经执行的证明。

截至北京时间 2026 年 10 月 5 日 16:45，本轮处于**已授权并生成题目计划但尚未执行**的阶段。实际新调用 0 次，未启用临时 service 豁免，批量执行器尚未完成。用户最新要求是整理交接文档，因此本轮只做只读核对，不启动测试。

## 已完成和待完成的工作

| 工作 | 实际状态 | 证据或说明 |
| --- | --- | --- |
| 确认协调者和执行者 | 已完成 | 精确 AIC、角色、服务状态已经核对 |
| 检查服务和遗留任务 | 已完成 | 16:44:55 核对，无活跃任务、预留额度和批次进程 |
| 本轮临时 service 应用额度豁免授权 | 用户已确认 | 用户对具体 100 轮豁免问题回复“好的” |
| 准备 100 道题 | 已完成 | 从两份用户题库筛出，排除历史已尝试文本 |
| 生成不可覆盖的测试计划 | 已完成 | 100 题、26 个批次，首批 1 题 |
| 本轮豁免配置备份和变更审计 | 未执行 | 没有本轮变更，也不存在待恢复的本轮豁免 |
| 批量执行器和证据判定器 | 未完成 | 当前不能直接开始 100 轮 |
| 首轮真实协调与执行验证 | 未执行 | 不引用旧测试作为本轮通过证明 |
| 100 轮结果和内容验收 | 未执行 | 不能报告成功率、实际耗时或完成 100 次 |

较早的 `preflight.json` 写的是等待授权，记录的是用户回复“好的”**之前**的检查。不要把它当作当前仍缺少豁免授权；最新状态见私有 `handoff-state.json`。

## 目标智能体和身份

| 用途 | 本地 ID | 名称 | 角色 | 精确 AIC |
| --- | --- | --- | --- | --- |
| 实际执行协调模型 | `research_leader` | 科研智能体协作工作台 | `leader` | `1.2.156.3088.1.BUPT.L2K8YU.7LFQWP.QT8L11.1BF9` |
| 实际执行文献模型 | `docs_overview` | 文献检索与知识综述智能体 | `partner` | `1.2.156.3088.1.BUPT.L2K8YU.SJKLDA.578Y8P.19DJ` |
| 验收客户端的现有认证身份 | `peer_review` | 论文评审与学术写作智能体 | `partner` | `1.2.156.3088.1.BUPT.L2K8YU.Q8JP6H.1DNDU6.190G` |

前两者分别是已有官方快照中，自有智能体里调用数最高的协调者和被调用数最高的执行者。只按精确 AIC 匹配，不能用同名目录项替换。

计划使用 `peer_review` 的已有客户端证书认证入站测试请求，**不执行它的模型**。这不是另一个智能体模型自主选择科研协调者的证据，也不伪装成账号所有者。科研协调模型真正执行之后，才用自己的身份派发文献任务。两条网络边的调用方不同，统计和审计必须分开。

## 单轮测试链路

下面是待实现并验收的流程，不是本轮已经发生的调用记录。

```text
验收客户端  使用现有 peer_review 客户端证书
    │ 精确 ADP 发现和 HTTPS AIP mTLS 根任务
    ▼
research_leader  实际运行科研协调模型
    │ list_agents 精确发现 docs_overview
    │ dispatch_task 指定该执行者并等待真实结果
    │ 使用 research_leader 的身份走 HTTPS AIP mTLS
    ▼
docs_overview  实际运行文献执行模型和允许的领域工具
    │ 执行回执和结果返回
    ▼
research_leader  收集执行结果并生成最终答复
    │ 根任务完成和 AIP Complete 确认
    ▼
验收客户端  保存证据并判断本轮是否通过
```

每轮新建会话，不沿用前题历史。根任务和子任务保留各自真实 task ID，关联同一个追踪标识。不能把脚本直接调用 `docs_overview` 后再调用一次汇总模型，当作协调模型自主派发。

本轮计划验证 **HTTPS AIP 递归链路**。旧批次覆盖过 MQ，但 MQ Partner 就绪不等于本轮 MQ 递归验收通过；不要混写传输覆盖范围。

## 已确认的实现路径

以下均是当前仓库已有实现，可以复用，不需要为测试关闭认证或新建身份。

1. `backend/app/services/discovery.py` 的 `AdpDiscoveryClient.discover` 支持精确 AIC 过滤；`discovery_pool.py` 把官方目录结果与本地历史评分关联。缓存不是发现服务失败时的替代目录。
2. `backend/app/services/transport.py` 的 `AipSdkTransport.execute` 在 `interop_compatibility=True` 时要求 HTTPS，启用调用方证书、预期目标 AIC 校验，并要求完成确认。测试客户端只发根任务。
3. `backend/app/services/hosted_aip.py` 接收真实入站任务，再进入 `aip_execution.py` 的 `execute_inbound_task`。
4. `InboundAipOrchestrator` 复用正常协调运行时。`orchestrator.py` 的 `_coordination_registry` 注册发现、派发和结果收集工具，`_dispatch_task` 留下派发事件。
5. 入站协调者派发子任务时，`InboundAipOrchestrator._invoke` 使用官方发现提供的 HTTPS AIP 端点，不回退本地模型直调。
6. `HostedTask`、`Invocation`、`TraceEvent`、`ModelUsage` 和 `QuotaEntry` 保存任务、派发、用量和额度收尾证据；AMP 管道只记录实际网络调用。

执行上下文 `aegismesh.aip-execution.v1` 保存调用链、追踪标识、总截止时间及工具预算。当前最大调用链深度为 3。本计划的链是客户端身份、科研协调者、文献执行者，不再允许继续向下派发或回调上游。

`execute_inbound_task` 的隔离标识为：

```text
owner_id = "aip:" + SHA256(目标 AIC + NUL + 已认证调用方 AIC)
session_id = "aip-" + SHA256(目标 AIC + NUL + 调用方 AIC + NUL + wire session) 前 40 位
```

会话标识只用于关联，不授予访问其他账号或其他调用方记录的权限。

## 题目计划和执行预算

私有目录：`var/coord-executor-regression-20261005/`。其中原始题目、结果、配置备份和审计细节不提交到 Git。

`plan.json` 的 SHA-256：

```text
03f6ac845843c2abf2162d915b0d3973ed76f96b45b24069dccba5805a9890e4
```

计划来自：

- `/Users/stars/Downloads/问题列表.md`。
- `/Users/stars/.codex/attachments/a28874c7-711d-40fb-b855-1274fa76bb91/已粘贴的文本.txt`。

筛选后有 118 个未尝试的科研问题，选定 100 个。当前分组是 19 个允许联网检索的问题、64 个需要披露材料缺口的问题、17 个其他非联网问题。题型标签是脚本根据题号预设的，**尚未逐题完成内容审查**，接手者必须复核，不能用标签代替验收。

计划参数：

| 参数 | 当前计划 |
| --- | --- |
| 新尝试总上限 | 100 个，首轮和失败尝试也占上限 |
| 批次数 | 26 个，首批 1 题，其后 24 批各 4 题，最后 3 题 |
| 同时执行 | 串行，一次一轮；不做并发压测 |
| 单题时限 | 180 秒，协调和执行共享总截止时间 |
| 每批时限 | 900 秒，临时豁免也应受此窗口约束 |
| 检索预算 | 每个执行上下文 `web_search <= 1`、`read_web_page <= 2` |
| 非联网题预算 | 两种网络工具预算均为 0 |
| 保守业务窗口 | 2026 年 10 月 5 日北京时间 24:00 前停止新增业务 |

最后一项是准备阶段设定的保守运行边界，不是用户要求的交付时限。若接手时已超出它，先重新确认续跑窗口，不能自行把日期延长或启动旧夜间自动任务。

失败后不自动补发同题、不改身份重试、不追加第 101 题。如果发生失败，保留已尝试数和未执行题数，先解释原因。100 个尝试不保证 100 个通过，更不保证 100 份完整科研成果。

`prepare_plan.py` 会以排他创建方式保存文件，现有计划已经生成，**不要重新执行它**。如未执行前发现题型误分类，创建明确的新计划版本并重新计算摘要，不能覆盖旧证据。

## 用户授权和配额边界

用户已确认本轮 100 次完整链路测试期间临时豁免 **service 角色的应用额度**。开始前不需要再重复询问同一授权，但授权不包含任意生产代码修改、部署、重启服务或供应商上游限额调整。

当前配额策略仍为 `enforce`，service 未豁免。文献执行者接收科研协调者请求的既有服务身份，滚动周用量为 1,177,908 单位，而原周额度为 800,000；每日根任务额度为 20。这解释了为什么需要已授权的临时豁免。单位是应用计量，不是人民币费用。

应用单位公式是输入 Token 加 4 倍输出 Token，缓存命中输入按 2% 计量。模型失败前已经产生的用量不能清零或退回。上游供应商的余额和限流是独立约束，本轮不能绕过。

每批应执行：

1. 确认前批已经结束、额度恢复，无未知活跃任务；确认原策略摘要与计划一致。
2. 保存只含所需策略信息的私有备份，设置文件权限为 `0600`，先回传或确认本地可取回。
3. 原子修改 `roles.service.exempt` 并留下管理员审计，其他角色、全站 `enforce`、供应商输出上限、认证、TLS 和历史用量保持不变。
4. 执行本批已审核题目；原有用量和任务审计照常记录。
5. 在 `finally` 恢复原 service 配置，再核对策略摘要、审计、活跃任务和预留额度，保存恢复回执。

可参考 `var/interop-dual-20260930/quota_control.py` 的私有备份、并发策略保护和原子审计实现，但这是旧辅助脚本，默认说明仍写双传输测试。新执行器需要使用本轮唯一批次标识和准确授权说明，不能调用旧批次主程序或覆盖旧备份。

两项需要特别注意：

- 豁免是**角色级**而不是仅一个测试会话，期间其他 service 请求也可能被豁免。因此应缩短每批窗口，避免与其他服务测试重叠。
- `finally` 无法处理 SIGKILL、主机宕机等情况。执行器尚未实现，必须先补齐异常中断后的恢复检查和恢复入口；不能把“有 finally”当作绝对可靠的回收保证。恢复时若 service 配置已被其他管理员修改，应停止并报告冲突，不覆盖对方配置。

## 接手执行步骤

### 先做只读核对

本地工作区为 `/Users/stars/Documents/ChatGPT/AIC`，服务器为 `zcode@34.150.109.119`。核对脚本不提交业务、不改变配额，不读取或打印凭据。

```bash
cd /Users/stars/Documents/ChatGPT/AIC
/private/tmp/aegismesh-storage-tests.zfQ49q/venv/bin/python \
  var/coord-executor-regression-20261005/inspect_handoff.py --remote
```

上述 Python 是当前本机可用的临时运行环境。接手时若它已被清理，选择可用 Python 环境；该只读脚本只使用标准库。不要把这个 `/private/tmp` 路径当作长期部署依赖。

要保存新快照，给 `--save` 一个**尚不存在**的私有 JSON 文件名；不要覆盖 `handoff-verification.json`。

确认以下条件后才进入业务执行阶段：

- active release 仍是 `/home/zcode/aegismesh-release-accounts-20260930`。
- 主 API、两个目标的 AIP 服务和 Fluent Bit 均为 `active`。
- 两个目标的身份仍精确匹配、已批准、启用、在线且熔断为 `closed`。
- 不存在前批未结束的业务、未知预留额度或尚未恢复的豁免。
- `external_delegation_enabled=true`；入站运行时和官方 SDK 的身份校验不被关闭。
- 正式执行前再用实时 ADP 检查目标的 HTTPS 端点，不能拿本地健康标志替代。

### 完成批量执行器

**当前没有可直接开始批次的命令。** `prepare_plan.py` 只生成计划，`inspect_handoff.py` 只读检查；二者都不是测试执行器。不要因为文件里写了 100 题，就认定 100 轮已经安排或启动。

新执行器至少应满足：

1. 固定计划摘要、唯一批次标识及固定认证身份；使用 `/tmp/aegismesh-dual-batch.lock` 避免与既有批次程序同时运行。
2. 启动时读既有报告，验证前批恢复回执，拒绝重复批次、重复题目、超额尝试和过期执行窗口。
3. 复用官方 ADP 和 `AipSdkTransport`，只提交 `research_leader` 根任务；子调用必须由真实协调运行时发起。
4. 用 `AipExecutionContext` 给根任务和子链传递真实追踪、调用链、截止时间及预算，不只在自然语言里写预算。
5. 保存最初的计划、每题开始记录、真实回执、失败信息、模型用量和结束记录；中断后可以只读恢复状态，不能盲目重发。
6. 对超时和取消尝试回收远端本轮子树；对收尾失败停止新增任务，不掩盖残留工作。
7. 私有备份、管理员审计、每批限时、正常恢复和异常恢复均验证过以后，才第一次启用豁免。

指定一次派发和固定 `docs_overview` 应明确写入测试要求。但当前 wire `tool_limits` 只提供检索和网页读取预算，**不提供 allowed AIC 白名单或每题一次派发字段**。自然语言要求不能当作硬权限边界；接手者必须核实限制方案，并对任何额外派发立即停止和记录。若需要新增生产侧限制字段或部署代码，这是另外的实施范围，需要用户另行授权。

### 首轮通过后再分批继续

首批只执行 case 1，核验下一节的完整证据，不要一口气派发 100 个请求。首轮有任一失败、没有真实子调用、使用了额外智能体或结果无法关联，就不继续第二批。

首轮通过以后，每次只执行计划内一个小批次。每批结束先恢复 service 额度、保存本地证据和验收状态，再决定是否开始下一批。不要启动旧排行追分程序、旧自动任务或长期驻留循环；本轮不需要新增 cron。

## 每轮需要保存和判定的证据

接手实现时，每条结果至少应记录以下字段。它们是待实现的报告契约，不代表目前已有完整报告。

| 分类 | 必需内容 |
| --- | --- |
| 题目身份 | `case_id`、原始问题、题库摘要、来源键 |
| 会话和时限 | 独立 wire session、trace ID、开始结束时间、耗时、实际传出的工具预算 |
| 根任务 | 真实 task ID、目标 `research_leader`、已认证客户端 AIC、最终 Complete 状态 |
| 根模型 | Invocation ID、真实 LLM 用量、发现及派发工具记录 |
| 子任务 | 真实 task ID、caller 为科研 AIC、callee 为文献 AIC、实际 HTTPS 传输、完成确认 |
| 子模型 | Invocation ID、真实模型用量、实际工具轨迹、结果或明确材料缺口 |
| 协调汇总 | 派发完成事件、结果已收集、最终回答、没有额外分支或改派 |
| 配额收尾 | 原策略摘要、私有备份位置、启用和恢复审计、恢复结果、无残留预留 |

数据关联建议：

- 先用根 wire session 和 `HostedTask.external_task_id` 找到根托管记录。
- 从 `HostedTask.result_data.invocation_id` 关联 `Invocation`，不要用模糊标题关联其他会话。
- 核对根 `TraceEvent` 的 `DISPATCH_STARTED`、`DISPATCH_COMPLETED`，caller 必须是 `research_leader`，目标必须是 `docs_overview`。
- 检查根 `result_data.collaborations` 中对应分支的状态、结果和 `result_collected`；缺少收集证据不能仅凭子任务 completed 就算整轮完成。
- 检查子托管记录的已认证 `owner_peer_aic` 是科研 AIC，以及实际传输回执的调用链。追踪不足时停止并解释缺失，不补造日志。
- 保存最终回答和可审阅工具证据，但删除 `reasoning_content`、`chain_of_thought` 等模型私有推理字段；不保存密钥、Cookie 或私钥。

每题应分别给出 `workflow_status` 和 `content_status`。完整派发回收只证明流程成功；检索题还需要可追溯来源、正确日期和来源支持。缺论文或数据的题，正确披露材料缺口可以算对应负面输入行为通过，但不能描述为已完成论文分析。没有查到资料不能证明事件不存在。

## 必须停止的情况

发生下面任一情况，停止新增业务，保留失败题和剩余题，不自动补跑：

- HTTP 402、429、上游余额不足或限流；不能切换身份、重置用量或调整上游限制来继续。
- TLS、证书、调用方或目标 AIC 校验失败；不能关闭校验或改为 HTTP。
- ADP 未返回精确可用目标、熔断为 `open` 或 `half-open`，或者任务仍在途。
- 数据库锁、事务恢复错误、磁盘余量不足、任务或配额无法可靠收尾。
- 根模型没有派发文献任务、额外派发、自动改派、循环或未授权第三方调用。
- 结果被错误绑定到其他会话、缺少实际执行回执、发现伪造引用或把历史事实冒充当前事实。
- 豁免恢复失败、策略发生并发变更、既有失败原因尚未解释。

服务异常定位时先只读检查，不在联调脚本中部署或重启。已有存储故障修复不能被测试脚本偷偷扩展为新维修范围。

## 平台统计和测试结果分开

官方统计读取入口是 `https://wt.ioa.pub/internal/matched-stats/top`。现有只读辅助脚本在 `var/quality-regression-20261002/capture_official.py`。

比较时保留同一累计起点 `2026-09-24T00:00:00+08:00`，结束点取当前北京时间下一个整点，单位为 `task`；同时保存 `meta`、当前小时是否开放及缺失小时。`caller`、`callee`、`callerNonInternal`、`calleeNonInternal` 是不同榜单，不能混用。

本轮需要关注的是**科研 AIC 调用文献 AIC 的真实子链路**。入站测试客户端的调用数、根协调者的被调用数是另外的统计；同一轮可能有多条网络边，不存在“100 轮必定让两张榜各增加 100”的保证。

多条 Start、Get、Complete、Access 或 Message 日志不是多个独立题目。日志可验证本地调用关系，但只有官方快照能说明平台显示的计数。分类规则由平台决定，本轮不改身份或记录来影响“内部/非内部”分类，也不以达到某个排名作为验收通过条件。

## 当前环境和恢复资料

16:44:55 的只读检查确认：

- 运行目录：`/home/zcode/aegismesh-release-accounts-20260930`。
- 真实数据库：`/home/zcode/aegismesh/backend/data/aegismesh.db`，SQLite WAL。
- 主 API、科研 AIP、文献 AIP、Fluent Bit 四项检查均为 `active`；未据此重新宣称其他全部服务都已检查。
- 两个目标和客户端身份均已批准、在线、熔断 closed，负载为 0。
- 本轮 HostedTask、豁免审计、服务器报告均不存在；无匹配批次进程，无活跃业务或预留额度。
- 全局 `enforce` 保留、service 未豁免，策略摘要与准备阶段相同。
- 磁盘剩余 2,268,475,392 字节，约 2.11 GiB。

公网健康检查有一个尚未定位的来源差异：本机工作区访问 `https://demmo.cc.cd/api/health` 返回 200；服务器访问同一公网地址返回 403，服务器 loopback 后端检查返回 200。不能只凭 403 判断后端崩溃，也不能宣称公网所有来源可达。开始业务前应检查本次真实 ADP 和 AIP 路径；本轮没有改 WAF、认证或 TLS。

最近的存储和日志修复提交为 `ad0ad17`，部署前有已回传本地并离线恢复验证过的备份。185 项修复相关回归测试通过，**这些不是本轮 100 次真实业务测试**。

恢复资料：

- 本地备份：`var/disk-cleanup-20261005/pre-fix-backup/pre-accounts-20261005T050644Z.tar.gz`。
- 备份 SHA-256：`7a1ec328ad2bf64250967105d57b9dba53a60887019ee477bc61820a6063aa67`。
- 修复部署回滚源：`/home/zcode/aegismesh-release-accounts-20260930/deployment-backup/storage-recovery-20261005T052041Z`。
- 本地校验记录：`var/disk-cleanup-20261005/repair-validation.json`、`backup-verification.json`、`deployment-result.json`。

普通配额恢复只需要恢复本批服务角色字段，不是恢复整库。不要在生产内存中展开大备份，不要以旧数据库覆盖新任务、账号或审计记录。

## 交接文件索引

| 文件 | 用途 |
| --- | --- |
| `var/coord-executor-regression-20261005/plan.json` | 固定 100 题、身份、预算和分批计划 |
| `var/coord-executor-regression-20261005/handoff-state.json` | 用户已授权、实际未启动的当前状态 |
| `var/coord-executor-regression-20261005/handoff-verification.json` | 最新只读服务、任务、策略和额度检查 |
| `var/coord-executor-regression-20261005/historical-questions.json` | 历史题目及准备时状态，不是本轮结果 |
| `var/coord-executor-regression-20261005/question-exclusions.json` | 82 条历史文本排除记录 |
| `var/coord-executor-regression-20261005/preflight.json` | 用户授权之前的配额阻断快照，保留不覆盖 |
| `var/coord-executor-regression-20261005/official-baseline.json` | 较早官方统计快照，不能当作最新完成证明 |
| `var/coord-executor-regression-20261005/prepare_plan.py` | 已运行的计划准备器，不是执行器，不重跑 |
| `var/coord-executor-regression-20261005/inspect_handoff.py` | 可重复执行的只读状态核对器 |
| `docs/research-reapplication-20260929.md` | 旧版真实协调派发成功的历史依据 |
| `docs/recursive-interop-check-20260929.md` | 递归、数据库锁和传输边界的历史经验 |

私有目录已被 Git 忽略，交给另一台机器或另一位执行者时，需要安全传递所需计划和证据，不能只交这份 Markdown 就假定对方拥有原始文件。凭据和证书仍留在服务器，文档不携带密钥。

接手后最先做三件事：重新只读核对，审阅 100 题和固定目标限制，完成有可靠额度收尾的执行器。随后先验证一轮，再分批继续；目前没有可继续等待的在途测试。
