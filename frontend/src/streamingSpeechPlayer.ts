export type PcmSpeechAudio = { stream: ReadableStream<Uint8Array>; sampleRate: number }

/** Play signed little-endian PCM as it arrives, with bounded audio scheduling. */
export function createStreamingSpeechPlayer() {
  let context: AudioContext | null = null
  const getContext = () => {
    if (!context || context.state === 'closed') {
      const Constructor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!Constructor) throw new Error('当前浏览器不支持流式音频')
      context = new Constructor()
    }
    return context
  }
  return {
    prime() {
      try { void getContext().resume().catch(() => undefined) } catch { /* Report only on actual playback. */ }
    },
    async play(audio: PcmSpeechAudio, signal: AbortSignal, rate: number, onPlaying: () => void) {
      const ctx = getContext()
      const reader = audio.stream.getReader()
      const sources = new Set<AudioBufferSourceNode>()
      let tail: Uint8Array = new Uint8Array(0)
      let nextAt = ctx.currentTime
      let started = false
      let wake: (() => void) | undefined
      const abort = () => {
        void reader.cancel().catch(() => undefined)
        for (const source of sources) { source.onended = null; source.stop(); source.disconnect() }
        sources.clear()
        wake?.()
      }
      const wait = () => new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve() }, 20)
        wake = () => { clearTimeout(timer); wake = undefined; resolve() }
      })
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        await ctx.resume()
        if (ctx.state !== 'running') throw new Error('请点击页面后开启语音播报')
        while (!signal.aborted) {
          // A slow listener must not accumulate minutes of scheduled audio.
          while (nextAt - ctx.currentTime > 1 && !signal.aborted) await wait()
          const { value, done } = await reader.read()
          if (signal.aborted) break
          if (value?.length) {
            const bytes = new Uint8Array(tail.length + value.length)
            bytes.set(tail); bytes.set(value, tail.length)
            const aligned = bytes.length - bytes.length % 2
            tail = bytes.slice(aligned)
            // Network frame boundaries need not coincide with PCM samples.
            for (let offset = 0; offset < aligned; offset += 8192) {
              while (nextAt - ctx.currentTime > 1 && !signal.aborted) await wait()
              if (signal.aborted) break
              const length = Math.min(8192, aligned - offset) / 2
              const buffer = ctx.createBuffer(1, length, audio.sampleRate)
              const samples = buffer.getChannelData(0)
              const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length * 2)
              for (let i = 0; i < length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
              const source = ctx.createBufferSource()
              source.buffer = buffer
              source.playbackRate.value = rate
              source.connect(ctx.destination)
              sources.add(source)
              source.onended = () => { sources.delete(source); source.disconnect(); wake?.() }
              nextAt = Math.max(nextAt, ctx.currentTime + .02)
              source.start(nextAt)
              nextAt += buffer.duration / rate
              if (!started) { started = true; onPlaying() }
            }
          }
          if (done) break
        }
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        if (tail.length || !started) throw new Error('语音流不完整')
        while (sources.size && !signal.aborted) await wait()
      } finally {
        signal.removeEventListener('abort', abort)
        abort()
        reader.releaseLock()
      }
    },
    dispose() { if (context) { void context.close().catch(() => undefined); context = null } },
  }
}
