// Isolated UI regression: synthetic microphone, silent PCM, local SSE. No real credentials or calls.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import DigitalHuman from '../src/DigitalHuman'
import '../src/styles.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark'
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const metrics = { microphoneStarts: 0, microphoneStops: 0, turns: 0, interrupted: 0, recognizers: 0 }
let gain: GainNode | null = null
let transcript = ''
let recognition: FixtureRecognition | null = null
const controls = document.createElement('div')
controls.style.cssText = 'position:fixed;bottom:4px;left:4px;z-index:10000;background:#fff;color:#111;padding:8px;border:1px solid #888;border-radius:8px;font:12px sans-serif;display:flex;gap:8px;align-items:center;max-width:98vw;flex-wrap:wrap'
controls.setAttribute('aria-label', '隔离回归控制，不产生真实调用')
const counts = document.createElement('span')
const label = document.createElement('span'); label.textContent = '本地回归测试（无真实调用）'; controls.append(label)
const showMetrics = () => { counts.textContent = `麦克风开启 ${metrics.microphoneStarts} · 释放 ${metrics.microphoneStops} · 回答 ${metrics.turns} · 中断 ${metrics.interrupted} · 浏览器识别 ${metrics.recognizers}` }
controls.append(counts)

class FixtureRecognition {
  onresult: ((event: unknown) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  start() { recognition = this; metrics.recognizers++; showMetrics() }
  stop() { this.onend?.() }
  abort() { if (recognition === this) recognition = null; this.onend?.() }
}
Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FixtureRecognition })
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
  metrics.microphoneStarts++; showMetrics()
  const ctx = new AudioContext()
  await ctx.resume()
  const target = ctx.createMediaStreamDestination()
  const oscillator = ctx.createOscillator(); oscillator.frequency.value = 240
  gain = ctx.createGain(); gain.gain.value = 0
  oscillator.connect(gain); gain.connect(target); oscillator.start()
  const track = target.stream.getAudioTracks()[0]
  const originalStop = track.stop.bind(track)
  track.stop = () => {
    if (track.readyState === 'ended') return
    originalStop(); oscillator.stop(); gain = null; void ctx.close()
    metrics.microphoneStops++; showMetrics()
  }
  return target.stream
} })

for (const [label, text] of [['说第一个问题', '请解释AIC与ACS'], ['语音插话', '说简单一点'], ['安排后台协作', '请安排后台协作']]) {
  const button = document.createElement('button'); button.textContent = label
  button.onclick = () => {
    transcript = text
    if (params.get('asr') === 'browser') {
      recognition?.onresult?.({ results: [{ isFinal: true, 0: { transcript: text } }] })
      recognition?.onend?.()
    } else if (gain) {
      const current = gain; current.gain.value = .12
      setTimeout(() => { current.gain.value = 0 }, 550)
    }
  }
  controls.append(button)
}
// Diagnostic controls are opt-in and never appear in clean recording previews.
if (params.get('debug') === '1') document.body.append(controls)
showMetrics()
const encoder = new TextEncoder()
function sse(events: [number, string, unknown][], signal?: AbortSignal | null) {
  const timers: ReturnType<typeof setTimeout>[] = []
  let detached = () => {}
  const stream = new ReadableStream({
    start(controller) {
      const abort = () => { timers.forEach(clearTimeout); metrics.interrupted++; showMetrics(); detached(); controller.error(new DOMException('Aborted', 'AbortError')) }
      signal?.addEventListener('abort', abort, { once: true })
      detached = () => signal?.removeEventListener('abort', abort)
      events.forEach(([ms, name, data], index) => timers.push(setTimeout(() => {
        controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`))
        if (index === events.length - 1) { detached(); controller.close() }
      }, ms)))
    },
    cancel() { timers.forEach(clearTimeout); detached() },
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
}
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin)
  if (url.origin !== location.origin) throw new Error('隔离测试禁止外部请求')
  if (url.pathname === '/api/demo/digital-human/config') return json({ enabled: true, realtime_mode: true, display_name: '麦溪', greeting: '您好，请问有什么可以帮您？', tts_backend: 'deepseek', tts_voice_id: 'stella', tts_available: true, asr_backend: params.get('asr') === 'browser' ? 'browser' : 'deepseek', asr_available: true })
  if (url.pathname === '/api/demo/tasks/active') return json({ active: false, task: null })
  if (url.pathname === '/api/demo/digital-human/asr') return json({ text: transcript, duration_ms: 1200 })
  if (url.pathname === '/api/demo/digital-human/tts') {
    let timer: ReturnType<typeof setInterval>
    let detach = () => {}
    const stream = new ReadableStream({
      start(controller) {
        let chunks = 0
        const abort = () => { clearInterval(timer); detach(); controller.error(new DOMException('Aborted', 'AbortError')) }
        init?.signal?.addEventListener('abort', abort, { once: true })
        detach = () => init?.signal?.removeEventListener('abort', abort)
        timer = setInterval(() => {
          controller.enqueue(new Uint8Array(4800))
          if (++chunks >= (params.get('slow') === '1' ? 60 : 12)) { clearInterval(timer); detach(); controller.close() }
        }, 80)
      },
      cancel() { clearInterval(timer); detach() },
    })
    return new Response(stream, { headers: { 'Content-Type': 'audio/pcm', 'X-Audio-Sample-Rate': '24000' } })
  }
  if (url.pathname === '/api/demo/digital-human/realtime-chat/stream') {
    const body = JSON.parse(String(init?.body))
    metrics.turns++; showMetrics()
    if (params.get('failure') === '1') return sse([[100, 'error', { detail: '本地故障分支检查' }]], init?.signal)
    if (body.message.includes('后台') || body.message.includes('协作')) {
      const reply = '好的，后台协作已经开始，我们可以继续交流。'
      return sse([[100, 'speech', { text: reply }], [400, 'done', { reply, action: 'dispatch_task', task_prompt: body.message, task_title: '互联对照表', ui_blocks: [] }]], init?.signal)
    }
    const reply = body.message.includes('简单') ? 'AIC相当于身份，ACS说明能做什么。' : 'AIC标识智能体身份。ACS声明能力与接口。互联时还需证书认证。'
    const result = { reply, action: 'chat', ui_blocks: [] }
    return sse([[80, 'stage', { stage: '正在理解您的意图…' }], [180, 'speech', { text: reply }], [params.get('slow') === '1' ? 10000 : 1600, 'done', result]], init?.signal)
  }
  if (url.pathname === '/api/demo/chat/stream') {
    const body = JSON.parse(String(init?.body))
    return sse([
      [20, 'message', { type: 'status', data: { task_id: 'fixture-background' } }],
      [1200, 'message', { type: 'result', data: { invocation_id: 'fixture-background', session_id: body.session_id, status: 'completed', answer: 'AIC标识身份，ACS声明能力。', result_data: {} } }],
    ], init?.signal)
  }
  if (url.pathname === '/api/demo/digital-human/synthesize-ui' && params.get('ui') === 'candidates') return json({ ui_title: '候选项目', summary_speech: '候选项目已整理，请逐项查看。', ui_blocks: [
    { type: 'tabs', tabs: [{ label: '项目甲', content: '甲方案：先校验 AIC，再核验 ACS。' }, { title: '项目乙', description: '乙方案：先检索能力，再验证双向通信。', points: ['保留任务回执'] }, { label: '缺少详情' }] },
    { type: 'table', columns: [{ label: '项目', key: 'name' }, { label: '说明', key: 'detail' }], rows: [{ name: '甲', detail: '保留已有返回字段' }] },
  ] })
  if (url.pathname === '/api/demo/digital-human/synthesize-ui') return json({ ui_title: '互联对照表', summary_speech: '后台对照表已经整理完成。', ui_blocks: [{ type: 'table', columns: ['项目', '作用'], rows: [['AIC', '标识身份'], ['ACS', '声明能力']] }] })
  return json({ detail: '隔离回归：不允许未配置的请求' }, 503)
}
const root = createRoot(document.getElementById('root')!)
root.render(<StrictMode><DigitalHuman ownerId={`guest_realtime_fixture_${params.get('asr') || 'pcm'}`}/></StrictMode>)
import.meta.hot?.dispose(() => { root.unmount(); controls.remove() })
