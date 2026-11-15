import { speechText } from './assistantConversation'
import { createStreamingSpeechPlayer, type PcmSpeechAudio } from './streamingSpeechPlayer'

const SENTENCE_END = /([。！？；\n]|[.!?](?=\s|$)|[，、,])/

/**
 * Split a streaming text buffer into complete, speakable clauses/sentences while keeping
 * any incomplete trailing fragment in `remainder`.
 */
export function extractCompleteSentences(buffer: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = []
  let pending = ''
  let rest = buffer

  while (rest.length > 0) {
    const match = SENTENCE_END.exec(rest)
    if (!match) break
    const cut = match.index + match[0].length
    const piece = rest.slice(0, cut)
    rest = rest.slice(cut)
    pending += piece
    const isComma = match[0] === '，' || match[0] === '、' || match[0] === ','
    const minLen = isComma ? 16 : 8
    if (pending.trim().length >= minLen || match[0] === '\n') {
      const cleaned = pending.trim()
      if (cleaned) sentences.push(cleaned)
      pending = ''
    }
  }

  return { sentences, remainder: pending + rest }
}

type QueueItem = {
  text: string
  audioPromise?: Promise<Blob | PcmSpeechAudio>
  abort: AbortController
}

export type RealtimeSpeechQueueOptions = {
  fetchAudio: (text: string, signal: AbortSignal) => Promise<Blob | PcmSpeechAudio>
  getPlaybackRate: () => number
  onSpeaking: (speaking: boolean) => void
  onSentenceStart?: (sentence: string) => void
  onError: (reason?: unknown) => void
  onAllDone?: () => void
}

/**
 * Pipelined sentence-level TTS queue: pre-fetches upcoming sentences in the
 * background while playing the current sentence sequentially.
 */
export function createRealtimeSpeechQueue(options: RealtimeSpeechQueueOptions) {
  let generation = 0
  let buffer = ''
  let flushed = false
  let playing = false
  let activeAudio: HTMLAudioElement | null = null
  let activeUrl = ''
  const queue: QueueItem[] = []
  const inFlight = new Set<QueueItem>()
  const streamPlayer = createStreamingSpeechPlayer()
  let releasePlayback: (() => void) | undefined
  let completed = false

  const stopAudio = () => {
    if (activeAudio) {
      activeAudio.pause()
      activeAudio.onplay = null
      activeAudio.onended = null
      activeAudio.onerror = null
      activeAudio = null
    }
    if (activeUrl) {
      URL.revokeObjectURL(activeUrl)
      activeUrl = ''
    }
    releasePlayback?.()
    releasePlayback = undefined
  }

  const prefetch = (item: QueueItem) => {
    if (item.audioPromise) return
    inFlight.add(item)
    item.audioPromise = Promise.resolve().then(() => {
      if (item.abort.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return options.fetchAudio(item.text, item.abort.signal)
    })
    item.audioPromise.catch(() => undefined)
  }
  const fillPrefetch = () => {
    for (const item of queue) {
      if (inFlight.size >= 2) break
      prefetch(item)
    }
  }
  const complete = () => {
    if (completed || !flushed || playing || queue.length) return
    completed = true
    options.onSpeaking(false)
    options.onAllDone?.()
  }

  const enqueueClean = (rawText: string) => {
    const run = generation
    const parts = speechText(rawText)
    for (const part of parts) {
      const text = part.trim()
      if (!text) continue
      const abort = new AbortController()
      queue.push({ text, abort })
    }
    if (!playing && queue.length > 0 && run === generation) {
      void drain(run)
    }
  }

  const drain = async (run: number) => {
    if (playing) return
    playing = true
    try {
      while (run === generation && queue.length > 0) {
        const item = queue.shift()!
        prefetch(item)
        fillPrefetch()
        let blob: Blob | PcmSpeechAudio
        try {
          blob = await item.audioPromise!
        } catch (error) {
          if (run !== generation || item.abort.signal.aborted) return
          inFlight.delete(item)
          options.onError(error)
          continue
        }
        if (run !== generation) return
        if ('sampleRate' in blob) {
          try {
            await streamPlayer.play(blob, item.abort.signal, Math.min(1.1, Math.max(.75, options.getPlaybackRate())), () => {
              if (run === generation) {
                options.onSpeaking(true)
                options.onSentenceStart?.(item.text)
              }
            })
          } catch (error) {
            if (run === generation && !item.abort.signal.aborted) options.onError(error)
          }
          if (run !== generation) return
          inFlight.delete(item)
          continue
        }
        const url = URL.createObjectURL(blob)
        activeUrl = url
        const audio = new Audio(url)
        audio.playbackRate = Math.min(1.1, Math.max(0.75, options.getPlaybackRate()))
        activeAudio = audio

        await new Promise<void>(resolve => {
          releasePlayback = resolve
          audio.onplay = () => {
            if (run === generation) {
              options.onSpeaking(true)
              options.onSentenceStart?.(item.text)
            }
          }
          audio.onended = () => resolve()
          audio.onerror = () => {
            if (run === generation) options.onError()
            resolve()
          }
          void audio.play().catch(() => {
            if (run === generation) options.onError()
            resolve()
          })
        })
        if (run !== generation) return
        stopAudio()
        inFlight.delete(item)
      }
      if (run === generation) {
        options.onSpeaking(false)
      }
    } finally {
      if (run === generation) { playing = false; complete() }
    }
  }

  return {
    pushDelta(delta: string) {
      if (!delta || flushed) return
      buffer += delta
      const { sentences, remainder } = extractCompleteSentences(buffer)
      buffer = remainder
      for (const sentence of sentences) enqueueClean(sentence)
    },
    pushSpeech(text: string) {
      if (text.trim() && !flushed) enqueueClean(text)
    },
    prime() { streamPlayer.prime() },
    flush() {
      if (flushed) return
      flushed = true
      const tail = buffer.trim()
      buffer = ''
      if (tail) enqueueClean(tail)
      else complete()
    },
    cancel() {
      generation += 1
      buffer = ''
      flushed = false
      completed = false
      playing = false
      for (const item of inFlight) item.abort.abort()
      inFlight.clear()
      while (queue.length > 0) queue.shift()?.abort.abort()
      stopAudio()
      options.onSpeaking(false)
    },
    isActive() {
      return playing || queue.length > 0
    },
    dispose() { this.cancel(); streamPlayer.dispose() },
  }
}
