/**
 * Encode mono PCM samples into a standard 16-bit RIFF WAV buffer,
 * and provide a browser MediaRecorder -> 16kHz mono WAV capture helper.
 */

export function downsampleTo16k(samples: Float32Array, sourceRate: number): Float32Array {
  const targetRate = 16000
  if (sourceRate <= 0 || sourceRate === targetRate) return samples
  const ratio = sourceRate / targetRate
  const length = Math.max(1, Math.round(samples.length / ratio))
  const output = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio))
    if (end <= start) {
      output[i] = samples[Math.min(start, samples.length - 1)] || 0
    } else {
      let sum = 0
      for (let j = start; j < end; j++) sum += samples[j]
      output[i] = sum / (end - start)
    }
  }
  return output
}

export function encodePcm16Wav(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }
  return buffer
}

export async function blobToMono16kWav(blob: Blob): Promise<Blob> {
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) throw new Error('当前浏览器不支持音频解码')
  const ctx = new AudioCtx()
  try {
    const arrayBuffer = await blob.arrayBuffer()
    const decoded = await ctx.decodeAudioData(arrayBuffer)
    const length = decoded.length
    const channels = decoded.numberOfChannels
    const mono = new Float32Array(length)
    for (let ch = 0; ch < channels; ch++) {
      const data = decoded.getChannelData(ch)
      for (let i = 0; i < length; i++) mono[i] += data[i] / channels
    }
    const resampled = downsampleTo16k(mono, decoded.sampleRate)
    const wavBuffer = encodePcm16Wav(resampled, 16000)
    return new Blob([wavBuffer], { type: 'audio/wav' })
  } finally {
    await ctx.close().catch(() => undefined)
  }
}

export function mediaRecorderSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined'
  )
}

export type AudioRecorderSession = {
  stop: () => Promise<Blob>
  cancel: () => void
}

export type WavRecorderOptions = {
  vad?: boolean
  silenceMs?: number
  onSilenceStop?: () => void
}

export async function startWavRecorder(options: WavRecorderOptions = {}): Promise<AudioRecorderSession> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const chunks: BlobPart[] = []
  const recorder = new MediaRecorder(stream)
  let cancelled = false
  let vadTimer: number | null = null
  let vadCtx: AudioContext | null = null

  const cleanupVad = () => {
    if (vadTimer !== null) {
      window.clearInterval(vadTimer)
      vadTimer = null
    }
    if (vadCtx) {
      void vadCtx.close().catch(() => undefined)
      vadCtx = null
    }
  }

  if (options.vad) {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (AudioCtx) {
        vadCtx = new AudioCtx()
        const source = vadCtx.createMediaStreamSource(stream)
        const analyser = vadCtx.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)
        const samples = new Float32Array(analyser.fftSize)
        const silenceThresholdMs = options.silenceMs ?? 1400
        let heardSpeech = false
        let speechFrames = 0
        let lastVoiceAt = performance.now()
        let triggered = false
        vadTimer = window.setInterval(() => {
          if (triggered || recorder.state !== 'recording') return
          analyser.getFloatTimeDomainData(samples)
          let sum = 0
          for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
          const rms = Math.sqrt(sum / samples.length)
          const now = performance.now()
          if (rms > 0.018) {
            speechFrames += 1
            if (speechFrames >= 2) heardSpeech = true
            lastVoiceAt = now
          } else if (heardSpeech && now - lastVoiceAt >= silenceThresholdMs) {
            triggered = true
            cleanupVad()
            options.onSilenceStop?.()
          }
        }, 80)
      }
    } catch {
      cleanupVad()
    }
  }

  recorder.ondataavailable = event => {
    if (event.data && event.data.size > 0) chunks.push(event.data)
  }

  const stoppedPromise = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = async () => {
      cleanupVad()
      stream.getTracks().forEach(track => track.stop())
      if (cancelled) {
        reject(new Error('cancelled'))
        return
      }
      try {
        const rawBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        const wavBlob = await blobToMono16kWav(rawBlob)
        resolve(wavBlob)
      } catch (err) {
        reject(err)
      }
    }
    recorder.onerror = () => {
      cleanupVad()
      stream.getTracks().forEach(track => track.stop())
      reject(new Error('录音失败，请检查麦克风权限'))
    }
  })

  // cancel() is also used on unmount without stop(); still observe its rejection.
  stoppedPromise.catch(() => undefined)
  recorder.start()
  return {
    stop: () => {
      cleanupVad()
      if (recorder.state !== 'inactive') recorder.stop()
      return stoppedPromise
    },
    cancel: () => {
      cancelled = true
      cleanupVad()
      if (recorder.state !== 'inactive') recorder.stop()
      else stream.getTracks().forEach(track => track.stop())
    },
  }
}
