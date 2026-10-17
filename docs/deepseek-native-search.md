# DeepSeek 原生搜索与抓取（2026-10-17）

## 启用与兼容

管理后台 → 模型供应商 → 联网搜索，选择「DeepSeek Search / Fetch」，绑定现有的官方 DeepSeek 搜索供应商，再测试并保存。API 设置值为 `deepseek_native`。

这是一项显式付费选项。升级不改数据库内的 `legacy`、`deepseek`、`exa`、`disabled` 选择，不改推理模型、智能体身份、账号或角色。当前线上使用的 `deepseek` 仍为原兼容接口；本地实现完成不代表已部署或已切换线上服务。

原生模式固定向 `https://api.deepseek.com/v1/tools/search`、`/v1/tools/fetch` 发送 Bearer 鉴权，不能把推理供应商或任意 URL 当作搜索端点。禁止重定向、隐式重试和环境代理。搜索不再需要另发一轮模型推理。

## 请求及证据

- Search：查询不超过 128 个 Unicode 字符，超长提示缩短，不自动拆成多个付费请求。只传 query、count、need_content，不传用户 IP 或完整会话。
- 按 `results` 解析链接、标题、摘要和可用日期；摘要仍是 `search_excerpt`，不是已读取原文。空结果是有效结果，不补造资料。
- Fetch：仍只能读取当前执行分支搜索命中的公开来源。沿用 URL/公共 DNS 检查、最多两页、长度限制及不可信内容边界。结果是有限的 `page_excerpt`，不能声称全文或事实已核验。
- 原有 Exa 和兼容模式仍用原来的网页读取方式，不会因失败自动切换到收费 Fetch，也不会自动切换供应商。
- 兼容模式单次工具调用的 `max_uses` 从 5 收紧为 1；工具错误不再当作正常空搜索结果。

## 计费、审计与保护

截至 2026-10-17，官方中文文档参考价为 Search、Fetch 各 ¥5/千次成功且有结果的请求。Search 的非空 results、Fetch 的非空正文才满足该条件；不能把兼容工具的优惠期套用到原生接口。[官方 Search/Fetch 指南](https://api-docs.deepseek.com/zh-cn/guides/search/)

- 每个原生请求先在 `operational_logs` 创建 `kind=audit`、`action=deepseek_tool_request` 预留，提交成功后才发网络请求；不向 AMP 上报虚构任务或调用。审计不可用则不发送。
- 审计关联服务端可信 owner、session、invocation 和供应商 ID，不记录查询词、目标 URL、正文、密钥或认证头。后台直接测试标记为 `admin:search-test`。
- 已知失败/空结果记为不计费；网络中断、取消、超大或格式错误响应记为结果未知，保留参考费用估算，不谎称免费。上游实际账单仍是最终依据。
- 原生请求用量独立于 token 用量：`llm_calls=0`，另含 `search_requests`/`fetch_requests`、可确认的计费请求数和 `estimated_cost_cny_micros`。5,000 微元代表参考费用 ¥0.005，不是伪造 token 消耗。
- 缓存命中全部用量归零，不重复发送或重复计费；搜索工具次数和每分支原文读取次数继续生效。
- `DEEPSEEK_TOOLS_DAILY_LIMIT` 默认 1,000，Search + Fetch 共用，以 UTC 日切分，失败/未知也消耗请求保护次数；这是全站成本保护，不改变用户角色或现有模型配额。管理员可在私有环境中调整。
- 每种原生操作各限每秒 5 次，跨 API/mTLS 进程、跨供应商/API Key 共用保守保护桶。不同供应商 ID 可能属于同一上游账号，不拿换密钥当成扩容。平台其他客户端的流量仍可能触发上游限流。
- 预留通过数据库写锁串行化，网络期间不持锁；402/429/5xx 不自动补发。429 如实提示账号级限制。请求保护不是对上游价格不变的承诺。

这次未把按次费用折算成 token 角色配额；模型用量规则维持原样，原生工具由独立的请求上限和审计保护。原兼容接口的上游搜索费用不能据模型 token 推断；切换计费口径前应核对供应商账单。

## 验证

`backend/tests/test_deepseek_native_tools.py` 用 MockTransport 验证真实请求形状、官方端点绑定、缓存、分支隔离、审计归属、空结果、失败/取消/未知计费、无重试、全站每日保护、跨 Key 限速和管理员草稿测试不保存。

`frontend/tests/web-search-settings.html?backend=deepseek_native` 是完全隔离的设置预览；测试按钮仅返回样例数据，不调用付费 API。

本地回归不使用线上密钥或生产数据库；实际联网请求须单独核对结果，不将模拟测试称为生产验收。

此次验收：663 项后端、114 项前端测试通过，TypeScript/Vite 生产构建通过；设置预览验证浅色/窄屏与按次费用展示。依赖在非 iCloud 的临时目录重建，Python 核心依赖版本按线上读取结果固定，现有工作区依赖未替换。没有部署、重启线上服务或开启原生付费模式。
