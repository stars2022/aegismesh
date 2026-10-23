import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, BookOpen, ChevronRight, MessageCircle, Newspaper, Plus, Send, Settings2, Square, Volume2, VolumeX, MapPin, Mic, MicOff, Network } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from './api'
import { createId } from './randomId.mjs'
import type { ChatResult } from './types'
import { conversationStorageForOwner } from './conversationStorage'
import { conversationCacheKeysOldestFirst, setWithEviction } from './conversationSync'
import { assistantFailure, assistantWasCancelled, finishAssistantReply, newAssistantSession, readAssistantSession, speechText, type AssistantSession } from './assistantConversation'
import { createAssistantSpeech } from './assistantSpeech'
import { createSpeechInput, speechInputSupported, type SpeechInput } from './speechInput'
import { SettingsDialog } from './SettingsDialog'
import { DigitalHumanAvatar } from './DigitalHumanAvatar'
import { isNearConversationEnd, readDigitalHumanPreferences } from './digitalHumanPreferences'
import { applyTheme, loadSettings, saveSettings, type UserSettings } from './settings'
import './DigitalHuman.css'

const STORAGE_FULL = '浏览器存储空间已满，本次对话记录未能保存；当前对话仍可继续。'

type SavedConsultation = { id: string; title: string }
const topics = [
  { icon: BookOpen, name: '科研咨询', question: '我正在准备一份研究报告，请先帮我厘清研究主题、问题和所需资料。' },
  { icon: Newspaper, name: '新闻查询', question: '帮我了解最近一周人工智能领域的主要新闻，标明日期和可核验的来源。' },
  { icon: MapPin, name: '出行咨询', question: '我想安排一次轻松的周末旅行，请先问我出发地、预算和偏好，再帮我规划。' },
]

// Fixed-size corners stay crisp as the console reflows; chrome never intercepts input.
function ConsoleFrame() {
  return <span className="dh-panel-chrome" aria-hidden="true">{[0, 1, 2, 3].map(corner => <svg key={corner} viewBox="0 0 36 36" fill="none" focusable="false">
    <path d="M2 35V13L13 2H35" stroke="currentColor" strokeWidth="2"/>
    <path d="M7 35V16L16 7H35" stroke="currentColor" opacity=".45"/>
    <path d="M2 26V13L13 2H26" stroke="currentColor" strokeWidth="4"/>
    <path d="M0 33H4M33 0V4" stroke="currentColor" opacity=".5"/>
  </svg>)}</span>
}

export default function DigitalHuman({ ownerId }: { ownerId: string }) {
  const storage = useMemo(() => conversationStorageForOwner(ownerId), [ownerId])
  const readIndex = (): SavedConsultation[] => {
    try { const data = JSON.parse(storage.getItem('human-index') || '[]'); return Array.isArray(data) ? data.filter(r => r && typeof r.id === 'string' && /^human-[a-zA-Z0-9-]{1,100}$/.test(r.id) && typeof r.title === 'string') : [] } catch { return [] }
  }
  const [session, setSession] = useState<AssistantSession>(() => {
    try { return readAssistantSession(storage.getItem(storage.getItem('human-active') || '')) || newAssistantSession() } catch { return newAssistantSession() }
  })
  const [history, setHistory] = useState(readIndex)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [notice, setNotice] = useState('')
  // 播报默认开启；用户手动关闭后记在偏好里
  const [voiceOn, setVoiceOn] = useState(() => {
    try { return readDigitalHumanPreferences(storage.getItem('human-preferences')).voiceOn } catch { return true }
  })
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [readingId, setReadingId] = useState<string | null>(null)
  const [preferences] = useState(() => {
    try { return readDigitalHumanPreferences(storage.getItem('human-preferences')) }
    catch { return readDigitalHumanPreferences(null) }
  })
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [voiceId, setVoiceId] = useState(preferences.voiceId)
  const [voiceRate, setVoiceRate] = useState(preferences.voiceRate)
  const [largeText, setLargeText] = useState(preferences.largeText)
  const [showLatest, setShowLatest] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState(loadSettings)
  const voice = voices.find(v => v.voiceURI === voiceId) || voices[0] || null
  const voiceRef = useRef(voice)
  const voiceRateRef = useRef(voiceRate)
  voiceRef.current = voice; voiceRateRef.current = voiceRate
  const playerRef = useRef<ReturnType<typeof createAssistantSpeech> | null>(null)
  const sessionRef = useRef(session)
  const operationRef = useRef(0)
  const mounted = useRef(false)
  const busyRef = useRef(false)
  const voiceEnabled = useRef(voiceOn)
  const speechInputRef = useRef<SpeechInput | null>(null)
  const dictationBase = useRef('')
  const canDictate = useMemo(speechInputSupported, [])
  const controllerRef = useRef<AbortController | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const followReplies = useRef(true)

  const scrollToLatest = () => {
    const list = messagesRef.current
    if (list) list.scrollTop = list.scrollHeight
    followReplies.current = true
    setShowLatest(false)
  }

  const save = (next: AssistantSession) => {
    sessionRef.current = next
    setSession(next)
    // 登录账号的聊天会话在云端有副本：空间不足时先淘汰最旧的聊天缓存，再保存数字人记录。
    const evictable = ownerId.startsWith('account_') ? conversationCacheKeysOldestFirst(storage) : []
    const put = (key: string, value: string) => setWithEviction(storage, key, value, evictable)
    try {
      const index = [{ id: next.id, title: next.title }, ...readIndex().filter(r => r.id !== next.id)]
      const saved = put(next.id, JSON.stringify(next)) && put('human-active', next.id) && put('human-index', JSON.stringify(index))
      if (!saved) throw new Error('storage full')
      setHistory(index)
      setNotice(current => current === STORAGE_FULL ? '' : current)
    } catch { setNotice(STORAGE_FULL) }
  }
  const silence = () => {
    playerRef.current?.stop()
    setSpeaking(false)
    setReadingId(null)
  }
  const speak = (text: string, messageId?: string, once = false) => {
    if ((!voiceEnabled.current && !once) || !voiceRef.current || !playerRef.current) return
    const started = playerRef.current.play(speechText(text), voiceRef.current, voiceRateRef.current)
    setReadingId(started ? messageId || null : null)
  }
  const run = async (current: AssistantSession, taskId?: string) => {
    const operation = ++operationRef.current
    const replyId = current.pendingId!
    const controller = new AbortController()
    controllerRef.current = controller
    busyRef.current = true; setBusy(true)
    const isCurrent = () => mounted.current && operation === operationRef.current && sessionRef.current.id === current.id
    try {
      let result: ChatResult
      if (taskId) result = await api.reconnectTaskStream(taskId, () => undefined, undefined, controller.signal)
      else result = await api.assistantChatStream(current.messages.filter(m => m.role === 'user').at(-1)!.text, current.id, controller.signal, id => { if (isCurrent()) save({ ...sessionRef.current, taskId: id }) })
      if (!isCurrent()) return
      if (result.session_id !== current.id) throw new Error('会话状态已变化')
      const stopped = ['cancelled', 'canceled'].includes(result.status)
      const failed = result.status !== 'completed'
      const answer = stopped ? '已停止本次答复。你可以继续提问。' : failed ? assistantFailure(result.answer) : result.answer?.trim() || '这次没有收到有效答复，请换一种说法再试试。'
      save(finishAssistantReply(sessionRef.current, replyId, answer, stopped ? 'stopped' : failed ? 'failed' : undefined))
      if (!failed) speak(answer, replyId)
    } catch (error) {
      if (!isCurrent() || controller.signal.aborted) return
      const stopped = assistantWasCancelled(error)
      save(finishAssistantReply(sessionRef.current, replyId, stopped ? '已停止本次答复。你可以继续提问。' : assistantFailure(error), stopped ? 'stopped' : 'failed'))
    } finally {
      if (isCurrent()) { busyRef.current = false; setBusy(false); setStopping(false); controllerRef.current = null }
    }
  }
  const recover = async (current: AssistantSession) => {
    if (!current.pendingId) return
    if (current.taskId) { await run(current, current.taskId); return }
    const operation = ++operationRef.current
    busyRef.current = true; setBusy(true)
    try {
      const active = await api.getActiveTask(current.id)
      if (!mounted.current || operation !== operationRef.current) return
      if (active.task?.task_id) { const next = { ...current, taskId: active.task.task_id }; save(next); await run(next, next.taskId); return }
      save(finishAssistantReply(current, current.pendingId, '上次连接已中断，暂时没有可恢复的答复。你可以重新提问。', 'failed'))
    } catch {
      if (mounted.current && operation === operationRef.current) save(finishAssistantReply(current, current.pendingId, '暂时无法恢复上次答复，请稍后重试。', 'failed'))
    } finally { if (mounted.current && operation === operationRef.current) { busyRef.current = false; setBusy(false) } }
  }
  useEffect(() => {
    mounted.current = true
    void recover(sessionRef.current)
    return () => { mounted.current = false; operationRef.current += 1; controllerRef.current?.abort(); playerRef.current?.stop() }
  }, [])
  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const player = createAssistantSpeech(window.speechSynthesis, {
      onSpeaking: value => { if (mounted.current) setSpeaking(value) },
      onError: () => { if (mounted.current) setNotice('语音暂时无法播放，您可以继续阅读文字。') },
      onIdle: () => { if (mounted.current) setReadingId(null) },
    })
    playerRef.current = player
    const sync = () => setVoices(window.speechSynthesis.getVoices().filter(v => v.localService && /^zh(?:[-_]|$)/i.test(v.lang)))
    const hide = () => { if (document.hidden) player.stop() }
    sync(); window.speechSynthesis.addEventListener('voiceschanged', sync)
    document.addEventListener('visibilitychange', hide)
    return () => { window.speechSynthesis.removeEventListener('voiceschanged', sync); document.removeEventListener('visibilitychange', hide); player.stop(); playerRef.current = null }
  }, [])
  useEffect(() => {
    if (followReplies.current) scrollToLatest()
    else setShowLatest(true)
  }, [session.messages])
  useEffect(() => {
    try { storage.setItem('human-preferences', JSON.stringify({ largeText, voiceId, voiceRate, voiceOn })) }
    catch { /* Unavailable storage must not prevent reading or speaking. */ }
  }, [storage, largeText, voiceId, voiceRate, voiceOn])
  useEffect(() => () => speechInputRef.current?.cancel(), [])
  const toggleDictation = () => {
    if (speechInputRef.current) { speechInputRef.current.stop(); return }
    silence(); setNotice('')
    dictationBase.current = input.trim()
    const recognizer = createSpeechInput({
      onText: text => setInput(dictationBase.current + text),
      onEnd: () => { speechInputRef.current = null; setListening(false); inputRef.current?.focus() },
      onError: message => setNotice(message),
    })
    if (!recognizer) return
    speechInputRef.current = recognizer
    setListening(true)
    try { recognizer.start() } catch { speechInputRef.current = null; setListening(false); setNotice('语音识别没有成功，请再试一次。') }
  }
  const send = () => {
    const text = input.trim()
    if (!text || busyRef.current || text.length > 50000) return
    speechInputRef.current?.cancel()
    silence(); setNotice(''); setInput('')
    followReplies.current = true; setShowLatest(false)
    const replyId = createId()
    const current = sessionRef.current
    const next: AssistantSession = { ...current, title: current.messages.length ? current.title : text.slice(0, 24), taskId: undefined, pendingId: replyId, messages: [...current.messages, { id: createId(), role: 'user', text }, { id: replyId, role: 'assistant', text: '', state: 'pending' }] }
    save(next); void run(next)
  }
  const stop = async () => {
    if (!busyRef.current || stopping) return
    const operation = operationRef.current
    const current = sessionRef.current
    setStopping(true)
    try {
      const id = current.taskId || (await api.getActiveTask(current.id)).task?.task_id
      if (!id || !(await api.cancelTask(id)).ok) throw new Error('stop not confirmed')
      if (!mounted.current || operation !== operationRef.current || !sessionRef.current.pendingId) return
      operationRef.current += 1; controllerRef.current?.abort(); controllerRef.current = null
      save(finishAssistantReply(sessionRef.current, current.pendingId!, '已停止本次答复。你可以继续提问。', 'stopped'))
      busyRef.current = false; setBusy(false)
    } catch { if (mounted.current && operation === operationRef.current) setNotice('停止请求暂未确认，请稍后再试。') }
    finally { if (mounted.current) setStopping(false) }
  }
  const changeSession = (next: AssistantSession) => {
    if (busyRef.current) return
    operationRef.current += 1; silence(); setInput(''); setNotice(''); save(next); void recover(next)
    followReplies.current = true; setShowLatest(false)
  }
  const updateSettings = (patch: Partial<UserSettings>) => setSettings(current => {
    const next = { ...current, ...patch }; saveSettings(next); applyTheme(next); return next
  })
  const clearHistory = () => {
    if (busyRef.current) { setNotice('请先停止当前答复，再清空记录。'); setSettingsOpen(false); return }
    try {
      for (const row of readIndex()) storage.removeItem(row.id)
      storage.removeItem('human-index'); storage.removeItem('human-active')
      silence(); followReplies.current = true; setShowLatest(false); const next = newAssistantSession(); sessionRef.current = next; setSession(next); setHistory([]); setInput(''); setNotice(''); setSettingsOpen(false)
    } catch { setNotice('暂时无法清空记录，请稍后重试。'); setSettingsOpen(false) }
  }
  return <>
    <main className={`digital-human${largeText ? ' dh-large-text' : ''}`}>
      <header className="dh-masthead"><div className="dh-title-plaque"><div className="dh-emblem"><Network size={32}/></div><strong className="dh-brand">AegisMesh</strong><h1>智能咨询服务台</h1></div></header>
      <nav className="dh-navigation" aria-label="服务导航"><span className="dh-current"><MessageCircle size={20}/>在线咨询</span><div><a href="/"><ArrowLeft size={18}/>工作台</a><button onClick={() => setSettingsOpen(true)}><Settings2 size={18}/>设置</button></div></nav>
      <div className="dh-layout">
        <aside className="dh-service-column" aria-label="咨询服务目录">
          <section className="dh-guide"><ConsoleFrame/><h2>服务目录</h2>{topics.map((topic, index) => <button key={topic.name} disabled={busy} onClick={() => { setInput(topic.question); inputRef.current?.focus(); inputRef.current?.closest('form')?.scrollIntoView({block:'nearest',behavior:'auto'}) }}><span className="dh-topic-icon"><topic.icon size={28}/></span><strong>{topic.name}</strong><ChevronRight size={18}/><span className="dh-topic-index" aria-hidden="true">0{index + 1}</span></button>)}</section>
          <section className="dh-history"><ConsoleFrame/><label htmlFor="dh-history">咨询记录</label><select id="dh-history" disabled={busy} value={session.id} onChange={event => { const next = readAssistantSession(storage.getItem(event.target.value)); if (next) changeSession(next) }}><option value={session.id}>{session.title}</option>{history.filter(r => r.id !== session.id).map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select></section>
          <div className="dh-directory-circuit" aria-hidden="true"><Network size={48}/><i/><i/><i/></div>
        </aside>
        <section className={`dh-host${speaking || listening ? ' is-speaking' : ''}`} aria-label="虚拟助手麦溪">
            <ConsoleFrame/>
            <div className="dh-host-caption"><h2>数字人服务</h2><span className="dh-voice-level" aria-hidden="true">{[0,1,2,3,4].map(n => <i key={n}/>)}</span></div>
            <div className="dh-avatar-chamber">
              <svg className="dh-instrument" viewBox="0 0 480 520" fill="none" aria-hidden="true" focusable="false">
                <circle cx="240" cy="258" r="218" stroke="currentColor" opacity=".22"/>
                <circle cx="240" cy="258" r="204" stroke="currentColor" strokeWidth="6" strokeDasharray="2 12" opacity=".42"/>
                <circle cx="240" cy="258" r="189" stroke="currentColor" strokeDasharray="80 13 6 13" opacity=".22"/>
                <path d="M27 171V104L68 63H133M347 63H412L453 104V171M27 342V407L68 448H133M347 448H412L453 407V342" stroke="currentColor" strokeWidth="2"/>
                <path d="M72 95H126M354 95H408M72 416H126M354 416H408M12 258H53M427 258H468" stroke="currentColor" strokeWidth="4" opacity=".55"/>
                <path d="M166 27H314L326 39H154ZM166 477H314L326 489H154Z" fill="currentColor" opacity=".35"/>
                <circle cx="27" cy="171" r="4" fill="currentColor"/><circle cx="453" cy="342" r="4" fill="currentColor"/>
              </svg>
              <DigitalHumanAvatar speaking={speaking} busy={busy} consultationId={session.id}/>
              <div className="dh-host-floor" aria-hidden="true"/>
            </div>
            <div className="dh-host-name"><strong>麦溪</strong><span>Mesh</span></div>
            <p className="dh-host-status" role="status"><span aria-hidden="true"/>{listening ? '正在聆听，请说话' : speaking ? '正在为您播报' : busy ? '正在整理答复' : '请问有什么可以帮您？'}</p>
            <div className="dh-host-controls">
              <button disabled={!voice} title={voice ? '使用设备本地中文声音' : '当前设备没有可用的本地中文声音'} aria-pressed={voiceOn} onClick={() => { const enabled = !voiceOn; voiceEnabled.current = enabled; setVoiceOn(enabled); if (!enabled) silence(); else speak('您好，我是麦溪，请问有什么可以帮您？') }}>{voiceOn ? <Volume2 size={20}/> : <VolumeX size={20}/>} {voice ? voiceOn ? '关闭播报' : '开启播报' : '语音不可用'}</button>
              <button className={`dh-dictate${listening ? ' is-listening' : ''}`} disabled={!canDictate || (busy && !listening)} aria-pressed={listening}
                title={canDictate ? '说完一句话会自动停止，识别出的文字填入下方输入框，确认后再发送' : '当前浏览器不支持语音识别，请使用 Chrome、Edge 或 Safari'}
                onClick={toggleDictation}>{listening ? <MicOff size={20}/> : <Mic size={20}/>} {listening ? '结束语音' : canDictate ? '语音提问' : '语音不可用'}</button>
              {speaking && <button onClick={silence}><Square size={18}/>停止播报</button>}
            </div>
            {voice && <details className="dh-voice-settings"><summary>声音设置</summary>{voices.length > 1 && <label>音色<select aria-label="播报音色" value={voice.voiceURI} onChange={e => { silence(); setVoiceId(e.target.value) }}>{voices.map(v => <option value={v.voiceURI} key={v.voiceURI}>{v.name}</option>)}</select></label>}<label>语速<select aria-label="播报语速" value={voiceRate} onChange={e => { silence(); setVoiceRate(Number(e.target.value)) }}><option value={0.8}>慢速</option><option value={0.9}>舒缓</option><option value={1}>正常</option></select></label></details>}
        </section>
        <section className="dh-consultation" aria-label="智能咨询对话">
          <ConsoleFrame/>
          <header className="dh-chat-heading"><h2>与麦溪对话</h2><div><button aria-pressed={largeText} onClick={() => setLargeText(value => !value)}>大字</button><button onClick={() => changeSession(newAssistantSession())} disabled={busy}><Plus size={18}/>新咨询</button></div></header>
          <div className="dh-conversation-body">
          <div ref={messagesRef} className="dh-messages" role="log" aria-label="咨询消息" aria-live="polite" aria-relevant="additions text" tabIndex={0} onScroll={() => {
            if (!messagesRef.current) return
            followReplies.current = isNearConversationEnd(messagesRef.current)
            if (followReplies.current) setShowLatest(false)
          }}>
            <div className="dh-message assistant"><span className="dh-message-avatar" aria-hidden="true">麦</span><div className="dh-bubble"><strong className="dh-speaker">麦溪</strong><p>您好，请问有什么可以帮您？</p></div></div>
            {session.messages.map(message => <article key={message.id} className={`dh-message ${message.role}`}><span className="dh-message-avatar" aria-hidden="true">{message.role === 'user' ? '您' : '麦'}</span><div className={`dh-bubble ${message.state || ''}`}><strong className="dh-speaker">{message.role === 'user' ? '您' : '麦溪'}</strong>{message.state === 'pending' ? <p className="dh-waiting" role="status"><span/>正在整理答复，请稍候。</p> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{message.text}</ReactMarkdown>}{message.role === 'assistant' && !message.state && voice && <button className="dh-read-reply" aria-pressed={readingId === message.id} onClick={() => { if (readingId === message.id) silence(); else speak(message.text, message.id, true) }}>{readingId === message.id ? <Square size={18}/> : <Volume2 size={18}/>} {readingId === message.id ? '停止朗读' : '朗读答复'}</button>}</div></article>)}
          </div>
          {showLatest && <button type="button" className="dh-jump-latest" onClick={scrollToLatest}><ArrowDown size={18}/>查看新答复</button>}
          </div>
          <form className="dh-composer" onSubmit={event => { event.preventDefault(); send() }}>{notice && <p role="alert" className="dh-inline-notice">{notice}</p>}<textarea id="dh-input" aria-label="咨询问题" ref={inputRef} rows={3} value={input} onChange={event => setInput(event.target.value)} maxLength={50000} placeholder="请在这里输入您的问题…" onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }}/><div className="dh-composer-footer">{busy ? <button type="button" className="dh-send" disabled={stopping} onClick={() => void stop()}><Square size={19}/>{stopping ? '正在停止' : '停止回答'}</button> : <button className="dh-send" disabled={!input.trim()}><Send size={19}/>发送</button>}</div></form>
        </section>
      </div><footer className="dh-footer"><span>AegisMesh</span><span>内容由AI生成，可能不准确</span></footer>
    </main>
    {settingsOpen && <SettingsDialog settings={settings} onChange={updateSettings} onClose={() => setSettingsOpen(false)} onClear={clearHistory}/>}
  </>
}
