// Offline fixtures only. No production identities, credentials, records or traffic.
export const STORE_KEY = 'aegismesh-recording:production-ui:v2'
export const OWNER = 'account_demo_owner'
export const clone = value => structuredClone(value)
export const stamp = () => new Date().toISOString()
export const OUTPUT_SCHEMA = {
  type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } }, sources: { type: 'array', items: { type: 'string' } } },
  required: ['title', 'summary', 'findings', 'sources'], additionalProperties: false,
}
export function agent(id, name, role = 'partner', extra = {}) {
  return { id, name, role, aic: `1.2.156.3088.1.DEMO.${id.replaceAll('_', '.').toUpperCase()}.0001`,
    description: role === 'leader' ? '规划任务、发现合适的执行智能体，汇总证据与结果。' : '执行专业任务，返回可追溯的资料、结论和待确认事项。',
    system_prompt: '明确输入与交付边界，保留证据来源和不确定项；先执行专业任务，再返回结构化结论。',
    endpoint_url: `https://agents.demo.invalid/${id}/rpc`, transport: 'provider', usage_mode: 'both',
    streaming_enabled: true, notification_enabled: true, group_enabled: false,
    active: true, health: 'online', input_modes: ['text/plain', 'application/json'], output_modes: ['text/markdown', 'application/json'],
    structured_io_enabled: true, input_schema: null, output_schema: OUTPUT_SCHEMA, security_schemes: ['mtls'],
    skills: [{ id: id + '-skill', name: role === 'leader' ? '任务规划与协作' : name, description: '整理相关资料，核对证据与约束并形成可用结论。',
      version: '1.0.0', tags: ['研究', '协作'], examples: ['整理主题资料，给出证据与研究提纲。'], input_modes: ['text/plain'], output_modes: ['text/markdown'] }],
    tools: role === 'leader' ? ['list_agents', 'dispatch_task', 'check_subagent_status'] : ['web_search', 'read_web_page', 'current_time'],
    model_provider: 'demo-deepseek', model_name: 'deepseek-chat', estimated_cost_per_1k: 0,
    avg_latency_ms: 4280, success_count: 0, failure_count: 0, feedback_positive_count: 0, feedback_negative_count: 0,
    request_count: 0, active_tasks: 0, queued_tasks: 0, circuit_state: 'closed', consecutive_failures: 0,
    circuit_open_until: null, registration_status: 'approved', registration_agent_id: `demo-reg-${id}`,
    registration_message: '', registration_synced_at: stamp(), eab_key_id: '', eab_expires_at: null,
    certificate_issued_at: stamp(), updated_at: stamp(), ...extra }
}
export const SEED_AGENTS = [
  agent('research_leader', '科研智能体协作工作台', 'leader'),
  agent('docs_overview', '文献检索与知识综述智能体'),
  agent('peer_review', '研究方法与同行评审智能体'),
  agent('news_verification', '新闻检索与事实核验智能体'),
  agent('travel_logistics', '行程规划与出行服务智能体'),
]
export const PROVIDERS = [{ id: 'demo-deepseek', name: 'DeepSeek', kind: 'openai-chat',
  base_url: 'https://model.demo.invalid/v1', api_key_env: '', default_model: 'deepseek-chat',
  active: true, key_configured: true, updated_at: stamp() }]
export const CATALOG = [
  agent('policy_research', '政策检索与分析智能体', 'partner', { transport: 'aip-rpc', registration_status: 'imported', description: '汇集政策原文，提取适用范围、实施时间和关键条款。' }),
  agent('data_analyst', '数据分析与统计智能体', 'partner', { transport: 'aip-rpc', registration_status: 'imported', description: '整理数据、核查统计口径并输出对照表。' }),
  agent('academic_translation', '学术翻译与术语校对智能体', 'partner', { transport: 'aip-rpc', registration_status: 'imported', description: '对齐学术术语，整理中英双语摘要。' }),
].map(a => ({ ...a, alive: true, streaming: true, notification: true, group: false,
  capabilities: { streaming: true, notification: true, messageQueue: [] },
  endPoints: [{ url: a.endpoint_url, transport: 'JSONRPC' }], securitySchemes: { mtls: { type: 'mutualTLS' } } }))
export const SCENARIOS = {
  policy: {
    question: '请整理新能源政策研究报告的核心问题、适用范围和证据清单。',
    title: '新能源政策研究工作清单', workers: ['docs_overview', 'peer_review'],
    tasks: ['整理政策条款、适用主体与实施时间。', '核对原始条文、证据口径与适用边界。'],
    reports: ['建议先明确研究对象、政策层级、适用地区及时间范围，再按支持措施、准入条件和实施责任进行归档。', '证据清单应包含发布机关、原文链接、发布日期、实施日期、关键条款和解释边界；不以新闻摘要代替政策原文。'],
    answer: `## 新能源政策研究工作清单\n\n### 研究范围\n先明确研究对象、适用地区、政策层级与时间范围，分别梳理支持措施、准入条件和实施责任。\n\n| 核心问题 | 核查材料 | 交付字段 |\n| --- | --- | --- |\n| 谁可以适用 | 政策原文与实施细则 | 适用主体、地区、期限 |\n| 支持哪些活动 | 条款与配套通知 | 支持措施、条件、排除项 |\n| 如何申请或落实 | 主管部门流程 | 受理主体、材料与时间点 |\n\n### 证据清单\n- 发布机关与文件名称。\n- 发布日期、实施日期与有效期。\n- 原始条文、对应页码或条款号。\n- 实施细则、解释口径与待确认项。\n\n### 报告结构\n**政策背景 → 适用范围 → 措施对照 → 执行约束 → 证据附录**。研究结论应标明适用边界，不把政策目标写成已经实现的效果。`,
  },
  research: {
    question: '围绕大模型多智能体协作，梳理主要协调机制、证据来源与研究空白，给出一份可用于组会的综述提纲。',
    title: '大模型多智能体协作研究综述', workers: ['docs_overview', 'peer_review'],
    tasks: ['整理协作机制、代表性研究和证据卡，形成综述提纲。', '检查研究设计、评价口径与结论边界，提出可验证的研究问题。'],
    reports: ['已完成角色分工、通信协议、任务调度与评价方法四个维度的材料整理。集中编排适合依赖明确的任务，动态路由适合能力异构的任务，竞标适合存在可替代执行者的任务。',
      '建议分别考察任务拆分误差、跨智能体证据传递损失与失败恢复。实验中应固定模型、输入资料与预算，同时报告完成率、通信开销和结论可追溯性。'],
    answer: `## 大模型多智能体协作研究综述\n\n### 一、研究脉络\n从角色分工、通信协议、任务调度和评价方法四个维度组织材料。多智能体系统的关键不是增加调用次数，而是让不同能力围绕共同交付物形成可验证的协作。\n\n### 二、协调机制对照\n\n| 机制 | 适用场景 | 重点检查 |\n| --- | --- | --- |\n| 集中编排 | 依赖明确、交付稳定 | 协调成本与单点瓶颈 |\n| 动态路由 | 能力异构、需求变化 | 能力描述与选择依据 |\n| 任务竞标 | 执行者可替代、任务可拆分 | 报价可信度、租约与任务去重 |\n\n### 三、研究空白\n1. **拆分可靠性**：局部子任务是否覆盖整体目标。\n2. **证据传递**：中间摘要是否损失关键限定条件。\n3. **失败恢复**：超时、重试与替换执行者是否保持幂等。\n\n### 四、建议实验\n在同一组问题上比较集中编排与竞标模式，固定模型、预算和资料；保存完整执行轨迹，并分别记录任务完成率、通信开销、证据覆盖率。\n\n### 资料索引\n- [协调机制资料卡](/demo/materials.html#coordination)\n- [评价方法资料卡](/demo/materials.html#evaluation)\n\n> 本次使用预置资料完成演示，不代表实时文献检索。`,
  },
  news: {
    question: '整理北京、上海、杭州三地的科技新闻素材，核对时间和来源，归纳共同趋势，区分事实与分析。',
    title: '区域科技新闻联合研判', workers: ['news_verification', 'peer_review'],
    tasks: ['整理三地科技新闻素材，核对事件、主体、时间和来源。', '核对事实与分析的边界，整理需要进一步确认的事项。'],
    reports: ['三地样稿分别涉及科研设施开放、产业技术交流和公共技术服务。已按事件主体、实施范围与发布时间整理资料表。', '素材能够支持对三类服务场景的对照，不能据此推断整个行业趋势。正式发布前应核对官方原文和执行口径。'],
    answer: `## 区域科技新闻联合研判\n\n| 地区 | 素材主题 | 已整理内容 |\n| --- | --- | --- |\n| 北京 | 科研设施开放 | 开放范围、预约对象与使用方式 |\n| 上海 | 产业技术交流 | 活动时间、参与主体与议题 |\n| 杭州 | 公共技术服务 | 服务对象、运行阶段和申请流程 |\n\n### 共同主题\n三组素材均涉及科研资源和实际服务的连接。跨来源归并时应对齐主体、时间与范围，避免将试运行与正式上线混为一谈。\n\n### 核验清单\n- 保留原始发布时间与发布主体。\n- 将已确认事实与分析推断分开。\n- 对未确认事项保留标记，不扩写为确定结论。\n\n> 以上为离线预置新闻样稿，不是实时新闻。`,
  },
  travel: {
    question: '安排一次北京到杭州的三日学术访问，包含会议、校园参访与交通衔接，给出时间表、约束与备选方案。',
    title: '杭州三日学术访问方案', workers: ['travel_logistics', 'docs_overview'],
    tasks: ['组合三日会议、交通与校园参访安排，预留衔接时间。', '整理会前阅读材料、参访议题和交流问题清单。'],
    reports: ['第一天抵达与会前讨论，第二天会议和参访，第三天合作讨论后返程。会议前预留交通缓冲，校园参访以预约确认为前提。', '会前资料可按研究问题、技术路线和合作方向归档；建议准备一页研究摘要、三项交流问题与纪要模板。'],
    answer: `## 杭州三日学术访问方案\n\n| 日期 | 上午 | 下午 |\n| --- | --- | --- |\n| 第一天 | 抵达、入住 | 会前讨论与材料确认 |\n| 第二天 | 专题会议与报告 | 校园参访与课题交流 |\n| 第三天 | 合作讨论、形成纪要 | 交通衔接与返程 |\n\n### 出发前确认\n参访预约、会议时间、交通时刻、住宿位置与临时联系人。会议开始前保留缓冲时间，重要交流准备线上备选。\n\n### 备选安排\n交通延误时优先保留会议，将参访调整到第三天；访谈取消时替换为资料交流。\n\n> 时刻与行程为预置方案，没有查询余票、价格，也没有实际预订。`,
  },
}
export function scenarioFor(message) {
  if (/新能源政策|政策研究报告/.test(message)) return SCENARIOS.policy
  if (/旅游|出行|行程|访问|交通|杭州.*三|机票|酒店/.test(message)) return SCENARIOS.travel
  if (/新闻|暴雨|地铁|通报|资讯/.test(message)) return SCENARIOS.news
  return SCENARIOS.research
}
export function freshState() {
  return { version: 2, demo: true, signedIn: true, adminSignedIn: true, agents: clone(SEED_AGENTS),
    providers: clone(PROVIDERS), catalog: clone(CATALOG), conversations: {}, activities: {}, traces: [], logs: [], tasks: {}, canvases: {}, groups: {},
    policy: { name: 'balanced', interop_compatibility: true, external_delegation_enabled: true, bounty_enabled: true,
      bounty_max_workers: 3, bounty_max_items: 6, bounty_lease_seconds: 180, weights: { semantic: 0.35, latency: 0.15, success: 0.25, cost: 0.1, feedback: 0.15 },
      failure_threshold: 3, circuit_cooldown_seconds: 60, max_attempts: 2, request_timeout_seconds: 180 },
    search: { backend: 'deepseek_native', deepseek_provider_id: 'demo-deepseek', timeout_seconds: 30, max_results: 5, max_queries: 3, exa_key_configured: false, native_daily_limit: 1000 },
    accounts: [ { id: OWNER, display_name: '演示管理员', email: 'owner@example.invalid', role: 'owner', active: true, created_at: stamp(), last_login_at: stamp() },
      { id: 'account_demo_researcher', display_name: '研究用户', email: 'researcher@example.invalid', role: 'member', active: true, created_at: stamp(), last_login_at: stamp() } ],
    accountPolicy: { accounts_enabled: true, email_enabled: true, quota_mode: 'enforce', daily_tasks: 30, concurrent_tasks: 2,
      daily_upload_bytes: 104857600, guest_turns: 3, member_monthly_units: 2000000, public_monthly_units: 20000000, model_output_tokens: 8192,
      roles: Object.fromEntries(['guest', 'member', 'trusted', 'admin', 'owner', 'service'].map(role => [role,
        { daily_tasks: 30, concurrent_tasks: 2, daily_upload_bytes: 104857600, monthly_units: 2000000, exempt: ['owner', 'admin'].includes(role) }])), provider_budgets: {} },
    settings: { speed: 1, channel: 'https' }, seq: 0 }
}
