import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createId } from '../src/randomId.mjs'
import { newAssistantSession } from '../src/assistantConversation.ts'
import { copyLegacyHistory } from '../src/historyDocument.ts'

function withCrypto(source, action) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: source })
  try { return action() } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original)
    else delete globalThis.crypto
  }
}

test('native UUID remains preferred, with the correct receiver', () => {
  const native = { randomUUID() { assert.equal(this, native); return 'native-uuid' } }
  withCrypto(native, () => assert.equal(createId(), 'native-uuid'))
})

test('HTTP origin without randomUUID uses secure random bytes and UUID v4 bits', () => {
  const http = { getRandomValues(bytes) { assert.equal(this, http); bytes.fill(255); return bytes } }
  withCrypto(http, () => assert.equal(createId(), 'ffffffff-ffff-4fff-bfff-ffffffffffff'))
})

test('HTTP fallback produces distinct UUID-shaped identifiers', () => {
  withCrypto({ getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }, () => {
    const ids = Array.from({ length: 10000 }, () => createId())
    assert.equal(new Set(ids).size, ids.length)
    assert.ok(ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)))
  })
})

test('consultation initialization and history import also work on HTTP origins', () => {
  withCrypto({ getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }, () => {
    const first = newAssistantSession(), second = newAssistantSession()
    assert.notEqual(first.id, second.id)
    assert.match(first.id, /^human-[0-9a-f-]{36}$/)
    const copy = copyLegacyHistory({ id: 'old', title: '旧会话', messages: [{ role: 'user', text: 'test' }] }, createId())
    assert.match(copy.messages[0].historyId, /^[0-9a-f-]{36}$/)
  })
})

test('missing secure RNG fails explicitly rather than using a weak substitute', () => {
  for (const source of [undefined, {}]) {
    withCrypto(source, () => assert.throws(() => createId(), /安全随机数/))
  }
})
