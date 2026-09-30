import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { selectAvatarMotion, avatarMotionLoops, avatarClips, avatarPlaybackFailure } from '../src/avatarMotion.ts'

const state = { greeting: false, speaking: false, busy: false, visible: true, reducedMotion: false, saveData: false }
const clips = { idle: '/idle.mp4', greet: '/greet.mp4', explain: '/explain.mp4', applaud: '/applaud.mp4' }

test('motion follows the actual greeting and local speech state', () => {
  assert.equal(selectAvatarMotion(state, clips), 'idle')
  assert.equal(selectAvatarMotion({ ...state, greeting: true }, clips), 'greet')
  assert.equal(selectAvatarMotion({ ...state, greeting: true, speaking: true }, clips), 'explain')
  assert.equal(selectAvatarMotion({ ...state, greeting: true, busy: true }, clips), 'idle')
})

test('hidden, reduced-motion and data-saving states never load a video', () => {
  for (const disabled of [{ visible: false }, { reducedMotion: true }, { saveData: true }, { paused: true }]) {
    assert.equal(selectAvatarMotion({ ...state, speaking: true, ...disabled }, clips), null)
  }
})

test('missing and failed media fall back without blocking the assistant', () => {
  assert.equal(selectAvatarMotion(state, {}), null)
  assert.equal(selectAvatarMotion({ ...state, speaking: true }, clips, new Set(['explain'])), 'idle')
  assert.equal(selectAvatarMotion({ ...state, speaking: true }, clips, new Set(['explain', 'idle'])), null)
})

test('applause is never an automatic success response; greeting does not loop', () => {
  assert.equal(selectAvatarMotion(state, { applaud: '/applaud.mp4' }), null)
  assert.equal(avatarMotionLoops('greet'), false)
  assert.equal(avatarMotionLoops('applaud'), false)
  assert.equal(avatarMotionLoops('idle'), true)
  assert.equal(avatarMotionLoops('explain'), true)
})

test('production clips exist locally and stay within the per-clip download budget', () => {
  for (const src of Object.values(avatarClips)) {
    assert.match(src, /^\/media\/digital-human-[a-z-]+\.mp4$/)
    const file = new URL(`../public${src}`, import.meta.url)
    assert.ok(statSync(file).size < 1_000_000, `${src} should be under 1 MB`)
    assert.equal(readFileSync(file).subarray(4, 8).toString(), 'ftyp')
  }
  assert.ok(statSync(new URL('../public/media/digital-human-matte-poster.jpg', import.meta.url)).size < 150_000)
})

test('autoplay restrictions and interrupted transitions do not blacklist healthy media', () => {
  assert.equal(avatarPlaybackFailure({name:'NotAllowedError'}), 'blocked')
  assert.equal(avatarPlaybackFailure({name:'AbortError'}), 'interrupted')
  assert.equal(avatarPlaybackFailure({name:'NotSupportedError'}), 'unavailable')
  assert.equal(avatarPlaybackFailure(null), 'unavailable')
  const avatar = readFileSync(new URL('../src/DigitalHumanAvatar.tsx', import.meta.url), 'utf8')
  assert.match(avatar, /controls=\{false\}/)
  assert.doesNotMatch(avatar, /<button|播放动作|暂停动作/)
})
