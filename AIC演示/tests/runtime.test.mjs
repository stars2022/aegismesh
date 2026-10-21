import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRuntime, installOfflineRuntime } from '../dist/demo/runtime.mjs'
import { STORE_KEY } from '../dist/demo/fixtures.mjs'

function setup(options = {}) {
  const memory = new Map()
  const storage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) }
  const runtime = createRuntime({ storage, timeScale: 0, ...options })
  const call = async (path, body, method = body ? 'POST' : 'GET') => {
    const response = await runtime.fetch(path, { method, body: body && JSON.stringify(body) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() }
  }
  return { runtime, call, storage }
}

test('every production JS/CSS/media asset is byte-for-byte unchanged', async () => {
  const manifest = JSON.parse(await readFile(new URL('../dist/demo/production-manifest.json', import.meta.url)))
  assert.equal(manifest.production_commit, '552bee014aad859b9b49cd38dd3ef03d47dbd5e8')
  assert.equal(Object.keys(manifest.assets).length, 32)
  for (const [path, hash] of Object.entries(manifest.assets)) {
    assert.equal(createHash('sha256').update(await readFile(new URL('../dist/' + path, import.meta.url))).digest('hex'), hash, path)
  }
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8')
  assert.match(html, /data-production-entry="\/assets\/index-xVoQ6-60.js"/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.match(html, /\/demo\/bootstrap.mjs/)
  const css = await readFile(new URL('../dist/demo/fonts/fonts.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /https?:\/\//)
  assert.match(css, /Noto Sans SC/)
})
test('sessions, accounts and admin start with isolated fixture identities', async () => {
  const { call } = setup()
  assert.equal((await call('/api/demo/session')).data.owner_id, 'account_demo_owner')
  assert.equal((await call('/api/admin/session')).data.authenticated, true)
  assert.equal((await call('/api/account/me')).data.account.email, 'owner@example.invalid')
  assert.equal((await call('/api/account/config')).data.turnstile.enabled, false)
  const { data } = await call('/api/admin/accounts/users?page=1&page_size=20')
  assert.equal(data.total, 2)
})
test('no API can fall through to production or an external origin', async () => {
  const { runtime, call } = setup()
  assert.equal((await runtime.fetch('https://demmo.cc.cd/api/agents')).status, 451)
  assert.equal((await runtime.fetch('https://api.deepseek.com/chat/completions')).status, 451)
  assert.equal((await call('/api/unimplemented')).status, 501)
  assert.equal((await runtime.fetch('/not-an-api')).status, 451)
})
test('native socket, XHR, peer and beacon transports fail closed', () => {
  const { storage } = setup()
  const win = { location: new URL('http://127.0.0.1:5610/'), localStorage: storage, navigator: {}, addEventListener() {} }
  installOfflineRuntime(win)
  for (const key of ['WebSocket', 'EventSource', 'XMLHttpRequest', 'RTCPeerConnection']) assert.throws(() => new win[key]('https://anything.invalid'), { name: 'SecurityError' })
  assert.equal(win.navigator.sendBeacon('/api/chat', 'x'), false)
  assert.throws(() => installOfflineRuntime({ location: new URL('https://demmo.cc.cd/') }), /只能在本机/)
})
test('browser fixtures and original history use per-tab session storage across navigation', async () => {
  const makeStorage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) } }
  const sharedLocal = makeStorage(), firstSession = makeStorage(), secondSession = makeStorage()
  const makeWindow = sessionStorage => ({ location: new URL('http://127.0.0.1:5610/'), localStorage: sharedLocal, sessionStorage, navigator: {}, addEventListener() {} })
  const firstWindow = makeWindow(firstSession)
  const first = installOfflineRuntime(firstWindow)
  await first.fetch('/api/agents', { method: 'POST', body: JSON.stringify({ id: 'recording-only', name: '录制智能体' }) })
  assert.equal(firstWindow.localStorage, firstSession)
  assert.equal(sharedLocal.getItem(STORE_KEY), null)
  const afterNavigation = installOfflineRuntime(makeWindow(firstSession))
  assert.ok(afterNavigation.state.agents.some(a => a.id === 'recording-only'))
  const second = installOfflineRuntime(makeWindow(secondSession))
  assert.equal(second.state.agents.some(a => a.id === 'recording-only'), false)
  second.reset()
  assert.ok(afterNavigation.state.agents.some(a => a.id === 'recording-only'))
})
test('AI draft, manual CRUD, registration, review and certificate share real API contracts', async () => {
  const { call } = setup()
  const draft = (await call('/api/admin/agent-designer/generate', { requirements: '政策研究', provider_id: 'demo-deepseek' })).data.draft
  assert.equal(draft.id, 'policy_research_assistant')
  assert.equal((await call('/api/agents', draft)).status, 200)
  assert.equal((await call('/api/agents', draft)).status, 409)
  assert.equal((await call('/api/agents/' + draft.id + '/acs-preview')).data.acs.demo, true)
  assert.equal((await call('/api/agents/' + draft.id + '/registration', {})).data.registration_status, 'pending')
  assert.equal((await call('/api/agents/' + draft.id + '/registration/sync', {})).data.registration_status, 'approved')
  assert.match((await call('/api/agents/' + draft.id + '/certificate', {})).data.keyPath, /^demo:\/\//)
  assert.equal((await call('/api/agents/' + draft.id, { active: false }, 'PATCH')).data.active, false)
  assert.equal((await call('/api/agents/' + draft.id, null, 'DELETE')).status, 204)
})
test('discovery imports a preset without contacting ADP', async () => {
  const { call } = setup()
  const feed = (await call('/api/discovery/feed?query=政策')).data
  assert.equal(feed.length, 1)
  const item = feed[0]
  const imported = (await call('/api/discovery/import', { aic: item.aic, name: item.name, skills: item.skills, streaming: true, endpoint: item.endpoint_url })).data
  assert.equal(imported.registration_status, 'imported')
  assert.match(imported.endpoint_url, /demo\.invalid/)
})
test('newly created agent is directly usable with one explicit selected candidate', async () => {
  const { call } = setup()
  const draft = (await call('/api/admin/agent-designer/generate', { requirements: '新能源政策研究' })).data.draft
  await call('/api/agents', draft)
  await call('/api/agents/' + draft.id + '/registration', {})
  await call('/api/agents/' + draft.id + '/registration/sync', {})
  const result = (await call('/api/demo/chat', { agent_id: draft.id, message: '新能源政策研究报告' })).data
  assert.equal(result.selected_agent.id, draft.id)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].score, 1)
  assert.equal(result.result_data.collaborations.length, 0)
  assert.match(result.answer, /适用地区/)
})
test('SSE produces genuine production event shapes, collaboration, final result and durable activity', async () => {
  const { runtime, call } = setup()
  const response = await runtime.fetch('/api/demo/chat/stream', { method: 'POST', body: JSON.stringify({ session_id: 'recording-session', message: '多智能体协作研究', agent_id: 'research_leader', structured_io: true }) })
  const text = await response.text()
  assert.match(response.headers.get('X-Task-Id'), /^demo-task-/)
  const frames = text.trim().split('\n\n').map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)))
  for (const event of ['status', 'subagent_start', 'subagent_tool', 'subagent_tool_done', 'subagent_complete', 'blackboard_message', 'delta', 'result']) assert.ok(frames.some(frame => frame.type === event), event)
  const result = frames.at(-1).data
  assert.equal(result.result_data.collaborations.length, 2)
  assert.equal(result.result_data.demo, true)
  assert.equal(result.structured_output.findings.length, 2)
  assert.equal((await call('/api/chat/sessions/recording-session/activity')).data.items.length, 1)
  assert.equal((await call('/api/invocations')).data.length, 1)
  assert.equal((await call('/api/dashboard')).data.requests, 1)
  assert.equal((await call('/api/dashboard')).data.success_rate, 100)
  assert.equal((await call('/api/demo/tasks/active?session_id=recording-session')).data.active, false)
})
test('bounty, MQ receipts, canvas revision CAS and group messages are all local', async () => {
  const { runtime, call } = setup()
  runtime.configure({ channel: 'mq' })
  const result = (await call('/api/demo/chat', { message: '研究综述', session_id: 'canvas-session', mode: 'bounty', canvas: true })).data
  assert.equal(result.result_data.transport, 'AMQPS')
  assert.equal(result.result_data.bounty.items.length, 2)
  const first = (await call('/api/canvas/session/canvas-session')).data
  assert.equal((await call('/api/canvas/session/canvas-session', { content: '# 修改后', base_version: first.version }, 'PUT')).data.version, 2)
  assert.equal((await call('/api/canvas/session/canvas-session', { content: '冲突', base_version: 0 }, 'PUT')).status, 409)
  const group = (await call('/api/group-chat', { name: '组会讨论', members: ['docs_overview'] })).data
  assert.equal((await call('/api/group-chat/' + group.id + '/messages', { text: '研究资料' })).data.agent_id, 'docs_overview')
  const logs = (await call('/api/admin/logs?origin=amp')).data.items
  assert.ok(logs.some(log => log.kind === 'message'))
})
test('history supports create, CAS conflict, deletion and recovery without cross-account data', async () => {
  const { call } = setup()
  const conversation = { id: 'local-1', session: 's1', title: '研究', agentId: 'research_leader', messages: [], queue: [], updatedAt: Date.now() }
  assert.equal((await call('/api/account/history/s1')).status, 404)
  assert.equal((await call('/api/account/history/s1', { revision: 0, conversation }, 'PUT')).data.revision, 1)
  assert.equal((await call('/api/account/history/s1', { revision: 0, conversation }, 'PUT')).status, 409)
  assert.equal((await call('/api/account/history')).data.items.length, 1)
  await call('/api/account/history/s1', null, 'DELETE')
  assert.equal((await call('/api/account/history/s1')).status, 410)
  await call('/api/account/history/s1/restore', {})
  assert.equal((await call('/api/account/history/s1')).status, 200)
})
test('user and agent hosted groups hand off only to members and stop after bounded replies', async () => {
  const { runtime, call } = setup()
  for (const host of [undefined, 'research_leader']) {
    const group = (await call('/api/group-chat', { name: '研究讨论', host_agent_id: host, members: ['research_leader', 'docs_overview', 'peer_review'] })).data
    const first = (await call(`/api/group-chat/${group.id}/messages`, { text: '科研证据与复核', mentioned: host || 'docs_overview' })).data
    assert.match(first.reply, /```blackboard:/)
    assert.match(first.reply, host ? /@文献检索与知识综述智能体/ : /@研究方法与同行评审智能体/)
    const second = (await call(`/api/group-chat/${group.id}/messages`, { text: '群内继续讨论：请回应', mentioned: host ? 'docs_overview' : 'peer_review' })).data
    const final = host ? (await call(`/api/group-chat/${group.id}/messages`, { text: '群内继续讨论：请回应', mentioned: 'peer_review' })).data : second
    assert.doesNotMatch(final.reply, /@/)
    assert.equal(final.agent_id, 'peer_review')
  }
  assert.equal(runtime.state.logs.filter(row => row.kind === 'message').length, 5)
})
test('a second shared canvas instruction creates a distinct reviewable revision', async () => {
  const { call } = setup()
  await call('/api/demo/chat', { message: '多智能体研究', session_id: 'canvas-multi', canvas: true })
  const first = (await call('/api/canvas/session/canvas-multi')).data
  await call('/api/demo/chat', { message: '补充验收与复核表', session_id: 'canvas-multi', canvas: true })
  const second = (await call('/api/canvas/session/canvas-multi')).data
  assert.equal(second.version, first.version + 1)
  assert.notEqual(second.content, first.content)
  assert.match(second.content, /验收与复核/)
})
test('cancelling a stream never manufactures a completed invocation', async () => {
  const { runtime } = setup({ timeScale: 0.01 })
  const controller = new AbortController()
  const response = await runtime.fetch('/api/demo/chat/stream', { method: 'POST', body: JSON.stringify({ message: '科研', session_id: 'stop' }), signal: controller.signal })
  controller.abort()
  await assert.rejects(response.text(), { name: 'AbortError' })
  assert.equal(runtime.state.traces.length, 0)
  assert.equal(Object.values(runtime.state.tasks)[0].status, 'cancelled')
})
test('persisted fixtures reload, corrupted fixtures reset, and reset affects demo state only', async () => {
  const { runtime, call, storage } = setup()
  await call('/api/agents/research_leader', { name: '本地改名' }, 'PATCH')
  const restored = createRuntime({ storage })
  assert.equal(restored.state.agents[0].name, '本地改名')
  storage.setItem('unrelated', 'preserved')
  restored.reset()
  assert.equal(storage.getItem('unrelated'), 'preserved')
  assert.equal(restored.state.agents[0].name, '科研智能体协作工作台')
  storage.setItem(STORE_KEY, 'bad-json')
  assert.equal(createRuntime({ storage }).state.version, 2)
})
