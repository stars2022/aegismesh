import { STORE_KEY, OWNER, OUTPUT_SCHEMA, SCENARIOS, agent, clone, freshState, scenarioFor, stamp } from './fixtures.mjs'

const json = (data, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-AegisMesh-Demo': 'offline-fixture', ...headers } })
const fail = (status, detail) => json({ detail, demo: true }, status)
const abortError = () => new DOMException('演示任务已取消', 'AbortError')
export const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError())
  const abort = () => { clearTimeout(timer); reject(abortError()) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
  signal?.addEventListener('abort', abort, { once: true })
})

export function createRuntime({ storage, origin = 'http://127.0.0.1:5610', timeScale = 1 } = {}) {
  let state
  try { state = JSON.parse(storage?.getItem(STORE_KEY) || 'null') } catch { /* corrupted fixture reset */ }
  if (state?.version !== 2 || state.demo !== true) state = freshState()
  // A page refresh cannot leave a fake task permanently running.
  for (const task of Object.values(state.tasks)) if (task.status === 'running') task.status = 'cancelled'
  const requests = [], controllers = new Map()
  const save = () => { try { storage?.setItem(STORE_KEY, JSON.stringify(state)) } catch { /* demo remains usable in memory */ } }
  const id = prefix => `demo-${prefix}-${++state.seq}`
  const quota = () => ({ mode: state.accountPolicy.quota_mode, role: 'owner', exempt: true, task_period: 'daily', note: '',
    tasks: { used: state.traces.length, reserved: 0, limit: 30, remaining: null }, concurrency: { used: 0, reserved: 0, limit: 2, remaining: null },
    upload_bytes: { used: 0, reserved: 0, limit: 104857600, remaining: null },
    model_budget: { unit: '模型额度点', rolling: true, windows: { five_hours: { used: state.traces.length * 1780, limit: 400000 }, week: { used: state.traces.length * 1780, limit: 2000000 } },
      providers: state.providers.map(p => ({ id: p.id, name: p.name, used: state.traces.length * 1780, limit: 2000000 })) } })
  const config = () => ({ enabled: state.accountPolicy.accounts_enabled, email_enabled: true, email_registration_ready: true,
    quota_mode: state.accountPolicy.quota_mode, providers: [], turnstile: { enabled: false, ready: false, site_key: '' } })
  const page = (items, params) => { const page = Math.max(1, Number(params.get('page')) || 1), page_size = Number(params.get('page_size')) || 20
    return { items: items.slice((page - 1) * page_size, page * page_size), total: items.length, page, page_size } }
  const record = (kind, summary, extra = {}) => {
    state.logs.unshift({ id: ++state.seq, origin: 'amp', kind, occurred_at: stamp(), indexed_at: stamp(), level: 'INFO', outcome: 'success',
      aic: '', caller_aic: '', callee_aic: '', task_id: '', trace_id: '', message_id: '', request_id: '', actor: 'demo-owner', action: kind,
      target: '', summary, status_code: 200, duration_ms: 86, source_file: 'offline-fixture', delivery: 'local_only', detail: { demo: true }, ...extra })
    state.logs = state.logs.slice(0, 200); save()
  }
  const update = (rows, key, body) => { const row = rows.find(a => a.id === key); if (!row) return fail(404, '演示记录不存在')
    Object.assign(row, body, { updated_at: stamp() }); save(); return json(row) }
  const probes = () => state.agents.map((a, i) => ({ id: i + 1, agent_id: a.id, status: a.active ? 'healthy' : 'degraded',
    latency_ms: 45 + i * 11, acs_valid: true, aip_reachable: a.active, compatibility_score: 100,
    findings: [{ level: 'info', code: 'offline-fixture', message: '预置 ACS 与互联通道检查通过' }], snapshot: { demo: true, aic: a.aic }, created_at: stamp() }))
  function makeResult(body, taskId) {
    const scenario = scenarioFor(String(body.message || ''))
    const leader = state.agents.find(a => a.id === body.agent_id) || state.agents.find(a => a.role === 'leader') || state.agents[0]
    const session = body.session_id || id('session'), invocation = id('invocation')
    const now = Date.now(), channel = state.settings.channel === 'mq' ? 'AMQPS' : 'HTTPS AIP'
    const collaborators = scenario.workers.map((key, i) => {
      const a = state.agents.find(a => a.id === key) || state.agents.find(a => a.role === 'partner')
      return { task_id: `${taskId}-sub-${i + 1}`, session_id: session, invocation_id: `${invocation}-sub-${i + 1}`,
        agent_id: a.id, agent_name: a.name, caller_id: leader.id, call_chain: [leader.id, a.id], depth: 1,
        task: scenario.tasks[i], status: 'completed', latency_ms: 4280 + i * 760, phase_name: '任务已完成', elapsed_seconds: 5,
        tools: [{ id: `${taskId}-search-${i}`, name: 'web_search', arguments: { query: scenario.tasks[i] }, status: 'completed', output_preview: '已整理预置资料，返回证据摘要与来源索引。' }],
        messages: [{ role: 'user', content: scenario.tasks[i] }, { role: 'assistant', content: scenario.reports[i] }],
        result: scenario.reports[i], token_count: 680 + i * 110, tokens_per_second: 82.4,
        started_at: now, completed_at: now + 5700 }
    })
    const blackboard = collaborators.flatMap((c, i) => [
      { id: `${taskId}-dispatch-${i}`, sender_id: leader.id, sender_name: leader.name, nickname: '协调者', role: 'leader', type: 'dispatch', content: c.task, timestamp: now / 1000, metadata: { demo: true, transport: channel } },
      { id: `${taskId}-report-${i}`, sender_id: c.agent_id, sender_name: c.agent_name, nickname: '执行者', role: 'expert', type: 'report', content: c.result, timestamp: (now + 5700) / 1000, metadata: { demo: true, transport: channel } },
    ])
    const result = { invocation_id: invocation, session_id: session, status: 'completed', answer: scenario.answer,
      selected_agent: clone(leader), candidates: state.agents.map((a, i) => ({ agent_id: a.id, agent_name: a.name, eligible: a.active, score: Number((0.94 - i * 0.07).toFixed(2)),
        rank: i + 1, breakdown: { semantic: 0.95, latency: 0.84, success: 1, cost: 0.9, feedback: 0.9 }, reasons: ['能力与任务匹配'], weights: state.policy.weights })),
      failover_count: 0, latency_ms: 12840, usage: { llm_calls: 3, prompt_tokens: 3820, completion_tokens: 1846 },
      structured_output: body.structured_io ? { title: scenario.title, summary: scenario.reports[0], findings: scenario.reports, sources: ['协调机制资料卡', '评价方法资料卡'] } : null,
      result_data: { mode: body.mode || 'route', demo: true, transport: channel,
        context: { history_turns: (state.activities[session]?.length || 0) + 1, history_messages: 2, compressed_turns: 0 },
        collaborations: collaborators, contributions: collaborators.map(c => ({ agent_id: c.agent_id, agent_name: c.agent_name, text: c.result, data: { demo: true } })),
        tool_executions: [{ name: 'list_agents', arguments: { query: scenario.title }, output: { agents: collaborators.map(c => c.agent_name), source: 'preset-adp', demo: true } },
          ...collaborators.map(c => ({ name: 'dispatch_task', arguments: { agent: c.agent_name, task: c.task }, output: { task_id: c.task_id, agent_id: c.agent_id, agent_name: c.agent_name, result: c.result, transport: channel, demo: true } }))],
        shared_context: { root_invocation_id: invocation, session_id: session, overall_objective: body.message,
          subtasks: collaborators, completed_reports: collaborators.map(c => ({ ...c, summary: c.result })), blackboard_messages: blackboard, lineage: [] }, lineage: [],
      } }
    if (body.mode === 'bounty') result.result_data.bounty = { invocation_id: invocation, closed: true, max_items: 6,
      items: collaborators.map((c, i) => ({ id: `${taskId}-bid-${i}`, title: i ? '独立审查与复核' : '证据检索与整理', task: c.task,
        acceptance: '有明确结论、证据与待确认事项', priority: i + 1, status: 'accepted', proposed_by: leader.id, claimed_by: c.agent_id,
        reviewed_by: leader.id, result: c.result, evidence: ['预置资料卡'], review_note: '交付物满足要求' })) }
    if (body.canvas || body.presentation === 'assistant') {
      let canvas = state.canvases[session]
      if (!canvas) canvas = state.canvases[session] = { id: id('canvas'), title: scenario.title, content: '', version: 0, revisions: [], created_at: stamp() }
      canvas.content = canvas.version > 0
        ? `${scenario.answer}\n\n## 验收与复核\n\n| 工作项 | 交付物 | 验收方式 |\n| --- | --- | --- |\n| 证据检索 | 来源与纳入记录 | 人工核对原文 |\n| 独立审查 | 风险与研究空白 | 复核结论及未确认项 |`
        : scenario.answer
      canvas.version++; canvas.updated_at = stamp()
      canvas.revisions.push({ version: canvas.version, editor_name: leader.name, summary: '汇总协作结果', created_at: stamp(), content: canvas.content })
      result.result_data.canvas = clone(canvas)
    }
    if (leader?.role === 'partner' && !String(body.message).includes('【AIP 国标规范·智能体多方协作群聊】')) {
      result.candidates = result.candidates.filter(candidate => candidate.agent_id === leader.id)
        .map(candidate => ({ ...candidate, rank: 1, score: 1, reasons: ['用户指定智能体'] }))
      result.usage = { llm_calls: 1, prompt_tokens: 1260, completion_tokens: 640 }
      result.latency_ms = 3260
      result.result_data.collaborations = []
      result.result_data.contributions = []
      result.result_data.shared_context.subtasks = []
      result.result_data.shared_context.blackboard_messages = []
      result.result_data.tool_executions = [{ name: 'web_search', arguments: { query: scenario.title }, output: { demo: true, text: scenario.reports[0] } }]
    }
    if (String(body.message).includes('【AIP 国标规范·智能体多方协作群聊】')) {
      result.answer = `已整理相关研究脉络与评价要点，详细材料已写入黑板，供本群讨论和复核。\n\n\`\`\`blackboard:${scenario.title}\n${scenario.answer}\n\`\`\``
      result.result_data.collaborations = []
      result.result_data.contributions = []
      result.result_data.shared_context.subtasks = []
      result.result_data.shared_context.blackboard_messages = []
      result.result_data.tool_executions = [{ name: 'web_search', arguments: { query: scenario.title }, output: { demo: true, text: scenario.reports[0] } }]
    }
    return result
  }
  function complete(result, body, taskId) {
    const task = state.tasks[taskId]; if (task?.status === 'cancelled' || task?.status === 'completed') return
    task.status = 'completed'; task.result = result
    ;(state.activities[result.session_id] ||= []).push(result)
    state.traces.unshift({ id: result.invocation_id, session_id: result.session_id, query: body.message, status: 'completed',
      selected_agent_id: result.selected_agent?.id || null, result_text: result.answer, result_data: result.result_data,
      total_latency_ms: result.latency_ms, attempt_count: 1, ...result.usage, created_at: stamp(), finished_at: stamp(),
      attempts: result.candidates.filter(c => c.agent_id === result.selected_agent?.id).slice(0, 1).map(c => ({ agent_id: c.agent_id, rank: c.rank, score: c.score, state: 'succeeded', latency_ms: result.latency_ms, error: null, breakdown: c.breakdown })),
      events: [{ type: 'demo', detail: { preset: true, transport: result.result_data.transport }, created_at: stamp() }] })
    for (const key of [result.selected_agent?.id, ...result.result_data.collaborations.map(c => c.agent_id)]) {
      const a = state.agents.find(a => a.id === key); if (a) { a.success_count++; a.request_count++ }
    }
    record(state.settings.channel === 'mq' ? 'message' : 'access', `${result.selected_agent?.name}：${body.message}`, {
      task_id: taskId, trace_id: result.invocation_id, aic: result.selected_agent?.aic || '',
      caller_aic: result.selected_agent?.aic || '', callee_aic: state.agents.find(a => a.id === result.result_data.collaborations[0]?.agent_id)?.aic || result.selected_agent?.aic || '',
      detail: { demo: true, transport: result.result_data.transport, notification: '预置完成回执', result: result.invocation_id } })
    save()
  }
  function stream(body, signal, existingId) {
    const taskId = existingId || id('task')
    const task = existingId ? state.tasks[taskId] : { status: 'running', session_id: body.session_id, body, created_at: Date.now() }
    if (!task) return fail(404, '演示任务不存在')
    body = task.body || body; state.tasks[taskId] = task
    const controller = new AbortController(); controllers.set(taskId, controller)
    signal?.addEventListener('abort', () => controller.abort(), { once: true })
    if (signal?.aborted) controller.abort()
    const result = task.result || makeResult(body, taskId)
    task.session_id = result.session_id
    save()
    const events = [{ type: 'status', data: { task_id: taskId, status: 'running' }, message: '正在规划任务' }]
    if (task.status !== 'completed') {
      for (const c of result.result_data.collaborations) {
        events.push({ type: 'subagent_start', data: c },
          { type: 'blackboard_message', data: result.result_data.shared_context.blackboard_messages.find(m => m.type === 'dispatch' && m.content === c.task) },
          { type: 'subagent_tool', data: { task_id: c.task_id, agent_id: c.agent_id, tool: 'web_search', tool_call_id: c.tools[0].id, arguments: c.tools[0].arguments } })
      }
      for (const c of result.result_data.collaborations) events.push(
        { type: 'subagent_tool_done', data: { task_id: c.task_id, agent_id: c.agent_id, tool: 'web_search', tool_call_id: c.tools[0].id, status: 'completed', output_preview: c.tools[0].output_preview } },
        { type: 'subagent_complete', data: c },
        { type: 'blackboard_message', data: result.result_data.shared_context.blackboard_messages.find(m => m.type === 'report' && m.sender_id === c.agent_id) })
      if (result.result_data.canvas) events.push({ type: 'canvas_updated', data: { canvas_id: result.result_data.canvas.id } })
      const chunks = Array.from(result.answer).join('').match(/[\s\S]{1,36}/gu) || []
      events.push(...chunks.map(text => ({ type: 'delta', text })))
    }
    events.push({ type: 'result', data: result })
    const encoder = new TextEncoder()
    const bodyStream = new ReadableStream({
      async start(output) {
        try {
          for (let i = 0; i < events.length; i++) {
            const event = events[i]
            await delay((event.type === 'delta' ? 50 : event.type === 'result' ? 100 : 620) * timeScale / state.settings.speed, controller.signal)
            if (event.type === 'result') complete(result, body, taskId)
            output.enqueue(encoder.encode(`id: ${i}\ndata: ${JSON.stringify(event)}\n\n`))
          }
          output.close()
        } catch (error) {
          if (task.status !== 'completed') task.status = 'cancelled'
          save(); try { output.error(error) } catch { /* reader disposed */ }
        } finally { controllers.delete(taskId) }
      },
      cancel() { controller.abort() },
    })
    return new Response(bodyStream, { headers: { 'Content-Type': 'text/event-stream', 'X-Task-Id': taskId, 'X-AegisMesh-Demo': 'offline-fixture' } })
  }
  async function fetchMock(input, init = {}) {
    const requestUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const url = new URL(requestUrl, origin), path = decodeURIComponent(url.pathname), params = url.searchParams
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase()
    requests.push({ method, path, at: stamp(), external: url.origin !== origin })
    if (url.origin !== origin || !path.startsWith('/api/')) return fail(451, '离线演示禁止网络请求；没有连接真实服务。')
    if (init.signal?.aborted) throw abortError()
    let body = {}
    if (init.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body) } catch { return fail(422, '演示接口需要 JSON 输入') }
    }
    const isGet = method === 'GET'
    if (path === '/api/health') return json({ status: 'ok', demo: true })
    if (path === '/api/demo/session') return json({ enabled: false, authenticated: true, owner_id: state.signedIn ? OWNER : 'guest_demo' })
    if (path === '/api/admin/session') return json({ enabled: true, authenticated: state.adminSignedIn, username: 'demo-admin' })
    if (path === '/api/admin/login') { state.adminSignedIn = true; save(); return json({ enabled: true, authenticated: true, username: 'demo-admin' }) }
    if (path === '/api/admin/logout') { state.adminSignedIn = false; save(); return json({ ok: true }) }
    if (path === '/api/demo/login' || path === '/api/demo/logout') return json({ ok: true })
    if (path === '/api/account/config') return json(config())
    if (path === '/api/account/me') return json({ owner_id: state.signedIn ? OWNER : 'guest_demo', account: state.signedIn ? state.accounts[0] : null, identities: [], quota: quota() })
    if (path === '/api/account/sessions') return json([{ id: 'demo-session', current: true, created_at: stamp() }])
    if (path.startsWith('/api/account/sessions/')) return json({ ok: true })
    if (path === '/api/account/logout') { state.signedIn = false; save(); return json({ ok: true }) }
    if (['/api/account/login', '/api/account/verify-email'].includes(path)) { state.signedIn = true; save(); return json({ message: '已登录演示账号', demo: true }) }
    if (['/api/account/register', '/api/account/password/request-reset', '/api/account/password/reset'].includes(path)) return json({ message: '离线演示已完成此步骤，不会发送真实邮件。验证令牌：DEMO', demo: true })
    if (path === '/api/account/history') return json({ items: Object.entries(state.conversations).map(([session, row]) => ({ ...row.conversation, session, messageCount: row.conversation.messages?.length || 0, revision: row.revision, deleted: !!row.deleted, messages: undefined })), next_offset: null })
    if (path.startsWith('/api/account/history/')) {
      const parts = path.slice('/api/account/history/'.length).split('/'), key = parts[0], row = state.conversations[key]
      if (method === 'PUT') {
        if (row && body.revision !== row.revision) return json({ detail: 'revision conflict', revision: row.revision }, 409)
        const revision = (row?.revision || 0) + 1
        state.conversations[key] = { conversation: body.conversation, revision, deleted: false }; save(); return json({ revision })
      }
      if (method === 'DELETE') { if (row) { row.deleted = true; row.revision++ }; save(); return json({ revision: row?.revision || 1 }) }
      if (parts[1] === 'restore' && row) { row.deleted = false; row.revision++; save(); return json(row) }
      return row ? json(row, row.deleted ? 410 : 200) : fail(404, '会话尚未保存')
    }
    if (path === '/api/agents') {
      if (isGet) return json(state.agents)
      const key = String(body.id || id('agent'))
      if (state.agents.some(a => a.id === key)) return fail(409, '这个演示标识已存在')
      const created = agent(key, body.name || '新智能体', body.role || 'partner', { ...body,
        aic: body.aic || '', registration_status: body.aic ? 'approved' : 'local', registration_agent_id: '', certificate_issued_at: null })
      state.agents.push(created); record('audit', `创建智能体 ${created.name}`, { origin: 'admin' }); return json(created)
    }
    if (path.startsWith('/api/agents/')) {
      const [, , , key, action, subaction] = path.split('/'), a = state.agents.find(a => a.id === key)
      if (!a) return fail(404, '智能体不存在')
      if (action === 'acs-preview') return json({ acs: { name: a.name, description: a.description, aic: a.aic || '签发后分配', version: '1.0.0', skills: a.skills,
        capabilities: { streaming: a.streaming_enabled, notification: a.notification_enabled }, endPoints: [{ url: a.endpoint_url }], demo: true },
        target_registry: 'https://registry.demo.invalid', registry_username: 'demo-owner', public_rpc_url: a.endpoint_url })
      if (action === 'registration') {
        if (subaction === 'sync') { a.registration_status = 'approved'; a.aic ||= agent(key, a.name).aic; a.registration_message = ''; a.registration_synced_at = stamp(); a.health = 'online' }
        else { a.registration_status = 'pending'; a.registration_message = '预置审核流程，点击同步审核状态继续。'; a.registration_agent_id = id('registration') }
        record('audit', `${a.name}：${subaction === 'sync' ? '同步审核' : '提交注册'}`, { origin: 'admin' }); return json(a)
      }
      if (action === 'certificate') { a.certificate_issued_at = stamp(); save(); return json({ aic: a.aic, certPath: 'demo://certificate', keyPath: 'demo://no-private-key', trustBundlePath: 'demo://trust-bundle' }) }
      if (method === 'PATCH') return update(state.agents, key, body)
      if (method === 'DELETE') { state.agents = state.agents.filter(a => a.id !== key); save(); return json(null, 204) }
      return json(a)
    }
    if (path === '/api/admin/agent-designer/generate') {
      await delay(1450 * timeScale / state.settings.speed, init.signal)
      const draft = agent('policy_research_assistant', '政策研究协作助手', 'partner', { aic: '', registration_status: 'local',
        description: '检索政策资料，提取适用范围与实施时间，对齐原始条款并整理证据。', model_provider: body.provider_id || state.providers[0].id })
      record('audit', '生成预置智能体草稿', { origin: 'admin' })
      return json({ draft, request_id: id('design'), application_quota_exempt: true, usage: { llm_calls: 0, prompt_tokens: 0, completion_tokens: 0 }, demo: true })
    }
    if (path === '/api/providers') {
      if (isGet) return json(state.providers)
      const p = { ...body, id: body.id || id('provider'), key_configured: true, updated_at: stamp() }; state.providers.push(p); save(); return json(p)
    }
    if (path.startsWith('/api/providers/')) {
      const key = path.split('/')[3]
      if (path.endsWith('/test')) return json({ ok: true, latency_ms: 168, demo: true })
      if (method === 'DELETE') { state.providers = state.providers.filter(p => p.id !== key); save(); return json(null, 204) }
      return update(state.providers, key, body)
    }
    if (path === '/api/policy') { if (!isGet) { Object.assign(state.policy, body); save() }; return json(state.policy) }
    if (path === '/api/chat/config') return json({ interop_compatibility: state.policy.interop_compatibility, bounty_enabled: state.policy.bounty_enabled, default_coordinator_id: state.agents.find(a => a.role === 'leader')?.id })
    if (path === '/api/dashboard') return json({ agents: state.agents.length, online_agents: state.agents.filter(a => a.active).length,
      requests: state.traces.length, success_rate: state.traces.length ? 100 : null, avg_latency_ms: state.traces.length ? 12840 : 0, failovers: 0,
      active_tasks: Object.values(state.tasks).filter(t => t.status === 'running').length, probe_health: { healthy: state.agents.length, degraded: 0 },
      roles: { leaders: state.agents.filter(a => a.role === 'leader').length, partners: state.agents.filter(a => a.role === 'partner').length },
      agent_usage: state.agents.map(a => ({ id: a.id, name: a.name, count: a.request_count })),
      recent_activity: state.traces.slice(0, 5).map(t => ({ id: t.id, status: t.status, latency_ms: t.total_latency_ms, attempts: 1, created_at: t.created_at })) })
    if (path === '/api/discovery/feed') { const query = (params.get('query') || '').toLowerCase(); return json(state.catalog.filter(a => !query || `${a.aic} ${a.name} ${a.description}`.toLowerCase().includes(query))) }
    if (path === '/api/discovery/search') {
      const items = state.catalog.filter(a => !body.query || `${a.aic} ${a.name} ${a.description}`.includes(body.query))
      return json({ result: { acs: items }, acsMap: Object.fromEntries(items.map(a => [a.aic, a])), aliveMap: Object.fromEntries(items.map(a => [a.aic, true])), raw: { demo: true }, candidates: items })
    }
    if (path === '/api/discovery/import') {
      const source = state.catalog.find(a => a.aic === body.aic), previous = state.agents.find(a => a.aic === body.aic)
      if (previous) return json(previous)
      const imported = agent(source?.id || id('imported'), body.name, 'partner', { ...source, ...body, endpoint_url: body.endpoint || source?.endpoint_url,
        transport: 'aip-rpc', registration_status: 'imported', streaming_enabled: !!body.streaming, notification_enabled: !!body.notification })
      state.agents.push(imported); record('access', `ADP 发现并固定 ${imported.name}`); return json(imported)
    }
    if (path === '/api/probes' || path === '/api/probes/run') return json(probes())
    if (path === '/api/invocations') return json(state.traces.slice(Number(params.get('offset')) || 0, (Number(params.get('offset')) || 0) + (Number(params.get('limit')) || 50)))
    if (/^\/api\/invocations\/[^/]+\/feedback$/.test(path)) return json({ invocation_id: path.split('/')[3], agent_id: 'research_leader', rating: body.rating, positive_count: body.rating > 0 ? 1 : 0, negative_count: body.rating < 0 ? 1 : 0 })
    if (path === '/api/demo/chat/stream') return stream(body, init.signal)
    if (path === '/api/demo/chat') { const taskId = id('task'); state.tasks[taskId] = { status: 'running' }; const r = makeResult(body, taskId); complete(r, body, taskId); return json(r) }
    if (path === '/api/demo/tasks/active') { const row = Object.entries(state.tasks).find(([, t]) => t.status === 'running' && t.session_id === params.get('session_id')); return json(row ? { active: true, task: { task_id: row[0], status: 'running', has_result: false, event_count: 0 } } : { active: false }) }
    if (/^\/api\/(demo\/)?tasks\/[^/]+\/cancel$/.test(path)) { const key = path.split('/').at(-2); if (state.tasks[key]) state.tasks[key].status = 'cancelled'; controllers.get(key)?.abort(); save(); return json({ ok: true }) }
    if (/^\/api\/demo\/tasks\/[^/]+\/stream$/.test(path)) return stream({}, init.signal, path.split('/').at(-2))
    if (/^\/api\/chat\/sessions\/[^/]+\/activity$/.test(path)) { const key = path.split('/').at(-2); return json({ session_id: key, items: state.activities[key] || [], next_before: null }) }
    if (path.startsWith('/api/canvas/')) {
      const parts = path.slice('/api/canvas/'.length).split('/'), session = parts[0] === 'session' ? parts[1] : Object.keys(state.canvases).find(k => state.canvases[k].id === parts[0])
      let canvas = state.canvases[session]
      if (!canvas && parts[0] === 'session' && isGet) {
        canvas = state.canvases[session] = { id: id('canvas'), title: '未命名画布', content: '', version: 0, revisions: [], created_at: stamp(), updated_at: stamp() }
        save()
      }
      if (method === 'PUT') {
        if (!canvas) canvas = state.canvases[session] = { id: id('canvas'), title: '研究文稿', content: '', version: 0, revisions: [], created_at: stamp() }
        if (body.base_version !== canvas.version) return json({ detail: '画布版本已变化', current: canvas }, 409)
        canvas.content = body.content; canvas.version++; canvas.updated_at = stamp(); canvas.revisions.push({ version: canvas.version, editor_name: '演示管理员', summary: '手动编辑', created_at: stamp(), content: body.content }); save()
      }
      if (!canvas) return fail(404, '画布尚未创建')
      if (parts[0] !== 'session' && parts[1] === 'revisions') return json(canvas.revisions.find(r => r.version === Number(parts[2])) || {})
      return json(canvas)
    }
    if (path === '/api/group-chat') { const group = { id: id('group'), ...body, transport: 'local', demo: true }; state.groups[group.id] = group; save(); return json(group) }
    if (/^\/api\/group-chat\/[^/]+\/messages$/.test(path)) {
      const group = state.groups[path.split('/')[3]]
      if (!group) return fail(404, '群聊不存在')
      const a = state.agents.find(a => a.id === body.mentioned && group.members.includes(a.id))
        || state.agents.find(a => a.id === (group.host_agent_id || group.members[0]))
      if (!a) return fail(404, '群成员不存在')
      const s = scenarioFor(body.text)
      if (!String(body.text).startsWith('群内继续讨论')) group.round = 0
      group.round = (group.round || 0) + 1
      const nextId = a.id === 'research_leader' ? 'docs_overview' : a.id === 'docs_overview' ? 'peer_review' : null
      const next = group.round < 3 && state.agents.find(agent => agent.id === nextId && group.members.includes(agent.id))
      const title = a.id === 'research_leader' ? '研究协作安排' : a.id === 'docs_overview' ? '文献证据与研究空白' : '独立复核意见'
      const report = a.id === 'research_leader' ? '先整理研究证据，再由独立审查者核对评价指标、证据边界和未确认项。'
        : a.id === 'docs_overview' ? s.reports[0] : s.reports[1]
      const reply = `已完成${title}，详细材料见黑板。${next ? `@${next.name} 请接着完成${next.id === 'docs_overview' ? '证据检索与综述' : '独立审查与风险复核'}。` : '本轮交付已齐备，请主持人确认。'}\n\n\`\`\`blackboard:${title}\n${report}\n\`\`\``
      await delay(900 * timeScale / state.settings.speed, init.signal)
      record('message', `${a.name}：群组消息回执`, { detail: { demo: true, group_id: group.id, speaker: a.id, next: next?.id || null } })
      return json({ reply, agent_id: a.id, agent_name: a.name, transport: 'local', demo: true })
    }
    if (path === '/api/admin/web-search') { if (!isGet) { Object.assign(state.search, body); save() }; return json(state.search) }
    if (path === '/api/admin/web-search/test') return json({ ok: true, latency_ms: 286, backend: body.backend || state.search.backend,
      sources: [{ title: '协调机制资料卡', url: '/demo/materials.html#coordination' }], usage: { llm_calls: 0, prompt_tokens: 0, completion_tokens: 0, search_requests: 0 }, demo: true })
    if (path === '/api/admin/access') return json({ api_key_configured: false, api_key_from_environment: false, demo_password_enabled: false })
    if (path === '/api/admin/accounts') return json({ ...config(), policy: state.accountPolicy, policy_revision: 'demo-1', mail_configured: true,
      model_providers: state.providers, counts: { total: state.accounts.length, active: state.accounts.filter(a => a.active).length, disabled: state.accounts.filter(a => !a.active).length } })
    if (path === '/api/admin/accounts/policy') { Object.assign(state.accountPolicy, body.changes); record('audit', '修改演示账号或配额策略', { origin: 'admin' }); return json({ ok: true }) }
    if (path === '/api/admin/accounts/users') return json(page(state.accounts.filter(a => (!params.get('q') || `${a.display_name} ${a.email}`.includes(params.get('q'))) && (!params.get('role') || a.role === params.get('role'))), params))
    if (path.startsWith('/api/admin/accounts/users/')) {
      const key = path.split('/')[5], account = state.accounts.find(a => a.id === key); if (!account) return fail(404, '账号不存在')
      if (method === 'PATCH') { for (const name of ['display_name', 'role', 'active']) if (name in body) account[name] = body[name]; save() }
      if (path.endsWith('/sessions/revoke')) return json({ ok: true })
      return json({ account, revision: 'demo-1', limits: {}, quota: quota(), login_methods: ['email'], sessions: [{ id: 'demo-session', created_at: stamp(), expires_at: new Date(Date.now() + 86400000).toISOString() }], audit: [] })
    }
    if (path === '/api/admin/quotas/usage') return json({ ...page(state.traces.map(t => ({ id: t.id, owner_id: OWNER, display_name: '演示管理员', provider_id: 'demo-deepseek', model: 'deepseek-chat', session_id: t.session_id,
      invocation_id: t.id, prompt_tokens: t.prompt_tokens, completion_tokens: t.completion_tokens, units: 0, status: 'completed', exempt: true, created_at: t.created_at })), params), units: 0 })
    if (path === '/api/admin/logs/status') return json({ sources: [{ name: '离线预置事件', offset: state.logs.length, size: state.logs.length, pending_bytes: 0, invalid_lines: 0, expired_lines: 0, rotations: 0, rotation_gaps: 0, error: '', checked_at: stamp() }],
      indexer_enabled: true, poll_seconds: 5, audit_write_failures: 0, retention: { amp_days: 30, amp_limit: 10000, audit_days: 90, audit_limit: 10000 }, delivery: { state: 'local_only', message: '仅离线演示记录，没有上报平台。' } })
    if (path === '/api/admin/logs' || path === '/api/admin/logs/export') { const rows = state.logs.filter(r => !params.get('origin') || r.origin === params.get('origin')); return json({ items: rows, next_cursor: '', total: rows.length, errors: 0, demo: true }) }
    if (path.startsWith('/api/admin/logs/')) return json(state.logs.find(r => r.id === Number(path.split('/').at(-1))) || {})
    if (path === '/api/admin/database/export') return json({ demo: true, agents: state.agents, policy: state.policy, conversations: state.conversations })
    if (path === '/api/admin/database/import') return json({ imported: { agents: 0 }, mode: body.mode, demo: true })
    if (path === '/api/upload') {
      const file = init.body?.get?.('file')
      if (!file) return fail(422, '请选择演示资料文件')
      const text = '预置演示材料：比较集中编排、动态路由与任务竞标；固定模型、预算与输入资料，分别评价完成率、证据覆盖率及协作开销。'
      return json({ ok: true, file_id: id('file'), filename: file.name || '研究资料.md', content_type: file.type || 'text/markdown', size: file.size || text.length,
        url: '/demo/materials.html', is_image: false, extracted_text: text, extracted_text_preview: text, text_length: text.length, demo: true })
    }
    return fail(501, `尚未预置的演示接口：${method} ${path}；已阻止访问任何真实后端。`)
  }
  return { fetch: fetchMock, requests, get state() { return state }, save, record,
    reset() { for (const c of controllers.values()) c.abort(); state = freshState(); save() },
    configure(changes) { Object.assign(state.settings, changes); save() },
    scenarios: SCENARIOS, outputSchema: OUTPUT_SCHEMA }
}

export function installOfflineRuntime(win) {
  const origin = win.location.origin
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(win.location.hostname)) throw new Error('演示包只能在本机打开')
  // A recording must not be overwritten by another open preview tab. The
  // original frontend uses localStorage; point that same API at this tab's
  // session store only in the offline bootstrap, before importing production JS.
  const fixtureStorage = win.sessionStorage || win.localStorage
  if (win.sessionStorage) Object.defineProperty(win, 'localStorage', { configurable: true, value: fixtureStorage })
  const runtime = createRuntime({ storage: fixtureStorage, origin })
  win.fetch = runtime.fetch
  const block = () => { throw new DOMException('离线演示禁止网络连接', 'SecurityError') }
  for (const key of ['WebSocket', 'EventSource', 'XMLHttpRequest', 'RTCPeerConnection', 'webkitRTCPeerConnection']) {
    try { Object.defineProperty(win, key, { configurable: true, value: class { constructor() { block() } } }) } catch { /* CSP also denies all connections */ }
  }
  try { Object.defineProperty(win.navigator, 'sendBeacon', { configurable: true, value: () => false }) } catch { /* CSP fallback */ }
  // Do not let production speech fallbacks contact a remote TTS service.
  if (win.speechSynthesis) {
    try { win.speechSynthesis.speak = () => {}; win.speechSynthesis.cancel = () => {} } catch { /* no microphone permission is granted */ }
  }
  win.addEventListener('click', event => {
    const link = event.composedPath().find(n => n?.tagName === 'A' && n.href)
    if (link && !['blob:', 'data:'].includes(new URL(link.href).protocol) && new URL(link.href).origin !== origin) {
      event.preventDefault(); runtime.record('system', '已阻止演示页面打开外部链接')
    }
  }, true)
  return runtime
}
