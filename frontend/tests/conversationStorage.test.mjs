import test from 'node:test'
import assert from 'node:assert/strict'
import { setConversationOwner, conversationStorage, conversationStorageKey, conversationStorageForOwner } from '../src/conversationStorage.ts'

test('browser cache follows stable owner, never another account or legacy data', () => {
  const entries = new Map([['aegismesh-conversations-index', 'legacy']])
  globalThis.localStorage = { getItem: k => entries.get(k) ?? null, setItem: (k, v) => entries.set(k, v), removeItem: k => entries.delete(k) }
  setConversationOwner('guest_a')
  assert.equal(conversationStorage.getItem('aegismesh-conversations-index'), null)
  conversationStorage.setItem('aegismesh-conversations-index', 'guest data')
  setConversationOwner('account_b')
  assert.equal(conversationStorage.getItem('aegismesh-conversations-index'), null)
  conversationStorage.setItem('aegismesh-conversations-index', 'account data')
  setConversationOwner('guest_a')
  assert.equal(conversationStorage.getItem('aegismesh-conversations-index'), 'guest data')
  conversationStorage.removeItem('aegismesh-conversations-index')
  assert.equal(entries.get('aegismesh-conversations-index'), 'legacy')
  assert.throws(() => setConversationOwner('../other'))
  assert.ok(conversationStorageKey('aegismesh-conv-1').includes('guest_a'))
})

test('a pending assistant operation retains its captured owner namespace', () => {
  const entries = new Map()
  globalThis.localStorage = { getItem: k => entries.get(k) ?? null, setItem: (k, v) => entries.set(k, v) }
  const first = conversationStorageForOwner('guest_first')
  setConversationOwner('account_second')
  first.setItem('human-active', 'human-first')
  assert.equal(first.getItem('human-active'), 'human-first')
  assert.equal(conversationStorage.getItem('human-active'), null)
  assert.equal(conversationStorageForOwner('account_second').getItem('human-active'), null)
  assert.throws(() => conversationStorageForOwner(''))
})

test('clearing assistant history cannot remove another account or legacy data', () => {
  const entries = new Map([['human-index', 'legacy']])
  globalThis.localStorage = { getItem: k => entries.get(k) ?? null, setItem: (k, v) => entries.set(k, v), removeItem: k => entries.delete(k) }
  const first = conversationStorageForOwner('guest_first'), second = conversationStorageForOwner('account_second')
  first.setItem('human-index', 'first'); second.setItem('human-index', 'second')
  first.removeItem('human-index')
  assert.equal(first.getItem('human-index'), null)
  assert.equal(second.getItem('human-index'), 'second')
  assert.equal(entries.get('human-index'), 'legacy')
})
