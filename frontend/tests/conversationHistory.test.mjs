import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeConversationMeta } from '../src/conversationHistory.ts'

test('stream saves and render saves keep one stable activity group', () => {
  const now = Date.UTC(2026, 8, 30, 10)
  let meta = { id: 'running', title: '正在研究', updatedAt: now }
  for (let index = 0; index < 40; index++) {
    meta = mergeConversationMeta(meta, { id: meta.id, title: meta.title, messageCount: 2 }, now + index)
    meta = mergeConversationMeta(meta, { id: meta.id, title: meta.title, messageCount: 2 })
    assert.equal(meta.updatedAt, now + index)
  }
})

test('opening or changing settings in an old conversation does not make it recent', () => {
  const previous = { id: 'old', title: '旧记录', updatedAt: 1234, isCanvas: true }
  assert.equal(mergeConversationMeta(previous, { id: 'old', title: '旧记录', agentId: 'new' }).updatedAt, 1234)
  assert.equal(previous.updatedAt, 1234)
  assert.equal(mergeConversationMeta(undefined, { id: 'legacy', title: '旧版无日期' }).updatedAt, undefined)
})

test('new messages advance activity without late updates moving it backwards', () => {
  const previous = { id: 'task', title: '任务', updatedAt: 2000 }
  assert.equal(mergeConversationMeta(previous, { id: 'task', title: '任务' }, 3000).updatedAt, 3000)
  assert.equal(mergeConversationMeta(previous, { id: 'task', title: '任务' }, 1000).updatedAt, 2000)
})
