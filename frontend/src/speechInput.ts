/** 浏览器自带的语音识别（Chrome / Edge / Safari 提供，Firefox 不支持）。 */
type RecognitionResult = { isFinal: boolean; 0: { transcript: string } }
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> }
type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void; stop: () => void; abort: () => void
}
type RecognitionConstructor = new () => Recognition

function recognitionConstructor(): RecognitionConstructor | null {
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null
}

export function speechInputSupported() {
  return typeof window !== 'undefined' && recognitionConstructor() !== null
}

const errorMessages: Record<string, string> = {
  'not-allowed': '没有获得麦克风权限。请在浏览器地址栏允许使用麦克风后再试。',
  'service-not-allowed': '浏览器暂不允许语音识别，请改用文字输入。',
  'audio-capture': '没有检测到麦克风，请检查设备后再试。',
  'no-speech': '没有听到声音，请靠近麦克风再说一次。',
  network: '语音识别服务暂时连不上，请稍后再试或改用文字输入。',
}

export type SpeechInput = { start: () => void; stop: () => void; cancel: () => void }

/**
 * 说完一句话后自动结束。`onText` 收到本次识别到的完整文字（含尚未确认的部分），
 * `onEnd` 在结束时调用；出错时 `onError` 收到可直接展示的中文提示。
 */
export function createSpeechInput(handlers: { onText: (text: string, final: boolean) => void; onEnd: () => void; onError: (message: string) => void }): SpeechInput | null {
  const Constructor = recognitionConstructor()
  if (!Constructor) return null
  const recognition = new Constructor()
  recognition.lang = 'zh-CN'
  recognition.interimResults = true
  recognition.continuous = false
  recognition.maxAlternatives = 1
  recognition.onresult = event => {
    let text = ''
    let final = true
    for (let index = 0; index < event.results.length; index++) {
      text += event.results[index][0].transcript
      if (!event.results[index].isFinal) final = false
    }
    handlers.onText(text.trim(), final)
  }
  recognition.onerror = event => {
    if (event.error !== 'aborted') handlers.onError(errorMessages[event.error] || '语音识别没有成功，请再试一次。')
  }
  recognition.onend = () => handlers.onEnd()
  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
    cancel: () => recognition.abort(),
  }
}
