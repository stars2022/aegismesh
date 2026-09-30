import test from 'node:test'
import assert from 'node:assert/strict'
import { createAssistantSpeech } from '../src/assistantSpeech.ts'

function fixture() {
  const spoken = [], states = [], errors = []
  const engine = { speak: item => spoken.push(item), cancel: () => {} }
  const player = createAssistantSpeech(engine, { onSpeaking: value => states.push(value), onError: () => errors.push(true) }, text => ({ text }))
  return { player, engine, spoken, states, errors, voice: { lang: 'zh-CN', voiceURI: 'local-test' } }
}

test('only one sentence is queued at once and all sentences finish', () => {
  const { player, spoken, states, voice } = fixture()
  player.play(['第一句。', '第二句。', '第三句。'], voice, .9)
  assert.equal(spoken.length, 1)
  spoken[0].onstart(); assert.equal(states.at(-1), true)
  spoken[0].onend(); assert.equal(spoken.length, 2)
  spoken[1].onend(); assert.equal(spoken.length, 3)
  spoken[2].onend(); assert.equal(states.at(-1), false)
  assert.equal(spoken[0].voice, voice)
  assert.equal(spoken[0].rate, .9)
})

test('stop and replay ignore stale end, start and error callbacks', () => {
  const { player, spoken, states, errors, voice } = fixture()
  player.play(['旧答复', '不能再播放'], voice, 1)
  const old = spoken[0]
  player.stop(); player.play(['新答复'], voice, .8)
  spoken[1].onstart()
  old.onend(); old.onerror({ error: 'network' }); old.onstart()
  assert.equal(spoken.length, 2)
  assert.equal(states.at(-1), true)
  assert.equal(errors.length, 0)
  player.stop(); spoken[1].onend(); spoken[1].onstart()
  assert.equal(states.at(-1), false)
})

test('duplicate completion never skips a sentence', () => {
  const { player, spoken, voice } = fixture()
  player.play(['一', '二', '三'], voice, 1)
  const first = spoken[0]
  first.onend(); first.onend()
  assert.equal(spoken.length, 2)
})

test('speaking motion follows pause/resume and ignores events after cancellation', () => {
  const { player, spoken, states, voice } = fixture()
  player.play(['讲解'], voice, .9)
  const current = spoken[0]
  current.onstart(); assert.equal(states.at(-1), true)
  current.onpause(); assert.equal(states.at(-1), false)
  current.onresume(); assert.equal(states.at(-1), true)
  player.stop(); current.onresume(); assert.equal(states.at(-1), false)
  player.play(['新讲解'], voice, .9)
  spoken[1].onstart(); current.onpause(); assert.equal(states.at(-1), true)
})

test('voice errors terminate the queue and allow a later retry', () => {
  const { player, spoken, states, errors, voice } = fixture()
  player.play(['一', '二'], voice, 5)
  assert.equal(spoken[0].rate, 1.1)
  spoken[0].onerror({ error: 'audio-busy' })
  spoken[0].onend()
  assert.equal(spoken.length, 1)
  assert.equal(states.at(-1), false)
  assert.equal(errors.length, 1)
  player.play(['重听'], voice, -1)
  assert.equal(spoken[1].rate, .75)
})

test('empty input and a synchronous engine failure cannot leave speaking stuck', () => {
  const { player, engine, spoken, states, errors, voice } = fixture()
  player.play(['', '  '], voice, 1)
  assert.equal(spoken.length, 0)
  engine.speak = () => { throw new Error('unavailable') }
  player.play(['测试'], voice, 1)
  assert.equal(errors.length, 1)
  assert.equal(states.at(-1), false)
})
