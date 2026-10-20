import test from 'node:test'
import assert from 'node:assert/strict'
import { api } from '../src/api.ts'

test('designer uses the dedicated admin endpoint and never saves or starts a chat', async () => {
  const original = globalThis.fetch
  const sent = []
  const controller = new AbortController()
  try {
    globalThis.fetch = async (url, init) => {
      sent.push({ url, init })
      return new Response(JSON.stringify({ draft: { id: 'sample', aic: '', name: '样例' } }), { status: 200 })
    }
    const response = await api.generateAgentDraft({ provider_id: 'chosen', requirements: '生成配置' }, controller.signal)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].url, '/api/admin/agent-designer/generate')
    assert.equal(sent[0].init.credentials, 'same-origin')
    assert.equal(sent[0].init.signal, controller.signal)
    assert.deepEqual(JSON.parse(sent[0].init.body), { provider_id: 'chosen', requirements: '生成配置' })
    assert.equal(response.draft.id, 'sample')
  } finally { globalThis.fetch = original }
})

test('a failed privileged generation is displayed once and never retried automatically', async () => {
  const original = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ detail: '请登录管理后台' }), { status: 401 }) }
    await assert.rejects(api.generateAgentDraft({ provider_id: 'chosen', requirements: '生成配置' }), /请登录管理后台/)
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})

test('designer cancellation does not silently open another request', async () => {
  const original = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = async () => { calls++; throw new DOMException('已取消', 'AbortError') }
    await assert.rejects(api.generateAgentDraft({ provider_id: 'chosen', requirements: '生成配置' }), { name: 'AbortError' })
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})
