import { createRoot } from 'react-dom/client'
import { ChatDemo } from '../src/chat/ChatDemo'
import { api } from '../src/api'
import type { Agent, ChatResult } from '../src/types'
import { conversationStorage, setConversationOwner } from '../src/conversationStorage'
import { applyTheme, DEFAULT_SETTINGS } from '../src/settings'
import '../src/styles.css'

// All API traffic is intercepted. This fixture cannot use production accounts/models.
if (location.hostname !== '127.0.0.1' || location.port !== '5197') throw new Error('Use dedicated fixture port 5197')
const query = new URLSearchParams(location.search)
applyTheme({ ...DEFAULT_SETTINGS, theme: query.get('theme') === 'dark' ? 'dark' : 'light' })
setConversationOwner('history-layout-fixture')
window.fetch = async input => {
  if (String(input).startsWith('/api/account/history')) return Response.json({ detail: 'Fixture uses local history' }, { status: 404 })
  if (String(input) === '/api/account/config') return Response.json({ enabled: false, quota_mode: 'off', providers: [] })
  if (String(input) === '/api/account/me') return Response.json({ owner_id: 'history-layout-fixture', account: null })
  throw new Error('Live requests are blocked: ' + String(input))
}
const agents = [{ id: 'research_leader', name: '科研智能体协作工作台', active: true, role: 'leader',
  usage_mode: 'internal', health: 'online', skills: [], tools: [], description: '隔离样例' }] as Agent[]
const result: ChatResult = { invocation_id: 'fixture-result', session_id: 'history-layout-session', status: 'completed',
  answer: '本地回归：协作结果已保留。', selected_agent: agents[0], candidates: [], failover_count: 0, latency_ms: 111600,
  usage: { llm_calls: 0, prompt_tokens: 0, completion_tokens: 0 }, result_data: {
    collaborations: [{ task_id: 'fixture-child', session_id: 'history-layout-session', invocation_id: 'fixture-result',
      agent_id: 'docs_overview', agent_name: '文献检索与知识综述智能体', caller_id: 'research_leader',
      call_chain: ['research_leader', 'docs_overview'], task: '围绕「大模型多智能体协作」梳理证据材料。',
      status: 'completed', phase_name: '任务已完成', tokens_per_second: 3867.4, latency_ms: 111600,
      result: '本地样例，不包含真实研究结果。' }],
  } }
const conversation = { id: 'history-layout-main', title: '针对大模型多智能体协作开展系统研究与文献梳理',
  session: result.session_id, agentId: agents[0].id, updatedAt: Date.now() - 10 * 86400000,
  messages: [{ role: 'user', text: '针对大模型多智能体协作开展系统研究与文献梳理' },
    { role: 'assistant', text: result.answer, result }] }
const other = { id: 'history-layout-other', title: '这个智能体有没有公开可调用的接口', session: 'history-other',
  agentId: agents[0].id, updatedAt: Date.now(), messages: [] }
conversationStorage.setItem('aegismesh-conversations-index', JSON.stringify([conversation, other]))
for (const item of [conversation, other]) conversationStorage.setItem(`aegismesh-conv-${item.id}`, JSON.stringify(item))
api.agents = async () => agents
api.chatConfig = async () => ({ interop_compatibility: false, default_coordinator_id: agents[0].id })
api.getActiveTask = async () => ({ active: false })
api.sessionActivity = async session => ({ session_id: session, items: session === result.session_id ? [result] : [], next_before: null })
api.cancelTask = async () => ({ ok: true })
api.chatStream = async (_message, session, _agent, onDelta, _onEvent, signal, onTaskId) => {
  onTaskId?.('fixture-stream')
  return new Promise((resolve, reject) => {
    let count = 0
    const timer = setInterval(() => {
      onDelta('测试片段。')
      if (++count === 240) { clearInterval(timer); resolve({ ...result, session_id: session!, invocation_id: 'fixture-stream' }) }
    }, 100)
    signal?.addEventListener('abort', () => { clearInterval(timer); reject(new DOMException('Cancelled', 'AbortError')) }, { once: true })
  })
}
createRoot(document.getElementById('root')!).render(<ChatDemo onComplete={async () => {}} />)

// Browser-readable evidence of DOM stability while the real streaming UI updates.
const report = document.createElement('output')
report.id = 'history-stability-report'
report.hidden = true
document.body.append(report)
let tracked: Element | null = null, remounts = 0, samples = 0, firstY = 0, maxDrift = 0
setInterval(() => {
  const row = document.querySelector('.history-item.is-running')
  if (!row) return
  const y = row.getBoundingClientRect().y
  if (!tracked) { tracked = row; firstY = y }
  else if (tracked !== row) { remounts++; tracked = row }
  maxDrift = Math.max(maxDrift, Math.abs(firstY - y))
  report.textContent = JSON.stringify({ samples: ++samples, remounts, maxDrift,
    group: row.closest('.history-group')?.querySelector('.history-group-label')?.textContent })
}, 80)
