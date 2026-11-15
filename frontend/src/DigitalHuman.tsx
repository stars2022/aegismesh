import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, BookOpen, ChevronRight, MessageCircle, Newspaper, Plus, Radio, Send, Settings2, Square, Volume2, VolumeX, MapPin, Mic, MicOff, Network } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type DigitalHumanPublicConfig, type StreamEvent } from './api'
import { createId } from './randomId.mjs'
import type { ChatResult } from './types'
import { conversationStorageForOwner } from './conversationStorage'
import { conversationCacheKeysOldestFirst, setWithEviction } from './conversationSync'
import { assistantFailure, assistantWasCancelled, finishAssistantReply, newAssistantSession, readAssistantSession, speechText, type AssistantSession } from './assistantConversation'
import { createAssistantSpeech } from './assistantSpeech'
import { createSpeechInput, speechInputSupported, type SpeechInput } from './speechInput'
import { createRealtimeSpeechQueue } from './realtimeSpeechQueue'
import { mediaRecorderSupported, startWavRecorder, type AudioRecorderSession } from './wavEncoder'
import { startRealtimeVoiceInput, type RealtimeVoiceInput } from './realtimeVoiceInput'
import { SettingsDialog } from './SettingsDialog'
import { DigitalHumanAvatar } from './DigitalHumanAvatar'
import { isNearConversationEnd, readDigitalHumanPreferences } from './digitalHumanPreferences'
import { applyTheme, loadSettings, saveSettings, type UserSettings } from './settings'
import { DynamicUiRenderer, type DynamicUiBlock } from './DynamicUiRenderer'
import './DigitalHuman.css'

const STORAGE_FULL = '浏览器存储空间已满，本次对话记录未能保存；当前对话仍可继续。'

type SavedConsultation = { id: string; title: string }
type BackgroundTaskItem = {
  id: string
  taskId?: string
  title: string
  prompt: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  stage: string
  result: string
}
const topics = [
  { icon: BookOpen, name: '科研咨询', question: '我正在准备一份研究报告，请先帮我厘清研究主题、问题和所需资料。' },
  { icon: Newspaper, name: '新闻查询', question: '帮我了解最近一周人工智能领域的主要新闻，标明日期和可核验的来源。' },
  { icon: MapPin, name: '出行咨询', question: '我想安排一次轻松的周末旅行，请先问我出发地、预算和偏好，再帮我规划。' },
]

function wrapDynamicHtml(fragment: string): string {
  const trimmed = fragment.trim()
  if (/^<!doctype|^<html/i.test(trimmed)) return trimmed
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;color:#e2e8f0;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button{font-family:inherit}</style></head><body>${trimmed}</body></html>`
}

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
  const [listening, setListeningState] = useState(false)
  const [transcribing, setTranscribingState] = useState(false)
  const [voiceConversation, setVoiceConversation] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [readingId, setReadingId] = useState<string | null>(null)
  const [realtimeMode, setRealtimeMode] = useState(true)
  const [routingStage, setRoutingStage] = useState('')
  const [dynamicUi, setDynamicUi] = useState<{ title: string; blocks?: DynamicUiBlock[]; html?: string; sourceText?: string } | null>(null)
  const [liveCaption, setLiveCaption] = useState('')
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const backgroundTasksRef = useRef<BackgroundTaskItem[]>([])
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskItem[]>([])
  const bgControllersRef = useRef<Map<string, AbortController>>(new Map())
  const [dhConfig, setDhConfig] = useState<DigitalHumanPublicConfig>({
    enabled: true,
    realtime_mode: true,
    display_name: '麦溪',
    greeting: '您好，请问有什么可以帮您？',
    tts_backend: 'browser',
    tts_voice_id: 'stella',
    tts_available: true,
    asr_backend: 'browser',
    asr_available: true,
  })
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
  const usingDeepSeekTts = dhConfig.tts_backend === 'deepseek' && dhConfig.tts_available
  const usingDeepSeekAsr = dhConfig.asr_backend === 'deepseek' && dhConfig.asr_available
  const deepseekVoice: 'stella' | 'tide' = voiceId === 'stella' || voiceId === 'tide' ? voiceId : dhConfig.tts_voice_id
  const voice = voices.find(v => v.voiceURI === voiceId) || voices[0] || null
  const voiceAvailable = dhConfig.tts_backend !== 'disabled' && (usingDeepSeekTts || Boolean(voice))
  const voiceRef = useRef(voice)
  const voiceRateRef = useRef(voiceRate)
  const dhConfigRef = useRef(dhConfig)
  const deepseekVoiceRef = useRef(deepseekVoice)
  const realtimeModeRef = useRef(realtimeMode)
  voiceRef.current = voice; voiceRateRef.current = voiceRate; dhConfigRef.current = dhConfig; deepseekVoiceRef.current = deepseekVoice; realtimeModeRef.current = realtimeMode
  const playerRef = useRef<ReturnType<typeof createAssistantSpeech> | null>(null)
  const realtimeQueueRef = useRef<ReturnType<typeof createRealtimeSpeechQueue> | null>(null)
  const continuousFollowRef = useRef(false)
  const realtimeInputRef = useRef<RealtimeVoiceInput | null>(null)
  const microphoneAbortRef = useRef<AbortController | null>(null)
  const asrAbortRef = useRef<AbortController | null>(null)
  const voiceEpochRef = useRef(0)
  const startingInputRef = useRef(false)
  const listeningRef = useRef(false)
  const transcribingRef = useRef(false)
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const voiceLimitRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const resumeListeningRef = useRef<() => void>(() => undefined)
  const dsAudioRef = useRef<HTMLAudioElement | null>(null)
  const dsAudioUrlRef = useRef('')
  const dsTtsAbortRef = useRef<AbortController | null>(null)
  const dsTtsGenRef = useRef(0)
  const sessionRef = useRef(session)
  const operationRef = useRef(0)
  const mounted = useRef(false)
  const busyRef = useRef(false)
  const voiceEnabled = useRef(voiceOn)
  const speechInputRef = useRef<SpeechInput | null>(null)
  const wavRecorderRef = useRef<AudioRecorderSession | null>(null)
  const dictationBase = useRef('')
  const browserSpeechSupported = useMemo(speechInputSupported, [])
  const recorderSupported = useMemo(mediaRecorderSupported, [])
  const canDictate = dhConfig.asr_backend !== 'disabled' && (usingDeepSeekAsr ? recorderSupported : browserSpeechSupported)
  const controllerRef = useRef<AbortController | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const setListening = (value: boolean) => { listeningRef.current = value; setListeningState(value) }
  const setTranscribing = (value: boolean) => { transcribingRef.current = value; setTranscribingState(value) }
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
    realtimeQueueRef.current?.cancel()
    dsTtsGenRef.current += 1
    dsTtsAbortRef.current?.abort()
    dsTtsAbortRef.current = null
    if (dsAudioRef.current) {
      dsAudioRef.current.pause()
      dsAudioRef.current = null
    }
    if (dsAudioUrlRef.current) {
      URL.revokeObjectURL(dsAudioUrlRef.current)
      dsAudioUrlRef.current = ''
    }
    playerRef.current?.stop()
    setSpeaking(false)
    setReadingId(null)
  }
  const endVoiceConversation = () => {
    continuousFollowRef.current = false
    voiceEpochRef.current += 1
    startingInputRef.current = false
    clearTimeout(resumeTimerRef.current); clearTimeout(voiceLimitRef.current)
    microphoneAbortRef.current?.abort(); microphoneAbortRef.current = null
    asrAbortRef.current?.abort(); asrAbortRef.current = null
    realtimeInputRef.current?.cancel(); realtimeInputRef.current = null
    speechInputRef.current?.cancel(); speechInputRef.current = null
    wavRecorderRef.current?.cancel(); wavRecorderRef.current = null
    if (mounted.current) { setVoiceConversation(false); setListening(false); setTranscribing(false) }
  }
  const interruptRealtimeTurn = () => {
    if (!realtimeModeRef.current) return
    operationRef.current += 1
    controllerRef.current?.abort(); controllerRef.current = null
    busyRef.current = false; setBusy(false); setStopping(false); setRoutingStage('')
    silence()
    const current = sessionRef.current
    if (current.pendingId) {
      const partial = current.messages.find(m => m.id === current.pendingId)?.text.trim()
      save(finishAssistantReply(current, current.pendingId, partial || '已打断，您可以继续说。', 'stopped'))
    }
  }
  const resumeVoiceConversation = () => {
    clearTimeout(resumeTimerRef.current)
    if (!continuousFollowRef.current || !realtimeModeRef.current) return
    resumeTimerRef.current = setTimeout(() => {
      if (!mounted.current || document.hidden || !continuousFollowRef.current || !realtimeModeRef.current
        || realtimeInputRef.current || startingInputRef.current || speechInputRef.current
        || busyRef.current || transcribingRef.current || realtimeQueueRef.current?.isActive() || playerRef.current?.isActive()) return
      startListeningRef.current()
    }, 200)
  }
  resumeListeningRef.current = resumeVoiceConversation
  const speak = (text: string, messageId?: string, once = false) => {
    const cfg = dhConfigRef.current
    if (document.hidden || cfg.tts_backend === 'disabled' || (!voiceEnabled.current && !once)) return
    if (cfg.tts_backend === 'deepseek' && cfg.tts_available) {
      const cleaned = speechText(text).join(' ').trim() || text.trim()
      if (!cleaned) return
      silence()
      setReadingId(messageId || null)
      if (realtimeQueueRef.current) {
        realtimeQueueRef.current.pushSpeech(cleaned)
        realtimeQueueRef.current.flush()
        return
      }
      const gen = ++dsTtsGenRef.current
      const controller = new AbortController()
      dsTtsAbortRef.current = controller
      setReadingId(messageId || null)
      void api.digitalHumanTts(cleaned.slice(0, 10000), deepseekVoiceRef.current, controller.signal)
        .then(blob => {
          if (!mounted.current || gen !== dsTtsGenRef.current) return
          const url = URL.createObjectURL(blob)
          dsAudioUrlRef.current = url
          const audio = new Audio(url)
          audio.playbackRate = Math.min(1.1, Math.max(0.75, voiceRateRef.current))
          dsAudioRef.current = audio
          audio.onplay = () => { if (mounted.current && gen === dsTtsGenRef.current) setSpeaking(true) }
          audio.onended = () => {
            if (gen === dsTtsGenRef.current) {
              if (dsAudioUrlRef.current === url) { URL.revokeObjectURL(url); dsAudioUrlRef.current = '' }
              dsAudioRef.current = null
              if (mounted.current) { setSpeaking(false); setReadingId(null) }
            }
          }
          audio.onerror = () => {
            if (gen === dsTtsGenRef.current) {
              if (dsAudioUrlRef.current === url) { URL.revokeObjectURL(url); dsAudioUrlRef.current = '' }
              dsAudioRef.current = null
              if (mounted.current) { setSpeaking(false); setReadingId(null); setNotice('语音暂时无法播放，您可以继续阅读文字。') }
            }
          }
          return audio.play()
        })
        .catch(() => {
          if (mounted.current && gen === dsTtsGenRef.current && !controller.signal.aborted) {
            setSpeaking(false)
            setReadingId(null)
            setNotice('DeepSeek 语音合成暂时不可用，您可以继续阅读文字。')
          }
        })
      return
    }
    if (!voiceRef.current || !playerRef.current) return
    const started = playerRef.current.play(speechText(text), voiceRef.current, voiceRateRef.current)
    setReadingId(started ? messageId || null : null)
  }
  const run = async (current: AssistantSession, taskId?: string) => {
    const operation = ++operationRef.current
    const replyId = current.pendingId!
    const controller = new AbortController()
    controllerRef.current = controller
    busyRef.current = true; setBusy(true); setRoutingStage('正在智能路由调度…')
    const isCurrent = () => mounted.current && operation === operationRef.current && sessionRef.current.id === current.id
    const streamDeepSeekTts = !taskId && realtimeModeRef.current && voiceEnabled.current && dhConfigRef.current.tts_backend === 'deepseek' && dhConfigRef.current.tts_available
    if (streamDeepSeekTts) {
      realtimeQueueRef.current?.cancel()
      setReadingId(replyId)
    }
    let streamedText = ''
    const handleDelta = (delta: string) => {
      if (!isCurrent() || !delta) return
      streamedText += delta
      setRoutingStage('正在实时生成并播报…')
      const updated: AssistantSession = {
        ...sessionRef.current,
        messages: sessionRef.current.messages.map(m => m.id === replyId ? { ...m, text: streamedText } : m),
      }
      sessionRef.current = updated
      setSession(updated)
      if (streamDeepSeekTts && !document.hidden) realtimeQueueRef.current?.pushDelta(delta)
    }
    const handleEvent = (event: StreamEvent) => {
      if (!isCurrent()) return
      if (event.type === 'subagent_start' && event.data) {
        setRoutingStage(`正在调度「${event.data.agent_name || event.data.agent_id || '专家智能体'}」协同处理…`)
      } else if (event.type === 'subagent_tool' && event.data) {
        setRoutingStage(`正在调用工具 ${event.data.tool || event.data.name || ''}…`)
      } else if (event.type === 'subagent_complete' && event.data) {
        setRoutingStage(`「${event.data.agent_name || '专家智能体'}」已完成，正在汇总…`)
      }
    }
    try {
      let result: ChatResult
      if (taskId) result = await api.reconnectTaskStream(taskId, handleDelta, handleEvent, controller.signal)
      else result = await api.assistantChatStream(current.messages.filter(m => m.role === 'user').at(-1)!.text, current.id, controller.signal, id => { if (isCurrent()) save({ ...sessionRef.current, taskId: id }) }, handleDelta, handleEvent)
      if (!isCurrent()) return
      if (result.session_id !== current.id) throw new Error('会话状态已变化')
      const stopped = ['cancelled', 'canceled'].includes(result.status)
      const failed = result.status !== 'completed'
      const answer = stopped ? '已停止本次答复。你可以继续提问。' : failed ? assistantFailure(result.answer) : result.answer?.trim() || '这次没有收到有效答复，请换一种说法再试试。'
      save(finishAssistantReply(sessionRef.current, replyId, answer, stopped ? 'stopped' : failed ? 'failed' : undefined))
      if (!failed && !stopped) {
        if (streamDeepSeekTts) {
          realtimeQueueRef.current?.flush()
        } else {
          speak(answer, replyId)
        }
      } else if (streamDeepSeekTts) {
        realtimeQueueRef.current?.cancel()
      }
    } catch (error) {
      if (!isCurrent() || controller.signal.aborted) return
      if (streamDeepSeekTts) realtimeQueueRef.current?.cancel()
      const stopped = assistantWasCancelled(error)
      save(finishAssistantReply(sessionRef.current, replyId, stopped ? '已停止本次答复。你可以继续提问。' : assistantFailure(error), stopped ? 'stopped' : 'failed'))
    } finally {
      if (isCurrent()) { busyRef.current = false; setBusy(false); setStopping(false); setRoutingStage(''); controllerRef.current = null; resumeListeningRef.current() }
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
    const hide = () => {
      if (document.hidden) {
        endVoiceConversation()
        if (realtimeModeRef.current) interruptRealtimeTurn()
        else silence()
      }
    }
    document.addEventListener('visibilitychange', hide)
    realtimeQueueRef.current = createRealtimeSpeechQueue({
      fetchAudio: (text, signal) => api.digitalHumanSpeechAudio(text, deepseekVoiceRef.current, signal),
      getPlaybackRate: () => voiceRateRef.current,
      onSpeaking: value => { if (mounted.current) setSpeaking(value) },
      onError: reason => {
        if (!mounted.current) return
        endVoiceConversation()
        if (busyRef.current && realtimeModeRef.current) interruptRealtimeTurn()
        else silence()
        setNotice(reason instanceof Error ? reason.message : '语音播放失败，您可以继续阅读文字或重新提问。')
      },
      onAllDone: () => {
        if (!mounted.current) return
        setSpeaking(false)
        setReadingId(null)
        resumeListeningRef.current()
      },
    })
    void api.digitalHumanPublicConfig().then(cfg => {
      if (!mounted.current) return
      setDhConfig(cfg)
      setRealtimeMode(cfg.realtime_mode)
    }).catch(() => undefined)
    void recover(sessionRef.current)
    return () => {
      mounted.current = false
      operationRef.current += 1
      document.removeEventListener('visibilitychange', hide)
      controllerRef.current?.abort()
      bgControllersRef.current.forEach(c => c.abort())
      bgControllersRef.current.clear()
      endVoiceConversation()
      realtimeQueueRef.current?.dispose()
      dsTtsAbortRef.current?.abort()
      dsAudioRef.current?.pause()
      if (dsAudioUrlRef.current) URL.revokeObjectURL(dsAudioUrlRef.current)
      wavRecorderRef.current?.cancel()
      playerRef.current?.stop()
    }
  }, [])
  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const player = createAssistantSpeech(window.speechSynthesis, {
      onSpeaking: value => { if (mounted.current) setSpeaking(value) },
      onError: () => { if (mounted.current) setNotice('语音暂时无法播放，您可以继续阅读文字。') },
      onIdle: () => { if (mounted.current) { setReadingId(null); resumeListeningRef.current() } },
    })
    playerRef.current = player
    const sync = () => setVoices(window.speechSynthesis.getVoices().filter(v => v.localService && /^zh(?:[-_]|$)/i.test(v.lang)))
    sync(); window.speechSynthesis.addEventListener('voiceschanged', sync)
    return () => { window.speechSynthesis.removeEventListener('voiceschanged', sync); player.stop(); playerRef.current = null }
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
  const submitTextRef = useRef<(rawText: string) => void>(() => undefined)
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data
      if (data && typeof data === 'object' && data.type === 'dh-action' && typeof data.text === 'string' && data.text.trim()) {
        submitTextRef.current(data.text)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])
  const updateBgTasks = (updater: (items: BackgroundTaskItem[]) => BackgroundTaskItem[]) => {
    backgroundTasksRef.current = updater(backgroundTasksRef.current)
    setBackgroundTasks(backgroundTasksRef.current)
  }

  const launchBackgroundTask = (title: string, prompt: string) => {
    const bgId = createId()
    const parentSessionId = sessionRef.current.id
    const bgSessionId = `${parentSessionId}-bg-${bgId}`
    const belongsHere = () => mounted.current && sessionRef.current.id === parentSessionId
    const controller = new AbortController()
    bgControllersRef.current.set(bgId, controller)
    const entry: BackgroundTaskItem = {
      id: bgId,
      title: title || prompt.slice(0, 16),
      prompt,
      status: 'running',
      stage: '正在智能路由调度…',
      result: '',
    }
    updateBgTasks(items => [entry, ...items].slice(0, 10))

    let streamed = ''
    void api.assistantChatStream(
      prompt,
      bgSessionId,
      controller.signal,
      taskId => {
        if (belongsHere()) {
          updateBgTasks(items => items.map(t => t.id === bgId ? { ...t, taskId } : t))
        }
      },
      delta => {
        if (!belongsHere() || !delta) return
        streamed += delta
        updateBgTasks(items => items.map(t => t.id === bgId ? { ...t, stage: '正在生成任务结果…', result: streamed } : t))
      },
      event => {
        if (!belongsHere()) return
        if (event.type === 'subagent_start' && event.data) {
          updateBgTasks(items => items.map(t => t.id === bgId ? { ...t, stage: `正在调度「${event.data.agent_name || event.data.agent_id || '专家智能体'}」…` } : t))
        } else if (event.type === 'subagent_tool' && event.data) {
          updateBgTasks(items => items.map(t => t.id === bgId ? { ...t, stage: `正在调用 ${event.data.tool || event.data.name || '工具'}…` } : t))
        } else if (event.type === 'subagent_complete' && event.data) {
          updateBgTasks(items => items.map(t => t.id === bgId ? { ...t, stage: `「${event.data.agent_name || '专家智能体'}」已完成` } : t))
        }
      },
    ).then(result => {
      bgControllersRef.current.delete(bgId)
      if (!belongsHere()) return
      const stopped = ['cancelled', 'canceled'].includes(result.status)
      const failed = result.status !== 'completed'
      const answer = stopped ? '后台任务已停止。' : failed ? assistantFailure(result.answer) : result.answer?.trim() || '后台任务已完成。'
      const nextStatus: BackgroundTaskItem['status'] = stopped ? 'stopped' : failed ? 'failed' : 'completed'
      updateBgTasks(items => items.map(t => t.id === bgId ? { ...t, status: nextStatus, stage: stopped ? '已停止' : failed ? '执行失败' : '已完成', result: answer } : t))
      if (!stopped) {
        if (failed) {
          const noticeMsgId = createId()
          const msg = `关于「${entry.title}」的后台任务遇到问题：${answer}`
          const current = sessionRef.current
          save({
            ...current,
            messages: [...current.messages, { id: noticeMsgId, role: 'assistant', text: msg, state: 'failed' }],
          })
          setLiveCaption(msg)
          if (!busyRef.current && !listeningRef.current && !transcribingRef.current && voiceEnabled.current) speak(msg, noticeMsgId)
        } else {
          void api.digitalHumanSynthesizeUi({ title: entry.title, content: answer })
            .then(ui => {
              if (!belongsHere()) return
              setDynamicUi({ title: ui.ui_title, blocks: ui.ui_blocks, html: ui.ui_html, sourceText: answer })
              setLiveCaption(ui.summary_speech)
              const noticeMsgId = createId()
              const current = sessionRef.current
              save({
                ...current,
                messages: [...current.messages, { id: noticeMsgId, role: 'assistant', text: ui.summary_speech }],
              })
              if (!busyRef.current && !listeningRef.current && !transcribingRef.current && voiceEnabled.current) {
                speak(ui.summary_speech, noticeMsgId)
              }
            })
            .catch(() => {
              if (!belongsHere()) return
              const summary = `关于「${entry.title}」的研究已完成。`
              setDynamicUi({ title: entry.title, blocks: [{ type: 'text', text: answer }], sourceText: answer })
              setLiveCaption(summary)
              if (!busyRef.current && !listeningRef.current && !transcribingRef.current && voiceEnabled.current) speak(summary)
            })
        }
      }
    }).catch(err => {
      bgControllersRef.current.delete(bgId)
      if (!belongsHere() || controller.signal.aborted) return
      const msg = assistantFailure(err)
      updateBgTasks(items => items.map(t => t.id === bgId ? { ...t, status: 'failed', stage: '执行失败', result: msg } : t))
    })
  }

  const runRealtimeTurn = async (current: AssistantSession, text: string) => {
    const operation = ++operationRef.current
    const replyId = current.pendingId!
    const controller = new AbortController()
    controllerRef.current = controller
    busyRef.current = true; setBusy(true); setRoutingStage('正在实时响应…')
    setLiveCaption('')
    const isCurrent = () => mounted.current && operation === operationRef.current && sessionRef.current.id === current.id
    const streamDeepSeekTts = voiceEnabled.current && dhConfigRef.current.tts_backend === 'deepseek' && dhConfigRef.current.tts_available
    if (streamDeepSeekTts) {
      realtimeQueueRef.current?.cancel()
      setReadingId(replyId)
    }
    let spokenByStream = false
    let streamedCaption = ''
    try {
      const historyPayload = current.messages
        .slice(0, -2)
        .filter(m => m.text.trim() && !m.state)
        .slice(-10)
        .map(m => ({ role: m.role, text: m.text.slice(0, 4000) }))
      const tasksPayload = backgroundTasksRef.current.slice(0, 8).map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        stage: t.stage,
        result_preview: t.result.slice(0, 600),
      }))
      const res = await api.digitalHumanRealtimeChatStream(
        { message: text, history: historyPayload, tasks: tasksPayload },
        {
          onStage: stage => {
            if (isCurrent() && stage) setRoutingStage(stage)
          },
          onSpeech: chunk => {
            if (!isCurrent() || !chunk.trim()) return
            streamedCaption = streamedCaption ? `${streamedCaption} ${chunk.trim()}` : chunk.trim()
            setLiveCaption(streamedCaption)
            const updated = { ...sessionRef.current, messages: sessionRef.current.messages.map(m => m.id === replyId ? { ...m, text: streamedCaption } : m) }
            sessionRef.current = updated; setSession(updated)
            if (streamDeepSeekTts && !document.hidden) {
              spokenByStream = true
              realtimeQueueRef.current?.pushSpeech(chunk.trim())
            }
          },
          onUi: (uiTitle, uiBlocks) => {
            if (!isCurrent() || !uiBlocks.length) return
            setDynamicUi({ title: uiTitle || '实时交互界面', blocks: uiBlocks })
          },
        },
        controller.signal,
      )
      if (!isCurrent()) return
      save(finishAssistantReply(sessionRef.current, replyId, res.reply))
      setLiveCaption(res.reply)
      if ((res.ui_blocks && res.ui_blocks.length > 0) || (res.ui_html && res.ui_html.trim())) {
        setDynamicUi({ title: res.ui_title || '实时交互界面', blocks: res.ui_blocks, html: res.ui_html })
      }
      if (res.action === 'dispatch_task') {
        launchBackgroundTask(res.task_title || text.slice(0, 16), res.task_prompt || text)
      }
      if (streamDeepSeekTts && spokenByStream) {
        realtimeQueueRef.current?.flush()
      } else {
        speak(res.reply, replyId)
      }
    } catch (error) {
      if (!isCurrent() || controller.signal.aborted) return
      realtimeQueueRef.current?.cancel()
      save(finishAssistantReply(sessionRef.current, replyId, assistantFailure(error), 'failed'))
      setNotice(error instanceof Error ? error.message : '实时交互失败，请稍后再试')
      endVoiceConversation()
    } finally {
      if (isCurrent()) { busyRef.current = false; setBusy(false); setStopping(false); setRoutingStage(''); controllerRef.current = null; resumeListeningRef.current() }
    }
  }

  const submitText = (rawText: string) => {
    const text = rawText.trim()
    if (!text || busyRef.current || text.length > 50000) return
    speechInputRef.current?.cancel()
    speechInputRef.current = null
    if (continuousFollowRef.current && /^(结束对话|停止对话|结束语音)[。！!\s]*$/.test(text)) {
      endVoiceConversation(); interruptRealtimeTurn(); return
    }
    realtimeQueueRef.current?.prime()
    silence(); setNotice(''); setInput('')
    followReplies.current = true; setShowLatest(false)
    const replyId = createId()
    const current = sessionRef.current
    const next: AssistantSession = { ...current, title: current.messages.length ? current.title : text.slice(0, 24), taskId: undefined, pendingId: replyId, messages: [...current.messages, { id: createId(), role: 'user', text }, { id: replyId, role: 'assistant', text: '', state: 'pending' }] }
    save(next)
    if (realtimeModeRef.current) {
      void runRealtimeTurn(next, text)
    } else {
      void run(next)
    }
  }
  submitTextRef.current = submitText
  const send = () => submitText(input)
  const stopDeepSeekRecording = (autoSubmit: boolean) => {
    const active = wavRecorderRef.current
    if (!active) return
    wavRecorderRef.current = null
    setListening(false)
    setTranscribing(true)
    void active.stop()
      .then(wavBlob => api.digitalHumanAsr(wavBlob))
      .then(res => {
        if (!mounted.current) return
        const joined = [dictationBase.current, res.text.trim()].filter(Boolean).join(' ')
        if (autoSubmit && joined) {
          submitText(joined)
        } else {
          setInput(joined)
          inputRef.current?.focus()
        }
      })
      .catch(err => {
        if (mounted.current && err?.message !== 'cancelled') {
          setNotice(err instanceof Error ? err.message : 'DeepSeek 语音识别失败，请再试一次。')
        }
      })
      .finally(() => { if (mounted.current) setTranscribing(false) })
  }
  const startListening = () => {
    if (startingInputRef.current || transcribingRef.current) return
    if (busyRef.current && !realtimeModeRef.current) return
    realtimeQueueRef.current?.prime()
    if (realtimeModeRef.current && usingDeepSeekAsr) {
      if (realtimeInputRef.current) return
      silence(); setNotice('')
      voiceEnabled.current = true; setVoiceOn(true)
      continuousFollowRef.current = true; setVoiceConversation(true)
      startingInputRef.current = true
      const microphone = new AbortController()
      microphoneAbortRef.current = microphone
      const origin = sessionRef.current.id
      clearTimeout(voiceLimitRef.current)
      voiceLimitRef.current = setTimeout(() => { endVoiceConversation(); setNotice('语音对话已持续十分钟，请点击开始继续。') }, 10 * 60 * 1000)
      void startRealtimeVoiceInput({
        signal: microphone.signal,
        onSpeechStart: () => {
          if (!mounted.current || microphone.signal.aborted) return
          voiceEpochRef.current += 1
          asrAbortRef.current?.abort(); setTranscribing(false)
          interruptRealtimeTurn()
          setInput(''); setNotice('')
        },
        onUtterance: wav => {
          const epoch = voiceEpochRef.current
          const controller = new AbortController()
          asrAbortRef.current = controller
          setTranscribing(true)
          void api.digitalHumanAsr(wav, controller.signal).then(result => {
            if (!mounted.current || microphone.signal.aborted || epoch !== voiceEpochRef.current || sessionRef.current.id !== origin) return
            if (result.text.trim()) submitTextRef.current(result.text)
          }).catch(error => {
            if (controller.signal.aborted || microphone.signal.aborted || epoch !== voiceEpochRef.current) return
            endVoiceConversation()
            setNotice(error instanceof Error ? error.message : '语音识别失败，请再试一次')
          }).finally(() => {
            if (mounted.current && epoch === voiceEpochRef.current) { setTranscribing(false); asrAbortRef.current = null }
          })
        },
        onError: message => {
          if (mounted.current && !microphone.signal.aborted) { endVoiceConversation(); setNotice(message) }
        },
      }).then(recorder => {
        if (!mounted.current || microphone.signal.aborted || !continuousFollowRef.current) { recorder.cancel(); return }
        startingInputRef.current = false
        realtimeInputRef.current = recorder; setListening(true)
      }).catch(() => {
        if (!mounted.current || microphone.signal.aborted) return
        endVoiceConversation(); setNotice('没有获得麦克风权限或设备不可用，请检查浏览器权限后再试。')
      })
      return
    }
    if (usingDeepSeekAsr) {
      if (wavRecorderRef.current) return
      silence(); setNotice('')
      dictationBase.current = input.trim()
      const useVad = realtimeModeRef.current
      void startWavRecorder(useVad ? { vad: true, silenceMs: 1400, onSilenceStop: () => stopDeepSeekRecording(true) } : {})
        .then(rec => {
          if (!mounted.current) { rec.cancel(); return }
          wavRecorderRef.current = rec
          setListening(true)
        })
        .catch(() => {
          if (mounted.current) setNotice('没有获得麦克风权限或设备不可用，请检查浏览器权限后再试。')
        })
      return
    }
    if (speechInputRef.current) return
    if (realtimeModeRef.current) {
      interruptRealtimeTurn()
      voiceEnabled.current = true; setVoiceOn(true)
      if (!continuousFollowRef.current) {
        clearTimeout(voiceLimitRef.current)
        voiceLimitRef.current = setTimeout(() => { endVoiceConversation(); setNotice('语音对话已持续十分钟，请点击开始继续。') }, 10 * 60 * 1000)
      }
      continuousFollowRef.current = true; setVoiceConversation(true)
    }
    silence(); setNotice('')
    dictationBase.current = input.trim()
    let latestRecognized = ''
    const recognizer = createSpeechInput({
      onText: text => {
        latestRecognized = dictationBase.current + text
        setInput(latestRecognized)
      },
      onEnd: () => {
        speechInputRef.current = null
        setListening(false)
        if (realtimeModeRef.current && latestRecognized.trim()) {
          submitText(latestRecognized)
        } else {
          inputRef.current?.focus()
          resumeListeningRef.current()
        }
      },
      onError: (message, code) => {
        if (code === 'no-speech' && continuousFollowRef.current) return
        endVoiceConversation(); setNotice(message)
      },
    })
    if (!recognizer) { endVoiceConversation(); return }
    speechInputRef.current = recognizer
    setListening(true)
    try { recognizer.start() } catch { endVoiceConversation(); setNotice('语音识别没有成功，请再试一次。') }
  }
  const startListeningRef = useRef(startListening)
  startListeningRef.current = startListening
  const toggleDictation = () => {
    if (realtimeModeRef.current && (continuousFollowRef.current || startingInputRef.current)) {
      endVoiceConversation(); interruptRealtimeTurn(); return
    }
    if (usingDeepSeekAsr) {
      if (wavRecorderRef.current) { stopDeepSeekRecording(realtimeModeRef.current); return }
      startListening()
      return
    }
    if (speechInputRef.current) { speechInputRef.current.stop(); return }
    startListening()
  }
  const stop = async () => {
    if (!busyRef.current || stopping) return
    if (realtimeModeRef.current) { endVoiceConversation(); interruptRealtimeTurn(); return }
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
    endVoiceConversation()
    updateBgTasks(() => [])
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
      endVoiceConversation()
      silence(); followReplies.current = true; setShowLatest(false); const next = newAssistantSession(); sessionRef.current = next; setSession(next); setHistory([]); setInput(''); setNotice(''); setSettingsOpen(false)
    } catch { setNotice('暂时无法清空记录，请稍后重试。'); setSettingsOpen(false) }
  }
  return <>
    <main className={`digital-human${largeText ? ' dh-large-text' : ''}`}>
      <header className="dh-masthead"><div className="dh-title-plaque"><div className="dh-emblem"><Network size={32}/></div><strong className="dh-brand">AegisMesh</strong><h1>智能咨询服务台</h1></div></header>
      <nav className="dh-navigation" aria-label="服务导航"><span className="dh-current"><MessageCircle size={20}/>在线咨询</span><div><a href="/"><ArrowLeft size={18}/>工作台</a><button onClick={() => setSettingsOpen(true)}><Settings2 size={18}/>设置</button></div></nav>
      <div className="dh-layout">
        <aside className="dh-service-column" aria-label="咨询服务目录">
          <section className="dh-guide"><ConsoleFrame/><h2>服务目录</h2>{topics.map((topic, index) => <button key={topic.name} disabled={busy} onClick={() => { if (realtimeModeRef.current) submitText(topic.question); else { setInput(topic.question); inputRef.current?.focus(); inputRef.current?.closest('form')?.scrollIntoView({block:'nearest',behavior:'auto'}) } }}><span className="dh-topic-icon"><topic.icon size={28}/></span><strong>{topic.name}</strong><ChevronRight size={18}/><span className="dh-topic-index" aria-hidden="true">0{index + 1}</span></button>)}</section>
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
            <div className="dh-host-name"><strong>{dhConfig.display_name || '麦溪'}</strong><span>Mesh</span></div>
            <p className="dh-host-status" role="status"><span aria-hidden="true"/>{transcribing ? '正在识别语音…' : speaking ? (voiceConversation ? '正在回答，您可以直接说话打断' : '正在为您播报') : busy ? (routingStage || '正在整理答复') : listening ? '正在聆听，说完自动发送' : '请问有什么可以帮您？'}</p>
            <div className="dh-host-controls">
              <button disabled={busy} aria-pressed={realtimeMode} title="开启后支持流式播报、自动断句与连续对话" onClick={() => { const next = !realtimeMode; endVoiceConversation(); silence(); realtimeModeRef.current = next; setRealtimeMode(next) }}><Radio size={20}/> {realtimeMode ? '实时模式：开' : '实时模式：关'}</button>
              {!realtimeMode && <>
              <button disabled={!voiceAvailable} title={usingDeepSeekTts ? '使用 DeepSeek 语音合成' : voice ? '使用设备本地中文声音' : '当前设备没有可用的本地中文声音'} aria-pressed={voiceOn} onClick={() => { const enabled = !voiceOn; voiceEnabled.current = enabled; setVoiceOn(enabled); if (!enabled) silence(); else speak(`您好，我是${dhConfig.display_name || '麦溪'}，请问有什么可以帮您？`) }}>{voiceOn ? <Volume2 size={20}/> : <VolumeX size={20}/>} {voiceAvailable ? voiceOn ? '关闭播报' : '开启播报' : '语音不可用'}</button>
              <button className={`dh-dictate${listening || voiceConversation ? ' is-listening' : ''}`} disabled={!canDictate || (!voiceConversation && (transcribing || (busy && !realtimeMode)))} aria-pressed={voiceConversation || listening}
                title={realtimeMode ? (voiceConversation ? '结束后释放麦克风并停止当前答复' : usingDeepSeekAsr ? '持续聆听，停顿后自动发送；回答时可直接说话打断' : '回答结束后自动继续聆听；可点击停止回答后继续提问') : '点击开始语音提问，再次点击结束录音'}
                onClick={toggleDictation}>{voiceConversation || listening ? <MicOff size={20}/> : <Mic size={20}/>} {realtimeMode ? (voiceConversation ? '结束对话' : '开始对话') : listening ? '结束语音' : transcribing ? '识别中…' : canDictate ? '语音提问' : '语音不可用'}</button>
              {speaking && <button onClick={silence}><Square size={18}/>停止播报</button>}
              </>}
            </div>
            {voiceAvailable && <details className="dh-voice-settings"><summary>声音设置</summary>{usingDeepSeekTts ? <label>音色<select aria-label="播报音色" value={deepseekVoice} onChange={e => { silence(); setVoiceId(e.target.value) }}><option value="stella">海星（女声）</option><option value="tide">暗潮（男声）</option></select></label> : voices.length > 1 && <label>音色<select aria-label="播报音色" value={voice!.voiceURI} onChange={e => { silence(); setVoiceId(e.target.value) }}>{voices.map(v => <option value={v.voiceURI} key={v.voiceURI}>{v.name}</option>)}</select></label>}<label>语速<select aria-label="播报语速" value={voiceRate} onChange={e => { silence(); setVoiceRate(Number(e.target.value)) }}><option value={0.8}>慢速</option><option value={0.9}>舒缓</option><option value={1}>正常</option></select></label></details>}
        </section>
        <section className="dh-consultation" aria-label={realtimeMode ? 'Dynamic UI 实时交互区' : '智能咨询对话'}>
          <ConsoleFrame/>
          <header className="dh-chat-heading"><h2>{realtimeMode ? (dynamicUi?.title || `${dhConfig.display_name || '麦溪'} · 实时交互`) : `与${dhConfig.display_name || '麦溪'}对话`}</h2><div>{realtimeMode && dynamicUi && <button type="button" onClick={() => setDynamicUi(null)}>清空视图</button>}<button aria-pressed={largeText} onClick={() => setLargeText(value => !value)}>大字</button><button onClick={() => { setDynamicUi(null); setLiveCaption(''); changeSession(newAssistantSession()) }} disabled={busy}><Plus size={18}/>新咨询</button></div></header>
          {realtimeMode ? (
            <div className="dh-dynamic-stage">
              {liveCaption && <div className="dh-realtime-caption" role="status" aria-live="polite">
                <strong>{dhConfig.display_name || '麦溪'}</strong>
                <p>{liveCaption}</p>
              </div>}
              {backgroundTasks.some(task => task.status !== 'completed') && <div className="dh-background-tasks" aria-label="后台协作任务">
                {backgroundTasks.filter(task => task.status !== 'completed').slice(0, 3).map(task => <div className="dh-background-task" key={task.id} data-status={task.status}>
                  <strong>{task.title}</strong><span role="status">{task.stage}</span>
                </div>)}
              </div>}
              {dynamicUi ? (
                (dynamicUi.blocks?.length || dynamicUi.sourceText) ? (
                  <DynamicUiRenderer blocks={dynamicUi.blocks || []} fallbackText={dynamicUi.sourceText} onAction={prompt => submitText(prompt)} />
                ) : dynamicUi.html ? (
                  <iframe
                    ref={iframeRef}
                    className="dh-dynamic-frame"
                    title={dynamicUi.title}
                    sandbox="allow-scripts"
                    srcDoc={wrapDynamicHtml(dynamicUi.html)}
                  />
                ) : null
              ) : (
                <div className="dh-dynamic-standby">
                  <p>{dhConfig.greeting || '您好，请问有什么可以帮您？'} 点击下方麦克风开始对话，或选择快捷互动主题：</p>
                  <div className="dh-dynamic-chips">
                    <button type="button" onClick={() => submitText('帮我研究一下小米公司最新财报并做可视化图表对比')}>研究小米财报图表</button>
                    <button type="button" onClick={() => submitText('给我出两道人工智能知识选择题，让我互动答题')}>AI 互动选择题</button>
                    <button type="button" onClick={() => submitText('帮我梳理最近一周人工智能领域重点动态')}>近期 AI 重点动态</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
          <div className="dh-conversation-body">
          <div ref={messagesRef} className="dh-messages" role="log" aria-label="咨询消息" aria-live="polite" aria-relevant="additions text" tabIndex={0} onScroll={() => {
            if (!messagesRef.current) return
            followReplies.current = isNearConversationEnd(messagesRef.current)
            if (followReplies.current) setShowLatest(false)
          }}>
            <div className="dh-message assistant"><span className="dh-message-avatar" aria-hidden="true">{(dhConfig.display_name || '麦溪').slice(0, 1)}</span><div className="dh-bubble"><strong className="dh-speaker">{dhConfig.display_name || '麦溪'}</strong><p>{dhConfig.greeting || '您好，请问有什么可以帮您？'}</p></div></div>
            {session.messages.map(message => <article key={message.id} className={`dh-message ${message.role}`}><span className="dh-message-avatar" aria-hidden="true">{message.role === 'user' ? '您' : (dhConfig.display_name || '麦溪').slice(0, 1)}</span><div className={`dh-bubble ${message.state || ''}`}><strong className="dh-speaker">{message.role === 'user' ? '您' : (dhConfig.display_name || '麦溪')}</strong>{message.state === 'pending' && !message.text ? <p className="dh-waiting" role="status"><span/>{routingStage || '正在整理答复，请稍候。'}</p> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{message.text}</ReactMarkdown>}{message.role === 'assistant' && !message.state && voiceAvailable && <button className="dh-read-reply" aria-pressed={readingId === message.id} onClick={() => { if (readingId === message.id) silence(); else speak(message.text, message.id, true) }}>{readingId === message.id ? <Square size={18}/> : <Volume2 size={18}/>} {readingId === message.id ? '停止朗读' : '朗读答复'}</button>}</div></article>)}
          </div>
          {showLatest && <button type="button" className="dh-jump-latest" onClick={scrollToLatest}><ArrowDown size={18}/>查看新答复</button>}
          </div>
          )}
          {realtimeMode ? <div className="dh-voice-composer">
            {notice && <p role="alert" className="dh-inline-notice">{notice}</p>}
            <button type="button" className={`dh-voice-trigger${voiceConversation ? ' is-active' : ''}`}
              aria-label={voiceConversation ? '结束实时对话' : '开始实时对话'} aria-pressed={voiceConversation}
              disabled={!canDictate && !voiceConversation} onClick={toggleDictation}>
              {voiceConversation ? <MicOff size={36} aria-hidden="true"/> : <Mic size={36} aria-hidden="true"/>}
            </button>
            <span className="dh-voice-action">{canDictate || voiceConversation ? voiceConversation ? '结束实时对话' : '点击麦克风开始对话' : '语音输入暂不可用'}</span>
          </div> : <form className="dh-composer" onSubmit={event => { event.preventDefault(); send() }}>
            {notice && <p role="alert" className="dh-inline-notice">{notice}</p>}
            <textarea id="dh-input" aria-label="咨询问题" ref={inputRef} rows={3} value={input} onChange={event => setInput(event.target.value)} maxLength={50000} placeholder="请在这里输入您的问题…" onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }}/>
            <div className="dh-composer-footer">{busy ? <button type="button" className="dh-send" disabled={stopping} onClick={() => void stop()}><Square size={19}/>{stopping ? '正在停止' : '停止回答'}</button> : <button className="dh-send" disabled={!input.trim()}><Send size={19}/>发送</button>}</div>
          </form>}
        </section>
      </div><footer className="dh-footer"><span>AegisMesh</span><span>内容由AI生成，可能不准确</span></footer>
    </main>
    {settingsOpen && <SettingsDialog settings={settings} onChange={updateSettings} onClose={() => setSettingsOpen(false)} onClear={clearHistory}/>}
  </>
}
