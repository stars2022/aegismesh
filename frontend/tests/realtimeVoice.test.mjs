import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// Application imports use bundler-style relative specifiers; resolve them in Node too.
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context)
    throw error
  }
} })
const { createRealtimeSpeechQueue } = await import('../src/realtimeSpeechQueue.ts')
const { createVoiceActivityGate, startRealtimeVoiceInput } = await import('../src/realtimeVoiceInput.ts')
const { createStreamingSpeechPlayer } = await import('../src/streamingSpeechPlayer.ts')
const { createSpeechInput } = await import('../src/speechInput.ts')
const tick = () => new Promise(resolve => setImmediate(resolve))

function audioFixture(t) {
  const oldAudio = globalThis.Audio
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL
  const audios = [], revoked = [], fetches = [], states = [], errors = [], done = []
  globalThis.Audio = class {
    constructor(url) { this.url = url; audios.push(this) }
    play() { this.onplay?.(); return Promise.resolve() }
    pause() { this.paused = true }
  }
  URL.createObjectURL = () => `blob:audio-${audios.length}`
  URL.revokeObjectURL = url => revoked.push(url)
  t.after(() => { globalThis.Audio = oldAudio; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke })
  const player = createRealtimeSpeechQueue({
    fetchAudio: async (text, signal) => { fetches.push({ text, signal }); return new Blob(['wave']) },
    getPlaybackRate: () => 1, onSpeaking: v => states.push(v), onError: () => errors.push(true), onAllDone: () => done.push(true),
  })
  t.after(() => player.dispose())
  return { player, audios, revoked, fetches, states, errors, done }
}

test('prefetch is bounded and completion occurs exactly once after all audio', async t => {
  const f = audioFixture(t)
  f.player.pushSpeech('第一句。第二句。第三句。第四句。')
  f.player.flush(); f.player.flush()
  await tick()
  assert.equal(f.fetches.length, 2)
  assert.equal(f.audios.length, 1)
  assert.equal(f.done.length, 0)
  for (let i = 0; i < 4; i++) { f.audios[i].onended(); await tick() }
  assert.equal(f.fetches.length, 4)
  assert.equal(f.done.length, 1)
  assert.equal(f.player.isActive(), false)
  assert.equal(f.revoked.length, 4)
})

test('interrupting active speech aborts both requests and stale completion cannot stop the new reply', async t => {
  const f = audioFixture(t)
  f.player.pushSpeech('旧答复第一句。旧答复第二句。'); f.player.flush()
  await tick()
  const staleEnd = f.audios[0].onended
  f.player.cancel()
  assert.ok(f.fetches.every(item => item.signal.aborted))
  f.player.pushSpeech('新答复。'); f.player.flush()
  await tick()
  staleEnd()
  await tick()
  assert.equal(f.audios[1].paused, undefined)
  assert.equal(f.player.isActive(), true)
  f.audios[1].onended(); await tick()
  assert.equal(f.done.length, 1)
  assert.equal(f.errors.length, 0)
})

test('audio may finish before response flush; follow-up still receives completion', async t => {
  const f = audioFixture(t)
  f.player.pushSpeech('你好。'); await tick()
  f.audios[0].onended(); await tick()
  assert.equal(f.done.length, 0)
  f.player.flush()
  assert.equal(f.done.length, 1)
})

test('VAD ignores isolated noise and retains complete words across a conversational pause', () => {
  const starts = [], utterances = []
  const gate = createVoiceActivityGate(16000, { onSpeechStart: () => starts.push(true), onUtterance: samples => utterances.push(samples) })
  const frame = amplitude => new Float32Array(800).fill(amplitude)
  gate.push(frame(.1)); for (let i = 0; i < 25; i++) gate.push(frame(0))
  assert.equal(starts.length, 0)
  for (let i = 0; i < 8; i++) gate.push(frame(.15))
  for (let i = 0; i < 10; i++) gate.push(frame(0))
  assert.equal(utterances.length, 0)
  for (let i = 0; i < 5; i++) gate.push(frame(.15))
  for (let i = 0; i < 20; i++) gate.push(frame(0))
  assert.equal(starts.length, 1)
  assert.equal(utterances.length, 1)
  for (let i = 0; i < 8; i++) gate.push(frame(.2))
  for (let i = 0; i < 20; i++) gate.push(frame(0))
  assert.equal(starts.length, 2)
  assert.equal(utterances.length, 2)
})

test('continuous sound is capped and cannot create an endless sequence of ASR submissions', () => {
  const utterances = []
  const gate = createVoiceActivityGate(16000, { maxSeconds: 1, onSpeechStart() {}, onUtterance: x => utterances.push(x) })
  for (let i = 0; i < 200; i++) gate.push(new Float32Array(800).fill(.2))
  assert.equal(utterances.length, 1)
  assert.ok(utterances[0].length <= 16000)
})

test('cancelled browser recognition never submits stale text or restarts the microphone', t => {
  const original = globalThis.window
  let recognition, results = 0, ended = 0
  globalThis.window = { SpeechRecognition: class { constructor() { recognition = this } start() {} stop() {} abort() { this.onend?.() } } }
  t.after(() => { globalThis.window = original })
  const input = createSpeechInput({ onText() { results++ }, onEnd() { ended++ }, onError() {} })
  const staleResult = recognition.onresult, staleEnd = recognition.onend
  input.cancel()
  staleResult({ results: [{ isFinal: true, 0: { transcript: '旧问题' } }] }); staleEnd()
  assert.equal(results, 0)
  assert.equal(ended, 0)
})

test('PCM playback starts before EOF and preserves samples split across network frames', async t => {
  const original = globalThis.window
  const buffers = [], sources = []
  globalThis.window = { AudioContext: class {
    state = 'running'; currentTime = 0; destination = {}
    resume() { return Promise.resolve() }
    close() { this.state = 'closed'; return Promise.resolve() }
    createBuffer(channels, length, rate) {
      const samples = new Float32Array(length); buffers.push(samples)
      return { duration: length / rate, getChannelData: () => samples }
    }
    createBufferSource() {
      const source = { playbackRate: {}, connect() {}, disconnect() {}, stop() { this.stopped = true }, start() { queueMicrotask(() => this.onended?.()) } }
      sources.push(source); return source
    }
  } }
  t.after(() => { globalThis.window = original })
  let producer, playing = 0
  const stream = new ReadableStream({ start(controller) { producer = controller } })
  const player = createStreamingSpeechPlayer()
  const promise = player.play({ stream, sampleRate: 24000 }, new AbortController().signal, 1, () => { playing++ })
  producer.enqueue(new Uint8Array([0])); producer.enqueue(new Uint8Array([128, 255, 127]))
  await tick()
  assert.equal(playing, 1)
  assert.deepEqual([...buffers[0]], [-1, 32767 / 32768])
  producer.close(); await promise
  player.dispose()
})

test('cancelling a pending permission request releases a late microphone stream', async t => {
  const oldWindow = globalThis.window, oldNavigator = globalThis.navigator
  let grant, stopped = 0, closed = 0
  globalThis.window = { AudioContext: class {
    sampleRate = 48000
    resume() { return Promise.resolve() }
    close() { closed++; return Promise.resolve() }
  } }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve }) } } })
  t.after(() => { globalThis.window = oldWindow; Object.defineProperty(globalThis, 'navigator', { configurable: true, value: oldNavigator }) })
  const abort = new AbortController()
  const capture = startRealtimeVoiceInput({ signal: abort.signal, onSpeechStart() {}, onUtterance() {}, onError() {} })
  abort.abort()
  grant({ getTracks: () => [{ stop() { stopped++ } }] })
  await assert.rejects(capture, { name: 'AbortError' })
  assert.equal(stopped, 1)
  assert.equal(closed, 1)
})
