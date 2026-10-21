// A recording remote, not a replacement application. Every scripted action below
// operates the unmodified production DOM. F8 hides all recording controls.
import { STORE_KEY, OWNER, SCENARIOS } from './fixtures.mjs'
import { delay } from './runtime.mjs'
import { RECORDING_PLAN, isRecordOnly, chapterCard } from './recording-plan.mjs'

const SCRIPT_KEY = 'aegismesh-recording-director:v2'
const visible = node => node && node.getClientRects().length && !node.closest('[hidden], [inert]')
const normalize = text => (text || '').replace(/\s+/g, '').trim()
async function until(find, description, signal, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (signal.aborted) throw signal.reason; const node = find(); if (node) return node; await delay(100, signal) }
  throw new Error(`等待超时：${description}`)
}
const buttons = (scope = document) => [...scope.querySelectorAll('button')].filter(node => visible(node) && !node.disabled)
async function press(text, signal, scope = document) {
  const button = await until(() => buttons(scope).find(n => normalize(n.textContent) === normalize(text)), `按钮「${text}」`, signal)
  button.scrollIntoView({ block: 'nearest' }); button.click(); await delay(650, signal)
}
async function selectorClick(selector, signal) {
  const node = await until(() => [...document.querySelectorAll(selector)].find(visible), selector, signal)
  node.scrollIntoView({ block: 'nearest' }); node.click(); await delay(600, signal)
}
async function fill(selector, value, signal) {
  const node = await until(() => [...document.querySelectorAll(selector)].find(visible), selector, signal)
  node.focus(); node.scrollIntoView({ block: 'nearest' })
  const setter = Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set
  setter.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); await delay(500, signal)
}
const card = name => [...document.querySelectorAll('.agent-card')].find(node => node.querySelector('h3')?.textContent === name)

export function installDirector(runtime) {
  const recordOnly = isRecordOnly(new URLSearchParams(location.search), sessionStorage)
  const host = document.createElement(recordOnly ? 'aegismesh-recording-status' : 'aegismesh-recording-controls')
  const shadow = host.attachShadow({ mode: 'open' })
  host.dataset.controlsIsolated = String(recordOnly)
  if (recordOnly) { host.hidden = true; host.style.setProperty('display', 'none', 'important') }
  shadow.innerHTML = recordOnly ? '<span id="status" hidden></span>' : `<style>
    :host{position:fixed;right:16px;top:16px;z-index:2147483647;font:13px/1.6 system-ui;color:#20211d;display:none}
    :host([open]){display:block}section{width:min(330px,calc(100vw - 48px));max-height:85vh;overflow:auto;border:1px solid #d7d8d1;border-radius:16px;padding:18px;background:#fbfbf9;box-shadow:0 18px 60px #0003}
    h2{font-size:16px;margin:0 0 5px}p{margin:0 0 12px;color:#73736b}button,select{font:inherit;border:1px solid #deded8;background:#fff;color:inherit;border-radius:9px;padding:8px 10px;cursor:pointer}
    button:disabled{opacity:.5;cursor:default}.grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:10px 0}.primary{width:100%;background:#171815;color:white;border-color:#171815}
    #status{padding:9px;background:#efefeb;border-radius:9px;margin-top:10px;white-space:pre-wrap}.row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0}small{color:#85867d}
  </style><section aria-label="离线录制控制台"><h2>录制控制台</h2><p>原版界面 · 预置数据 · 不连接真实智能体</p>
    <button class="primary" data-do="full">播放完整流程</button>
    <button data-do="first-use">使用刚注册的助手</button><button data-do="collaboration">协同方式详录</button>
    <button data-do="remaining">补录发现、访问与应用场景</button>
    <div class="grid"><button data-do="group-user">用户主持详录</button><button data-do="group-host">智能体主持详录</button><button data-do="canvas-review">画布修订详录</button><button data-do="bounty-detail">竞标验收详录</button></div>
    <div class="grid"><button data-do="create">创建与注册</button><button data-do="discovery">发现与接入</button><button data-do="research">科研协作</button><button data-do="news">新闻协作</button><button data-do="travel">出行协作</button><button data-do="bounty">竞标模式</button><button data-do="structured">结构化输出</button><button data-do="canvas">画布协作</button><button data-do="group">智能体群聊</button><button data-do="human">数字人服务厅</button><button data-do="traces">运行记录</button><button data-do="logs">日志与审计</button></div>
    <label class="row">播放速度<select id="speed"><option value="1">正常</option><option value="2">2 倍</option><option value="0.65">慢速</option></select></label>
    <label class="row">预置通道<select id="channel"><option value="https">HTTPS AIP</option><option value="mq">MQ 消息</option></select></label>
    <label class="row">按章节录制（F9 继续）<input id="paced" type="checkbox"></label>
    <div class="grid"><button data-do="stop">停止脚本</button><button data-do="hide">隐藏（F8）</button><button data-do="reset">重置演示</button><button data-do="export">导出演示记录</button></div>
    <div id="status" role="status">就绪</div><small>F8 显示 / 隐藏；Esc 停止脚本。录制视频应注明预置流程演示。</small></section>`
  host.dataset.recordingState = 'idle'
  document.body.append(host)
  const status = text => { shadow.querySelector('#status').textContent = text }
  const setting = name => shadow.querySelector('#' + name)
  if (!recordOnly) {
    setting('speed').value = String(runtime.state.settings.speed)
    setting('channel').value = runtime.state.settings.channel
    for (const name of ['speed', 'channel']) setting(name).onchange = event => runtime.configure({ [name]: name === 'speed' ? Number(event.target.value) : event.target.value })
  }
  let running = null, queue = null, resumeChapter = null
  const navigate = url => { if (location.pathname + location.search !== url) { location.assign(url); return true }; return false }
  const pause = (ms, signal) => delay(ms / runtime.state.settings.speed, signal)
  const actions = {
    async create(signal) {
      if (runtime.state.agents.some(a => a.id === 'policy_research_assistant')) { status('此智能体已在演示中创建；可重置后重录。'); return }
      await selectorClick('.agent-create-trigger', signal); await press('AI 生成', signal)
      await fill('.agent-designer-dialog textarea', '创建政策研究协作助手：检索政策原文，提取适用范围和实施时间，区分事实与推断，并返回来源。', signal)
      await pause(1200, signal); await press('生成草稿', signal)
      await until(() => document.querySelector('.builder-drawer'), '原版草稿预览', signal)
      await pause(1600, signal)
      for (let step = 0; step < 3; step++) { await press('继续', signal, document.querySelector('.builder-drawer')); await pause(1300, signal) }
      await press('保存智能体', signal, document.querySelector('.builder-drawer'))
      await until(() => card('政策研究协作助手'), '新智能体卡片', signal)
      await press('提交验证', signal, card('政策研究协作助手'))
      await pause(1800, signal); await press('确认提交审核', signal)
      await pause(1800, signal)
      await press('同步审核', signal, card('政策研究协作助手'))
      await pause(2400, signal)
      await press('签发证书', signal, card('政策研究协作助手'))
      await pause(4000, signal)
    },
    async discovery(signal) {
      await press('全网发现', signal)
      await until(() => buttons().find(n => n.title === '将该外部智能体固定到本地协作网'), 'ADP 候选卡片', signal)
      await pause(1600, signal)
      await selectorClick('button[title="将该外部智能体固定到本地协作网"]', signal)
      await pause(1200, signal); await press('全部', signal)
    },
    async send(signal, scenario = 'research', mode = 'route', canvas = false) {
      if (canvas) { await selectorClick('button[aria-label="更多会话类型"]', signal)
        const target = await until(() => buttons().find(n => n.textContent.includes('画布协作')), '画布协作入口', signal); target.click(); await pause(900, signal)
        await selectorClick('button[aria-label="展开智能协同助手"]', signal)
      } else await selectorClick('button[title="新建普通会话"]', signal)
      if (mode === 'bounty') { await selectorClick('button[title="协作方式"]', signal); await press('竞标模式', signal) }
      await fill(canvas ? 'textarea.floating-textarea' : 'textarea[aria-label="输入消息"]', SCENARIOS[scenario].question, signal)
      await pause(900, signal); await selectorClick(canvas ? 'button[title="发送指令"]' : 'button[title="发送"]', signal)
      await until(() => Object.values(runtime.state.tasks).some(t => t.status === 'running'), '任务接收', signal)
      await until(() => !Object.values(runtime.state.tasks).some(t => t.status === 'running'), '协作完成', signal, 90000)
      await pause(2200, signal)
    },
    async research(signal) { await actions.send(signal) },
    async 'research-detail'(signal) {
      await actions.send(signal)
      await press('协作', signal)
      await selectorClick('.collab-entry-row', signal)
      await selectorClick('.collab-tool-item summary', signal)
      await pause(2600, signal)
      await selectorClick('.subagent-back-btn', signal)
      const rows = [...document.querySelectorAll('.collab-entry-row')].filter(visible)
      if (rows[1]) { rows[1].click(); await pause(2600, signal); await selectorClick('.subagent-back-btn', signal) }
    },
    async 'first-use'(signal) {
      await selectorClick('button[title="新建普通会话"]', signal)
      await selectorClick('button[aria-label^="选择智能体："]', signal)
      await press('执行型智能体', signal)
      await press('政策研究协作助手', signal)
      await fill('textarea[aria-label="输入消息"]', SCENARIOS.policy.question, signal)
      await pause(1000, signal); await selectorClick('button[title="发送"]', signal)
      await until(() => Object.values(runtime.state.tasks).some(t => t.status === 'running'), '新助手接收任务', signal)
      await until(() => !Object.values(runtime.state.tasks).some(t => t.status === 'running'), '新助手完成任务', signal)
      await pause(2500, signal)
    },
    async news(signal) { await actions.send(signal, 'news') },
    async travel(signal) { await actions.send(signal, 'travel') },
    async bounty(signal) { await actions.send(signal, 'research', 'bounty') },
    async 'bounty-detail'(signal) {
      await actions.send(signal, 'research', 'bounty')
      await press('协作', signal)
      await selectorClick('.bounty-item summary', signal)
      await pause(2500, signal)
      const rows = [...document.querySelectorAll('.bounty-item summary')].filter(visible)
      if (rows[1]) { rows[1].click(); rows[1].scrollIntoView({ block: 'center' }); await pause(2500, signal) }
    },
    async structured(signal) {
      await press('结构化结果示例', signal)
      await until(() => document.querySelector('.structured-result'), '已有结构化结果', signal)
      await pause(8000, signal)
    },
    async canvas(signal) { await actions.send(signal, 'research', 'route', true) },
    async 'canvas-review'(signal) {
      await actions.send(signal, 'research', 'route', true)
      if (buttons().some(n => normalize(n.textContent) === '全部接受')) { await press('全部接受', signal); await press('完成', signal) }
      await fill('textarea.floating-textarea', '请在刚才的研究方案末尾补充验收与复核表，明确每项工作的交付物及验收方式。', signal)
      await selectorClick('button[title="发送指令"]', signal)
      await until(() => Object.values(runtime.state.tasks).some(t => t.status === 'running'), '第二轮文稿协作', signal)
      await until(() => !Object.values(runtime.state.tasks).some(t => t.status === 'running'), '文稿修订完成', signal)
      await pause(1800, signal)
      if (buttons().some(n => normalize(n.textContent) === '全部接受')) { await press('全部接受', signal); await pause(1300, signal); await press('完成', signal) }
      await pause(1800, signal)
    },
    async 'group-user'(signal) { await actions.groupFlow(signal, false) },
    async 'group-host'(signal) { await actions.groupFlow(signal, true) },
    async groupFlow(signal, hosted) {
      await selectorClick('button[aria-label="更多会话类型"]', signal)
      const target = await until(() => buttons().find(n => n.textContent.includes('智能体群聊')), '群聊入口', signal)
      target.click(); await pause(700, signal)
      await fill('input[placeholder="输入群聊名称..."]', hosted ? '协调智能体主持的研究组会' : '用户主持的文献讨论', signal)
      if (hosted) {
        const select = await until(() => document.querySelector('.group-settings-drawer select.select-host-control'), '主持人选择', signal)
        select.value = 'research_leader'; select.dispatchEvent(new Event('change', { bubbles: true })); await pause(1200, signal)
      }
      await press('创建群聊', signal)
      await fill('textarea[aria-label="输入消息"]', hosted
        ? '请主持本轮多智能体科研讨论：先检索文献，再请审查者独立复核，将交付物汇总到黑板。'
        : '@文献检索与知识综述智能体 请整理多智能体协作研究证据，然后交接同行评审专家复核。', signal)
      await selectorClick('button[title="发送"]', signal)
      await until(() => document.querySelector('button[title="发送"]'), '群聊接力结束', signal, 20000)
      await pause(2000, signal)
      const blackboard = await until(() => [...document.querySelectorAll('[role="tab"]')].find(n => n.textContent.includes('黑板')), '黑板标签页', signal)
      blackboard.click(); await pause(600, signal)
      await until(() => document.querySelector('.blackboard-panel'), '黑板交付物', signal)
      await pause(3500, signal)
      await press('成员', signal); await pause(1700, signal)
    },
    async group(signal) { await selectorClick('button[aria-label="更多会话类型"]', signal)
      const target = await until(() => buttons().find(n => n.textContent.includes('智能体群聊')), '群聊入口', signal); target.click(); await pause(800, signal)
      await fill('input[placeholder="输入群聊名称..."]', '多智能体研究讨论', signal)
      await pause(1000, signal); await press('创建群聊', signal)
      await fill('textarea[aria-label="输入消息"]', '@文献检索与知识综述智能体 请先整理多智能体协作的研究脉络和待验证问题。', signal)
      await selectorClick('button[title="发送"]', signal)
      await pause(18000, signal)
    },
    async human(signal) {
      await fill('textarea', SCENARIOS.travel.question, signal)
      await press('发送', signal); await pause(17000, signal)
    },
    async settings(signal) {
      await selectorClick('.sidebar-account-trigger', signal)
      await press('设置', signal)
      await pause(1600, signal)
      await press('深色', signal)
      await pause(1800, signal)
      await press('浅色', signal)
      await press('账号管理', signal)
      await pause(1800, signal)
      await press('用量与配额', signal)
      await pause(1800, signal)
      await selectorClick('button[aria-label="关闭设置"]', signal)
    },
    async api(signal) { await press('开放 API', signal); await pause(4000, signal) },
    async overview(signal) { await pause(4000, signal) },
    async providers(signal) { await pause(4000, signal) },
    async routing(signal) { await pause(4000, signal) },
    async probes(signal) { await press('立即分析', signal); await pause(3000, signal) },
    async accounts(signal) { await pause(4000, signal) },
    async quotas(signal) { await pause(4000, signal) },
    async access(signal) { await pause(4000, signal) },
    async traces(signal) { await pause(3500, signal) },
    async logs(signal) { await pause(3500, signal) },
  }
  const chapterRoutes = { create: '/admin?tab=studio', discovery: '/admin?tab=studio', structured: '/?example=structured', human: '/digital-human',
    ...Object.fromEntries(['overview', 'providers', 'routing', 'probes', 'accounts', 'quotas', 'access', 'traces', 'logs'].map(key => [key, '/admin?tab=' + key])) }
  const collaboration = ['research-detail', 'bounty-detail', 'group-user', 'group-host', 'canvas-review']
  const remaining = ['discovery', 'first-use', 'news', 'travel', 'structured', 'human']
  const full = RECORDING_PLAN.map(item => item.key)
  const stop = () => { running?.abort(); running = null; queue = null; sessionStorage.removeItem(SCRIPT_KEY); host.dataset.recordingState = 'stopped'; status('脚本已停止；界面可继续手动操作。') }
  async function execute() {
    if (!queue?.running || running) return
    running = new AbortController(); const signal = running.signal
    try {
      while (queue.index < queue.chapters.length) {
        const chapter = queue.chapters[queue.index], route = chapterRoutes[chapter] || '/'
        if (queue.paced && !queue.ready) {
          host.dataset.recordingState = 'chapter-ready'
          await new Promise((resolve, reject) => {
            resumeChapter = resolve
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
          resumeChapter = null; queue.ready = true
        }
        sessionStorage.setItem(SCRIPT_KEY, JSON.stringify(queue))
        if (navigate(route)) return
        host.dataset.chapter = chapter; host.dataset.chapterStarted = String(Date.now() / 1000); host.dataset.recordingState = 'running'
        status(`正在演示：${chapter}（${queue.index + 1}/${queue.chapters.length}）`)
        await until(() => document.querySelector(route.startsWith('/admin') ? '.app-shell' : route === '/digital-human' ? '.digital-human' : '.chat-layout'), '正式界面载入', signal)
        if (recordOnly) await chapterCard(chapter, signal, delay)
        await pause(1000, signal); await actions[chapter](signal); queue.index++; queue.ready = false
        sessionStorage.setItem(SCRIPT_KEY, JSON.stringify(queue))
      }
      sessionStorage.removeItem(SCRIPT_KEY); queue = null; host.dataset.recordingState = 'complete'; status('演示脚本已完成。全部记录仅保存在本机。')
    } catch (error) {
      sessionStorage.removeItem(SCRIPT_KEY); queue = null; host.dataset.recordingState = 'error'
      if (!signal.aborted) { status(`脚本停在当前界面：${error.message}。可继续手动操作或重置。`); if (!recordOnly) host.setAttribute('open', '') }
    } finally { running = null }
  }
  shadow.addEventListener('click', event => {
    const action = event.target.closest('button')?.dataset.do; if (!action) return
    if (action === 'hide') { host.removeAttribute('open'); return }
    if (action === 'stop') return stop()
    if (action === 'reset') {
      stop(); runtime.reset()
      for (const key of Object.keys(localStorage)) if (key.startsWith(`aegismesh-owner:${OWNER}:`) || key === 'aegismesh-recording-demo:v1') localStorage.removeItem(key)
      localStorage.setItem(STORE_KEY, JSON.stringify(runtime.state)); location.assign('/'); return
    }
    if (action === 'export') {
      const blob = new Blob([JSON.stringify({ demo: true, production_ui: true, requests: runtime.requests, records: runtime.state }, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'aegismesh-offline-demo.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return
    }
    stop(); queue = { running: true, chapters: action === 'full' ? full : action === 'collaboration' ? collaboration : action === 'remaining' ? remaining : [action], index: 0,
      paced: shadow.querySelector('#paced').checked, ready: true }; host.removeAttribute('open'); void execute()
  })
  window.addEventListener('keydown', event => {
    if (event.key === 'F8') { event.preventDefault(); if (!recordOnly) host.toggleAttribute('open') }
    if (event.key === 'F9') {
      event.preventDefault()
      if (resumeChapter) resumeChapter()
      else if (recordOnly && !running && host.dataset.recordingState === 'idle') {
        queue = { running: true, chapters: full, index: 0, paced: true, ready: true }; void execute()
      }
    }
    if (event.key === 'Escape' && running) stop()
  }, true)
  if (!recordOnly && new URLSearchParams(location.search).has('director')) host.setAttribute('open', '')
  try { queue = JSON.parse(sessionStorage.getItem(SCRIPT_KEY) || 'null') } catch { /* no active script */ }
  if (queue?.running) void execute()
}
