import { downsampleTo16k, encodePcm16Wav } from './wavEncoder'

export type VoiceActivityOptions = {
  onSpeechStart: () => void
  onUtterance: (samples: Float32Array) => void
  silenceMs?: number
  maxSeconds?: number
}

/** Bounded PCM utterances with a short pre-roll; isolated clicks cannot trigger a turn. */
export function createVoiceActivityGate(sampleRate: number, options: VoiceActivityOptions) {
  let preRoll: Float32Array[] = []
  let preRollSize = 0
  let chunks: Float32Array[] = []
  let size = 0
  let speechMs = 0
  let quietMs = 0
  let active = false
  let waitForQuiet = false
  const silenceMs = options.silenceMs ?? 950
  const maxSamples = sampleRate * (options.maxSeconds ?? 30)
  const reset = () => {
    preRoll = []; preRollSize = 0; chunks = []; size = 0
    speechMs = 0; quietMs = 0; active = false
  }
  return {
    push(samples: Float32Array) {
      if (!samples.length) return
      const durationMs = samples.length / sampleRate * 1000
      let energy = 0
      for (const value of samples) energy += value * value
      const voiced = Math.sqrt(energy / samples.length) > .018
      quietMs = voiced ? 0 : quietMs + durationMs
      if (waitForQuiet) {
        if (quietMs >= silenceMs) { reset(); waitForQuiet = false }
        return
      }
      const copy = samples.slice()
      if (!active) {
        preRoll.push(copy); preRollSize += copy.length
        while (preRoll.length > 1 && preRollSize - preRoll[0].length >= sampleRate * .3) {
          preRollSize -= preRoll.shift()!.length
        }
        speechMs = voiced ? speechMs + durationMs : 0
        if (speechMs < 180) return
        active = true; chunks = preRoll; size = preRollSize; preRoll = []; preRollSize = 0
        options.onSpeechStart()
      } else {
        const part = copy.subarray(0, Math.max(0, maxSamples - size))
        chunks.push(part); size += part.length
      }
      if (quietMs >= silenceMs || size >= maxSamples) {
        const capped = size >= maxSamples
        const utterance = new Float32Array(size)
        let offset = 0
        for (const chunk of chunks) { utterance.set(chunk, offset); offset += chunk.length }
        reset(); waitForQuiet = capped
        options.onUtterance(utterance)
      }
    },
    cancel() { reset(); waitForQuiet = false },
  }
}

export type RealtimeVoiceInput = { cancel: () => void }

/** Keep one echo-cancelled microphone open across recognition, generation and speech. */
export async function startRealtimeVoiceInput(options: {
  signal?: AbortSignal
  onSpeechStart: () => void
  onUtterance: (wav: Blob) => void
  onError: (message: string) => void
}): Promise<RealtimeVoiceInput> {
  const Constructor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  if (!Constructor) throw new Error('当前浏览器不支持持续语音，请使用语音提问或文字输入')
  const context = new Constructor()
  let stream: MediaStream | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let processor: ScriptProcessorNode | null = null
  let gain: GainNode | null = null
  let stopped = false
  const gate = createVoiceActivityGate(context.sampleRate, {
    onSpeechStart: options.onSpeechStart,
    onUtterance(samples) {
      if (!stopped) options.onUtterance(new Blob([encodePcm16Wav(downsampleTo16k(samples, context.sampleRate))], { type: 'audio/wav' }))
    },
  })
  const cancel = () => {
    if (stopped) return
    stopped = true
    options.signal?.removeEventListener('abort', cancel)
    gate.cancel()
    if (processor) { processor.onaudioprocess = null; processor.disconnect() }
    source?.disconnect(); gain?.disconnect()
    stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
    void context.close().catch(() => undefined)
  }
  try {
    // Resume in the initiating user gesture, before the permission prompt resolves.
    const resumed = context.resume()
    resumed.catch(() => undefined)
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
    if (stopped || options.signal?.aborted) {
      stream.getTracks().forEach(track => track.stop())
      throw new DOMException('Aborted', 'AbortError')
    }
    await resumed
    source = context.createMediaStreamSource(stream)
    // ScriptProcessor remains supported by Safari and Chrome; only mono PCM is retained.
    processor = context.createScriptProcessor(2048, 1, 1)
    gain = context.createGain(); gain.gain.value = 0
    processor.onaudioprocess = event => { if (!stopped) gate.push(event.inputBuffer.getChannelData(0)) }
    source.connect(processor); processor.connect(gain); gain.connect(context.destination)
    for (const track of stream.getAudioTracks()) track.onended = () => {
      if (!stopped) { cancel(); options.onError('麦克风连接已断开，请重新开始语音对话') }
    }
    return { cancel }
  } catch (error) {
    cancel()
    throw error
  }
}
