import test from 'node:test'
import assert from 'node:assert/strict'
import { readDigitalHumanPreferences, isNearConversationEnd } from '../src/digitalHumanPreferences.ts'

test('saved reading preferences are validated and never turn audio on automatically', () => {
  assert.deepEqual(readDigitalHumanPreferences('{"largeText":true,"voiceId":"zh-local","voiceRate":0.8,"voiceOn":true}'),
    {largeText:true,voiceId:'zh-local',voiceRate:.8})
  for (const raw of [null, '', 'invalid', 'null', '[]', '5', '{"largeText":"true","voiceRate":20,"voiceId":4}']) {
    assert.deepEqual(readDigitalHumanPreferences(raw), {largeText:false,voiceId:'',voiceRate:.9})
  }
})

test('new answers follow a reader at the bottom without hijacking older messages', () => {
  assert.equal(isNearConversationEnd({scrollHeight:1000,scrollTop:600,clientHeight:400}), true)
  assert.equal(isNearConversationEnd({scrollHeight:1000,scrollTop:540,clientHeight:400}), true)
  assert.equal(isNearConversationEnd({scrollHeight:1000,scrollTop:200,clientHeight:400}), false)
  assert.equal(isNearConversationEnd({scrollHeight:200,scrollTop:-25,clientHeight:400}), true)
})
