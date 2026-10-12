// Dedicated origin: never overwrite a real user's conversation storage.
import { createRoot } from 'react-dom/client'
import { ChatDemo } from '../src/chat/ChatDemo'
import { api, type CanvasDocument } from '../src/api'
import type { Agent, ChatResult } from '../src/types'
import { applyTheme, DEFAULT_SETTINGS } from '../src/settings'
import '../src/styles.css'

if (location.hostname !== '127.0.0.1' || location.port !== '5192') throw new Error('Run this fixture on dedicated port 5192')
applyTheme({ ...DEFAULT_SETTINGS, theme: new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light' })
const fixtureAgents = [
  ['agent_discovery', '智能体发现助手', 'leader'],
  ['research_leader', '科研智能体协作工作台', 'leader'],
  ['travel_coordinator', '旅行规划与行程协调智能体', 'leader'],
  ['news_coordinator', '新闻研判与简报协调智能体', 'leader'],
  ['literature', '文献检索与知识综述智能体', 'partner'],
  ['travel_culture', '名胜古迹与文化导览智能体', 'partner'],
  ['news_verify', '信息来源与事实核验智能体', 'partner'],
].map(([id, name, role]) => ({ id, name, role, active: true, usage_mode: 'internal',
  aic: id === 'agent_discovery' ? 'local:agent_discovery' : `fixture:${id}`,
  registration_status: id === 'agent_discovery' ? 'local' : 'approved',
  transport: 'openai-compatible', skills: [], tools: [], health: 'online',
  description: '仅用于本地界面回归，不发起模型调用' } as Agent))
let document: CanvasDocument = { id: 'canvas-mobile-fixture', title: '跨端验证', version: 1,
  content: '# 城市文化研究\n\n此页面使用实际聊天与画布组件，数据为本地测试数据。\n\n## 研究问题\n\n移动端需要能够打开会话、大纲与协同助手。\n\n## 数据与方法\n\n验证明暗主题、执行型智能体二级菜单和编辑工具。\n\n## 证据限制\n\n这不是研究报告，不包含任何真实模型结果。', revisions: [] }
const compat = new URLSearchParams(location.search).get('compat') === '1'
api.agents = async () => fixtureAgents
api.chatConfig = async () => ({ interop_compatibility: compat, default_coordinator_id: 'research_leader' })
api.getSessionCanvas = async () => document
api.getActiveTask = async () => ({ active: false })
const activity = new URLSearchParams(location.search).get('activity') === '1'
const longOutput = JSON.stringify({ sources: [{ title: '本地测试：超长工具回传',
  url: 'https://example.org/research/' + 'long-unbroken-path-'.repeat(24), snippet: '这只是界面回归样例，不是已核实证据。'.repeat(12) }] })
const activityResults = [{ invocation_id: 'fixture-turn-1', session_id: 'fixture-session', status: 'completed', answer: '样例任务已完成',
  selected_agent: fixtureAgents[1], candidates: [], failover_count: 0, latency_ms: 5000, usage: {}, result_data: {
    collaborations: [1, 2].map(i => ({ task_id: `fixture-task-${i}`, invocation_id: 'fixture-turn-1', session_id: 'fixture-session',
      agent_id: 'literature', agent_name: '文献检索与知识综述智能体', task: `第 ${i} 次任务：验证重复派发与超长回传。`,
      status: 'completed', result: '本地样例成果；不会调用真实模型。',
      tools: [{ id: `fixture-tool-${i}`, name: 'web_search', arguments: { query: 'Chain-of-Thought Prompting Elicits Reasoning in Large Language Models' },
        status: 'completed', output_preview: longOutput }] })),
    runtime_tools: [{ id: 'fixture-root-tool', name: 'dispatch_task', arguments: { task: '本地样例' }, status: 'completed', output_preview: longOutput }],
  } }, { invocation_id: 'fixture-turn-2', session_id: 'fixture-session', status: 'completed', answer: '本轮没有派发；上轮协作记录仍可查看。',
    selected_agent: fixtureAgents[1], candidates: [], failover_count: 0, latency_ms: 10, usage: {}, result_data: {} }] as ChatResult[]
api.sessionActivity = async (session) => ({ session_id: session, items: activity && session === 'fixture-session' ? activityResults : [], next_before: null })
api.updateSessionCanvas = async (_session, content) => { document = { ...document, content, version: document.version + 1 }; return document }
api.chatStream = async () => { throw new Error('本地界面验证不运行模型') }
const conversation = { id: 'mobile-fixture', title: '跨端验证', session: 'fixture-session', agentId: 'agent_discovery',
  messages: activity ? [{ id: 'fixture-last-message', role: 'assistant', text: activityResults[1].answer, result: activityResults[1] }] : [], isCanvas: true }
localStorage.setItem('aegismesh-conversations-index', JSON.stringify([conversation]))
localStorage.setItem('aegismesh-conv-mobile-fixture', JSON.stringify(conversation))
createRoot(window.document.getElementById('root')!).render(<ChatDemo onComplete={async () => {}} />)
