// Local-only UI contract fixture. No LLM, external agent or account request leaves this page.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import DigitalHuman from '../src/DigitalHuman'
import '../src/styles.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light'
// Deterministic local speech UI checks, with no audio or network synthesis.
if (params.get('voice') === 'fixture') {
  const events = new EventTarget()
  let spokenTimer: ReturnType<typeof setTimeout> | undefined
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class {
    text: string
    constructor(text: string) { this.text = text }
  } })
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    getVoices: () => [{ name: '本地测试音色', voiceURI: 'fixture-local-zh', lang: 'zh-CN', localService: true, default: true }],
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    cancel: () => clearTimeout(spokenTimer),
    speak: (utterance: SpeechSynthesisUtterance) => {
      spokenTimer = setTimeout(() => { utterance.onstart?.call(utterance, new Event('start') as SpeechSynthesisEvent) }, 20)
    },
  } })
}
type Task = { id: string; session: string; until: number; stopped?: boolean }
const fixtureKey = 'digital-human-isolated-task'
const cancelSubscribers = new Set<() => void>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const readTask = (): Task | null => { try { return JSON.parse(sessionStorage.getItem(fixtureKey) || 'null') } catch { return null } }
const finalReply = '可以的。我们先把出行安排得轻松一些。\n\n建议一天只安排一到两个主要景点，中间留足休息时间；餐厅优先选交通方便、口味清淡的。\n\n**您从哪座城市出发，打算玩几天？** 告诉我预算和父母的步行习惯，我再帮您细化路线。\n\n*这是隔离预览的示例答复，不是实时旅行推荐。*' + (params.get('long') === '1' ? '\n\n' + Array.from({length:20}, (_, i) => `### 阅读检查 ${i + 1}\n\n这一段用于检查大字、长内容滚动和新答复提示，不应把正在阅读旧消息的人强行拉到底部。`).join('\n\n') : '')
function stream(task: Task, signal?: AbortSignal | null) {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setTimeout>
  let detach = () => {}
  const body = new ReadableStream({
    start(controller) {
      const write = (value: unknown, index: number) => controller.enqueue(encoder.encode(`id: ${index}\ndata: ${JSON.stringify(value)}\n\n`))
      write({ type: 'status', data: { task_id: task.id } }, 0)
      write({ type: 'event', data: { event_type: 'DISPATCH_STARTED', agent: 'INTERNAL_TEST_AGENT', tool: 'dispatch_task' } }, 1)
      write({ type: 'delta', text: 'INTERNAL_TEST_DELTA 工具调用过程不应展示' }, 2)
      const abort = () => { clearTimeout(timer); detach(); try { controller.error(new DOMException('aborted', 'AbortError')) } catch {} }
      signal?.addEventListener('abort', abort, { once: true })
      const onCancel = () => { clearTimeout(timer); write({ type: 'error', message: '任务已被用户取消' }, 3); controller.close(); detach() }
      cancelSubscribers.add(onCancel)
      detach = () => { signal?.removeEventListener('abort', abort); cancelSubscribers.delete(onCancel) }
      timer = setTimeout(() => {
        if (params.get('failure') === '1') write({ type: 'error', message: 'mTLS internal tool dispatch_task failure' }, 3)
        else write({ type: 'result', data: { invocation_id: task.id, session_id: params.get('mismatch') === '1' ? 'human-other' : task.session, status: 'completed', answer: finalReply, result_data: { tool_executions: [{ name: 'INTERNAL_TEST_TOOL' }] } } }, 3)
        controller.close(); detach()
      }, Math.max(50, task.until - Date.now()))
    },
    cancel() { clearTimeout(timer); detach() },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'X-Task-Id': task.id } })
}
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.origin)
  if (path.pathname === '/api/account/config') return json({enabled:params.get('account') !== 'off',email_enabled:true,email_registration_ready:true,quota_mode:params.get('quota') || 'off',providers:[]})
  if (path.pathname === '/api/account/me') return json({owner_id:'guest_human_fixture',account:params.get('account') === 'signed-in' ? {id:'fixture',display_name:'张老师',email:'professor@example.test',role:'member'} : null,identities:[],quota:{mode:'off',tasks:{used:0,reserved:0,limit:20},concurrency:{used:0,reserved:0,limit:2},upload_bytes:{used:0,reserved:0,limit:100000000},note:''}})
  if (path.pathname === '/api/account/sessions') return json([{id:'fixture-session',current:true,created_at:'2026-09-30T00:00:00Z'}])
  if (path.pathname === '/api/demo/chat/stream' && init?.method === 'POST') {
    const payload = JSON.parse(String(init.body))
    if (payload.presentation !== 'assistant' || payload.mode !== 'collaborate') return json({ detail: 'assistant contract mismatch' }, 422)
    const delay = Math.min(10000, Math.max(200, Number(params.get('delay')) || 1800))
    const task = { id: crypto.randomUUID(), session: payload.session_id, until: Date.now() + (params.get('slow') === '1' ? 120000 : delay) }
    sessionStorage.setItem(fixtureKey, JSON.stringify(task))
    return stream(task, init.signal)
  }
  const task = readTask()
  if (path.pathname === '/api/demo/tasks/active') return json({ active: !!task && !task.stopped && task.until > Date.now(), task: task && task.session === path.searchParams.get('session_id') && !task.stopped ? { task_id: task.id } : null })
  if (task && path.pathname === `/api/demo/tasks/${task.id}/stream`) return stream(task, init?.signal)
  if (task && path.pathname === `/api/demo/tasks/${task.id}/cancel`) { sessionStorage.setItem(fixtureKey, JSON.stringify({ ...task, stopped: true })); for (const notify of cancelSubscribers) notify(); return json({ ok: true }) }
  return json({ detail: 'isolated preview: no real request allowed' }, 503)
}
const root = createRoot(document.getElementById('root')!)
root.render(<StrictMode><DigitalHuman ownerId={params.get('owner') === 'other' ? 'guest_human_other_fixture' : 'guest_human_fixture'}/></StrictMode>)
import.meta.hot?.dispose(() => root.unmount())
