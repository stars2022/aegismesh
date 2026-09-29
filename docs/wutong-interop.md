# 梧桐互联接入与发布

官方说明：https://wt.ioa.pub/docs.html 。以下接入参数于 2026-09-28 从部署服务器实测。

## 传输与对账

- MQ：`wt.ioa.pub:5671`，vhost `acps`，AMQPS + EXTERNAL；每个智能体使用自己的 clientAuth 证书，禁止 guest/password、关闭 TLS 校验或伪造发送方 AIC。
- 群组授权：`https://wt.ioa.pub:9007`。官方 SDK GroupLeader 负责 ACL、邀请、任务和完成握手；GroupPartner 接收认证的群组任务。
- CA：`https://wt.ioa.pub/ca-server/acps-atr-v2/ca/trust-bundle`，目前两张根证书。已审核 AIC 不需要重新注册。
- Access：发送和接收方各记真实日志，`correlation_id = taskId`；Message：SDK 记录 send/receive/ack，相同消息使用相同 messageId。SDK NDJSON 信封字段使用 snake_case。
- 这不是把业务协调器移到梧桐运行：协调逻辑仍由 AegisMesh 执行，互联边通过官方协议和基础设施传输、产生可核对的日志。用户直接请求协调智能体不伪装成智能体自调用。

管理后台「路由策略 → 故障策略 → 梧桐兼容模式」控制 `RoutingPolicy.interop_compatibility`，初始关闭。打开后，已注册托管智能体之间走真实 MQ，外部智能体走身份绑定的 HTTPS AIP RPC，并要求完成握手。连接失败不回退直调。未注册的 `local:` 身份不能作为兼容调用的发送方。

本机调用的工具/画布上下文通过进程内绑定保留，只有认证 MQ Start 到达后才执行；结果通过 MQ 回传。**API 必须单 worker**，mTLS 进程使用 `python -m scripts.serve`，该入口禁用重复 MQ 收件箱监听。多进程或多副本前须将绑定与唯一收件箱管理改成共享运行时。

### 外部协调权限与工具（2026-09-29 修复）

后台同一区域新增「允许外部协调任务调用子智能体」(`external_delegation_enabled`)。
默认关闭，保存后对新入站任务生效；仅控制外部 AIP 请求，不关闭普通聊天的协调能力。
打开后协调型智能体获得 `list_agents` / `dispatch_task`；执行型不因此获得派发权限。
`web_search` 按已有模型服务及智能体工具配置注册，与该权限开关独立。
子任务候选来自实时 ADP；每个跨智能体调用使用发送方真实证书和官方 HTTPS AIP，失败不回退本地模型。
TLS worker 不再错误依赖另一进程的 MQ 内存绑定；正常页面的兼容模式仍保留原 MQ/本地分流逻辑。

入站任务复用完整工具运行时。调用链最多三级，继承根任务绝对截止时间（默认 600 秒），禁止回调上游；
每层最多八次派发，仍受全链路总时限约束。会话按认证调用方与目标 AIC 隔离。
RPC Start 立即返回 Accepted，调用方轮询至 AwaitingCompletion 后发 Complete；避免 SDK 单次 HTTP 30 秒超时。
取消/超时尝试取消远端子任务，关闭后台进程时回收任务。原始 `declared_tools` 只代表声明，验收需检查真实工具执行记录。

## 定向发现、调用与画布

- `list_agents` 与 `POST /api/discovery/search` 支持 `aic`、`name`、`exact_name`、`endpoint_url`、`query`、`limit`；工具另有 `scope`。结构化条件通过官方 ADP `filtered` 请求提交，多个条件按 AND 组合。名称默认包含匹配，AIC/端点精确匹配；不会直接访问用户随意提供的 URL。
- 工具返回候选的 `agent_id`、AIC、端点、路由排名与可用性。指定目标限制搜索集合，任务关键词仍用于质量评分；不会因为另一个候选分数高就替换用户指定对象。同名必须消歧，离线/停用目标不能绕过资格检查，目录故障不会伪装成“未找到”。
- 发现候选始终来自 ADP；按 AIC 关联本地成功/失败次数、延迟、反馈、负载与熔断状态，再由本地质量路由器排名。本地记录不是另一套候选目录，未被本次 ADP 返回的记录不会混入结果。无历史记录使用明确标注的先验，不伪造成功率。这是本方路由评分，不是梧桐官方榜单分数。
- `list_agents` 的 `local` 范围只是过滤 ADP 返回的本机托管成员，也会查询发现服务。`dispatch_task` 无指定对象时搜索 ADP 后评分，有指定缓存 ID 时解析 AIC 并重新查 ADP；目录失败不回退旧列表。普通会话入口的内部路由和显式直达入口保持原有行为，兼容模式只改变实际调用传输。
- 全网发现页搜索词交给 ADP，不再只筛初始列表。展示缓存按查询词和数量分组，最多保存 32 组、每组 60 秒；每次展示重新关联本地评分，刷新失败明确报错。真实发现/派发不使用展示缓存。新外部候选在首次被派发时保存本地记录，后续调用和反馈累计到同一 AIC；刷新公开能力信息不会重置评分依据、本地停用设置或熔断状态。
- `dispatch_task.agent` 接受返回的 `agent_id`、AIC、准确名称或已知 AIP HTTPS 地址。普通模式中托管智能体继续直调；兼容模式中直接选择一个已注册 Partner 也经平台 Leader → MQ → Partner 执行，不仅限于协调器子任务。Leader 自己的模型推理不制造互联自调用。
- 直接选择外部智能体和协调器派发外部子任务共用画布接入：发送版本化快照，接收约定 JSON 编辑指令，逐条应用并通知前端。只返回说明文字记为 `no_operations`，不把整段答复强行写入画布。非追加编辑必须带正确基准版本；被截断的快照禁止整篇覆盖；远端执行期间若用户保存手工修改，旧版本修改会被拒绝并明确报告冲突。
- MQ 建组/执行/完成握手以及外部 AIP 的完整任务，使用当前任务剩余的总时间预算，不把短暂的 `request_timeout_seconds` 当作整条链路总时限。现网曾因该值为 2 秒而在 MQ 执行前取消；修复不改写用户保存的路由配置，过期任务不会启动新调用。

### 2026-09-28 第三方实测

使用独立数据库与日志目录，未提供真实用户画布内容：

- 官方 ADP 按本方 AIC 精确搜索、按“文献”搜索均返回匹配记录。
- “智能体互联协作枢纽”（`meshlattice.com/rpc`）完成真实 AIP RPC 调用与兼容握手。但返回文字报告、未返回请求的画布编辑指令，因此不能把它记为第三方画布编辑成功。
- “学术文献检索智能体”的目录 AIC 与服务端证书 AIC 不一致，普通/兼容调用均被身份校验拒绝；未关闭校验绕过。
- “校园学习与事务协同智能体”的目录端点接受自定义 `clientRequestId` 请求，标准 AIP JSON-RPC 返回 HTTP 422。这是目标接口契约不匹配，发现成功并不代表可调用。

2026-09-28 进一步实测确认：8443 文件虽命名为 `serverauth.pem`，实际 EKU 是 clientAuth；并且所有托管 AIC 共用 Leader 证书。原“serverAuth 身份”描述不成立，公开 HTTPS 入口尚不可用。新签 serverAuth 用途正确，但原 ACS 未声明 `certificate.altNames.dns`，所以新证书仍缺 DNS SAN。官方接口拒绝更新 APPROVED 记录，须平台方保留 AIC/审核状态补齐注册资料。详见 [mTLS 修复交接](wutong-mtls-repair.md)。每智能体 MQ 身份不受该 HTTPS 入口问题影响。

### 2026-09-28 发现助手提审错误修复

生产记录中的失败为注册服务 HTTP 400：`endPoint must use mutualTLS security scheme`，并非网关不可达。托管发现助手的出站安全偏好为空，旧 ACS 构建据此遗漏了实际共享入站监听器已要求的 mTLS；旧错误处理又统一转成了 502。

- 已配置身份绑定、HTTPS、服务端证书/私钥、客户端信任包和 TLS 端口的托管端点，会按实际监听配置声明 `mutualTLS`。外部端点不据此继承本机安全声明，也没有关闭证书校验。
- 写入注册草稿前验证公开 HTTPS RPC 和 mTLS 声明；400/422 返回本地 422，409 保留冲突语义，超时返回 504，认证/限流及网络不可达明确报告服务不可用。失败仍保存已有草稿编号，预览窗口保留具体错误，便于同步状态后重试。
- 发现助手能力描述以 ADP 为发现来源，本地只补充历史评分和缓存，不再描述成独立候选目录。
- 本地完整后端 254 项、前端 48 项测试通过；该修复尚未发布，上传到现有部署服务器需要用户确认。未代用户创建草稿或重新提交审核。

### 生产验收

当前后端版本：`aegismesh-release-discovery-score-20260928`；前端版本 `discovery-score-20260928`。完整后端测试 243 项、前端测试 48 项通过，前端构建通过。下述 MQ/画布调用验收在前一版 `targeted-v2` 完成，本轮仅作只读发现验收，不额外发起计分任务。

- 发现验收：本方 `docs_overview` 精确 ADP 搜索结果与本地 34 次调用（28 成功、6 失败）关联一致，刷新未清空历史。
- 外部 `1.2.156.3088.1.BUPT.I9JB16.8DQ4FF.MUGCT4.18IY` 精确搜索仅返回该目标；发现页首次 fresh、同查询再次 cached，无本地调用历史时使用先验。
- 发布后 4/4 MQ Partner 就绪，`interop_compatibility=false` 保持不变。前端回滚版本 `rollback-20260928-110448`；前一后端 release 保留。

- 普通模式：`inv-c48f6118190c`，直接选择 `docs_overview`，本地模型执行、测试画布追加成功。
- 兼容模式：`inv-b34ff4647757`，同一目标经真实官方 MQ 执行、测试画布追加成功；`task-eb7854170e6c466a97bad615223fcd12` 对应双方各 1 条 Access，共 18 条 Message、6 个 messageId。
- 测试结束恢复 `interop_compatibility=false`，保留原请求超时配置；4/4 Partner 就绪。测试使用独立新会话，未更改已有用户画布。
- 这两次生产验收是真实任务，日志经过现有生产转发管道；上述记录数量只证明本方两端日志对应，仍不是官方接收或榜单计分证明。

同一个 AIC 同时担任 Leader/Partner 时，使用单一认证 inbox 消费者，将邀请和邀请错误交给 SDK；否则 SDK 两个消费者会竞争同一个队列。该适配依赖锁定 SDK 的内部接口，升级 SDK 前必须重跑群组集成测试。

## 部署

当前生产已使用八个独立 `aegismesh-aip-agent@<id>` TLS worker。下述通用
`promote-release.sh` 只支持原 API + 单 TLS 布局，**不能直接用来完整升级当前生产**。
2026-09-29 递归工具版本逐一验证八个 serverAuth 身份后，备份 DB/override，切换 API 与
专用监听模板；旧 8443 入口保留原版本，未绕过其证书问题。所有 worker 启动前应一次性完成
新增策略字段迁移，避免多进程同时 ALTER。具体版本与回滚位置见递归验收记录。

旧 `scripts/deploy.sh` 是首次安装脚本，会重建 Nginx/systemd，不能用于已部署站点。现在默认只审计；`--bootstrap` 也拒绝覆盖已有服务。

1. 构建、测试后准备一个新的完整 release 目录，保留已有 `.env`，共享原 `backend/data` 和 `logs`；不要覆盖生产目录或证书。
2. 在新 release 中运行 `PYTHONPATH=backend .venv/bin/python scripts/configure-interop.py`。默认只验证所有已审核托管身份的证书、MQ 登录和 mq-auth，不发送任务。
3. 验证成功再加 `--apply`：备份 `.env`，保存独立的官方信任包并开启 Partner；不会修改 DB 兼容模式开关。
4. `bash scripts/promote-release.sh --apply` 切换 API/mTLS。该脚本备份 DB 与原 override，拒绝在活动任务期间发布，健康检查失败自动恢复服务配置。DB 仅增加兼容模式字段，回滚不覆盖业务数据。
5. 使用 `scripts/ui-release.sh save <版本> frontend/dist` 和 `switch <版本>` 发布前端；保留输出中的 rollback 版本。不要运行旧脚本覆盖 Nginx。
6. 检查 API 日志中所有已审核身份出现 `group_partner_ready`，或使用管理员会话访问 `GET /api/interop/status`，要求 `ready=true`、`ready_partners=expected_partners`，再通过后台打开兼容模式。

ACS 公共响应会公布 MQ inbox，但 Registry 的已审核记录未重新提交，避免触发重审；如需更新目录内缓存 ACS，先确认平台支持不重审更新。当前 RPC URL 获取到的 ACS 包含新能力。

## AMP 转发边界

官方说明要求 Kafka/TLS `wt.ioa.pub:19092`，但本次服务器实测 TLS 握手为 EOF；现有 Fluent Bit 配置为 PLAINTEXT。本次没有降级 TLS，也没有重写现有转发配置。**不能把本地日志匹配或 forwarder active 当成官方计分成功**，需要平台确认 TLS 接入参数并通过 Monitor 账号核验接收/榜单。

旧 `setup_fluentbit.sh` 还有 `/tmp` 游标目录、旧环境变量名和无 TLS 参数的问题，不应在现网直接重跑。迁移需保留现有游标以免历史任务重复上报，并在明确 TLS 配置后单独完成。

早期隔离集成测试使用独立 SQLite 快照与独立日志目录，未将其验证任务转发到计分管道；生产验收另见上节。
