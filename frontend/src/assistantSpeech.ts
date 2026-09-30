type Engine = Pick<SpeechSynthesis, 'speak' | 'cancel'>
type Callbacks = { onSpeaking: (speaking: boolean) => void; onError: () => void; onIdle?: () => void }

/** Retain one utterance at a time; cancelled callbacks cannot affect a newer reply. */
export function createAssistantSpeech(engine: Engine, callbacks: Callbacks,
  makeUtterance: (text: string) => SpeechSynthesisUtterance = text => new SpeechSynthesisUtterance(text)) {
  let generation = 0
  let active: SpeechSynthesisUtterance | null = null
  const stop = () => {
    generation += 1
    active = null
    engine.cancel()
    callbacks.onSpeaking(false)
    callbacks.onIdle?.()
  }
  const play = (parts: string[], voice: SpeechSynthesisVoice, rate: number) => {
    stop()
    const run = generation
    const queue = parts.filter(text => text.trim())
    let index = 0
    const next = () => {
      if (run !== generation) return
      if (index >= queue.length) { active = null; callbacks.onSpeaking(false); callbacks.onIdle?.(); return }
      try {
        const utterance = makeUtterance(queue[index++])
        active = utterance
        utterance.voice = voice
        utterance.lang = voice.lang
        utterance.rate = Math.min(1.1, Math.max(0.75, rate))
        const current = () => run === generation && active === utterance
        utterance.onstart = () => { if (current()) callbacks.onSpeaking(true) }
        utterance.onpause = () => { if (current()) callbacks.onSpeaking(false) }
        utterance.onresume = () => { if (current()) callbacks.onSpeaking(true) }
        utterance.onend = () => { if (current()) { active = null; next() } }
        utterance.onerror = event => {
          if (!current()) return
          generation += 1; active = null; callbacks.onSpeaking(false); callbacks.onIdle?.()
          if (!['canceled', 'interrupted'].includes(event.error)) callbacks.onError()
        }
        engine.speak(utterance)
      } catch {
        generation += 1; active = null; callbacks.onSpeaking(false); callbacks.onIdle?.(); callbacks.onError()
      }
    }
    next()
    return run === generation && active !== null
  }
  return { play, stop }
}
