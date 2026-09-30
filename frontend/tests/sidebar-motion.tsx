// Real chat/canvas components, isolated owner + origin, and no live API calls.
import { createRoot } from 'react-dom/client'
import { ChatDemo } from '../src/App'
import { api, type CanvasDocument } from '../src/api'
import { setConversationOwner, conversationStorage } from '../src/conversationStorage'
import { applyTheme, DEFAULT_SETTINGS } from '../src/settings'
import type { Agent } from '../src/types'
import '../src/styles.css'

if (location.hostname !== '127.0.0.1' || location.port !== '5197') throw new Error('Use dedicated fixture port 5197')
const query = new URLSearchParams(location.search)
// Exercise real account/settings UI without sending credentials to any server.
const signedIn = query.get('account') === 'signed-in'
const accountsEnabled = query.get('account') !== 'off'
const mockConfig = { enabled: accountsEnabled, email_enabled: accountsEnabled, email_registration_ready: true, quota_mode: query.get('quota') || 'off', providers: [] }
const mockMe = { owner_id: 'sidebar-motion-fixture', account: signedIn ? { id: 'fixture-owner', display_name: 'stars', email: 'demo@example.test' } : null, identities: [],
  quota: { mode: mockConfig.quota_mode, tasks: { used: 0, reserved: 0, limit: 100 }, concurrency: { used: 0, reserved: 0, limit: 3 }, upload_bytes: { used: 0, reserved: 0, limit: 104857600 }, note: '本地隔离样例' } }
window.fetch = async (input, init) => {
  const path = String(input)
  if (init?.method && init.method !== 'GET') throw new Error('Fixture must not modify accounts')
  if (path === '/api/account/config') return Response.json(mockConfig)
  if (path === '/api/account/me') return Response.json(mockMe)
  if (path === '/api/account/sessions') return Response.json([{ id: 'fixture-session', current: true, created_at: '2026-09-30T00:00:00Z' }])
  throw new Error('Sidebar fixture must not use live APIs: ' + path)
}
applyTheme({ ...DEFAULT_SETTINGS, theme: query.get('theme') === 'dark' ? 'dark' : 'light' })
setConversationOwner('sidebar-motion-fixture')
const conversation = { id: 'sidebar-motion', title: '侧栏动效验证', session: 'sidebar-motion-session',
  isCanvas: query.get('mode') === 'canvas', messages: [], agentId: 'fixture-leader',
  queue: query.has('queue') ? [
    { id: 'queue-first', text: '请继续补充研究背景', agentId: 'fixture-leader' },
    { id: 'queue-second', text: '整理并核实参考文献来源，保留长文本的省略和所有队列操作', agentId: 'fixture-leader' },
  ] : [] }
conversationStorage.setItem('aegismesh-conversations-index', JSON.stringify([conversation]))
conversationStorage.setItem('aegismesh-conv-sidebar-motion', JSON.stringify(conversation))
const agents = [{ id: 'fixture-leader', name: '科研协作测试', role: 'leader', active: true,
  usage_mode: 'internal', health: 'online', skills: [], tools: [], description: '本地 UI 样例' }] as Agent[]
api.agents = async () => agents
api.chatConfig = async () => ({ interop_compatibility: false, default_coordinator_id: 'fixture-leader' })
api.getActiveTask = async () => ({ active: false })
api.sessionActivity = async session => ({ session_id: session, items: [], next_before: null })
let canvas: CanvasDocument = { id: 'sidebar-motion-canvas', title: '侧栏动效验证', version: 1,
  content: '# 侧栏动效验证\n\n这里是隔离的本地样例，不会调用模型或修改服务器数据。\n\n## 检查项\n\n快速来回切换左右侧栏，文字不挤压，按钮不丢失。', revisions: [] }
api.getSessionCanvas = async () => canvas
api.updateSessionCanvas = async (_session, content) => (canvas = { ...canvas, content, version: canvas.version + 1 })
createRoot(document.getElementById('root')!).render(<ChatDemo onComplete={async () => {}} />)

// Read-only instrumentation of real clicks: catches first-frame jumps,
// content reflow, control replacement and delayed motion under Reduce Motion.
const report = document.createElement('output')
report.id = 'motion-report'
report.setAttribute('aria-label', '侧栏动效测量')
report.style.cssText = 'position:fixed;bottom:4px;left:50%;transform:translateX(-50%);z-index:200;max-width:90vw;pointer-events:none;font:10px monospace;background:var(--paper);color:var(--muted)'
report.textContent = '点击左右侧栏按钮以检查动效'
document.body.append(report)
let measurement = 0
document.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('.chat-side-toggle')
  if (!button) return
  const run = ++measurement
  const panel = document.getElementById(button.getAttribute('aria-controls') || '')!
  const stage = document.querySelector('.chat-stage, .canvas-wysiwyg')!
  const start = performance.now()
  const samples: { x: number; width: number; stageWidth: number }[] = []
  const sample = () => {
    if (run !== measurement) return
    const rect = panel.getBoundingClientRect()
    samples.push({ x: rect.x, width: rect.width, stageWidth: stage.getBoundingClientRect().width })
    if (performance.now() - start < 360) { requestAnimationFrame(sample); return }
    const spread = (field: keyof typeof samples[number]) => Math.max(...samples.map(s => s[field])) - Math.min(...samples.map(s => s[field]))
    const intermediate = new Set(samples.map(s => s.x.toFixed(1))).size
    report.textContent = JSON.stringify({ side: button.dataset.side, frames: samples.length,
      positions: intermediate, contentWidthDrift: +spread('width').toFixed(2),
      stageWidthChange: +spread('stageWidth').toFixed(2), sameButton: button.isConnected,
      expanded: button.getAttribute('aria-expanded'), inert: panel.inert,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches })
  }
  sample()
}, true)
