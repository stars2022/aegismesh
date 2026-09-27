import assert from 'node:assert/strict'
import test from 'node:test'
import { api } from '../src/api.ts'

test('a successful HTTP response with invalid JSON shows a useful service error', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response('<!doctype html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  })

  await assert.rejects(api.demoSession(), /服务响应格式不正确，请稍后重试/)
})
