import test from 'node:test'
import assert from 'node:assert/strict'
import { assistantFailure, assistantWasCancelled, finishAssistantReply, newAssistantSession, readAssistantSession, speechText } from '../src/assistantConversation.ts'
import { quotaPercent, quotaSize } from '../src/accountPresentation.ts'

test('assistant consultations have independent opaque sessions', () => {
  const one = newAssistantSession(), two = newAssistantSession()
  assert.notEqual(one.id, two.id)
  assert.match(one.id, /^human-/)
  assert.deepEqual(one.messages, [])
})

test('restoring a consultation only retains user-facing fields', () => {
  const restored = readAssistantSession(JSON.stringify({ id: 'human-one', title: '旅行', events: ['secret-debug'], taskId: 'task-one', pendingId: 'reply', messages: [
    { id: 'user', role: 'user', text: '去哪里玩' },
    { id: 'reply', role: 'assistant', text: '', state: 'pending', raw: 'dispatch_task internals' },
    { id: 'tool', role: 'tool', text: 'internal parameters' },
  ] }))
  assert.equal(restored.pendingId, 'reply')
  assert.equal(restored.taskId, 'task-one')
  assert.equal(restored.messages.length, 2)
  assert.ok(!JSON.stringify(restored).includes('internals'))
  assert.ok(!JSON.stringify(restored).includes('secret-debug'))
  assert.equal(readAssistantSession('{broken'), null)
  assert.equal(readAssistantSession('{"id":"../other","messages":[]}'), null)
})

test('corrupt pending references never dispatch an invisible recovery', () => {
  const restored = readAssistantSession(JSON.stringify({ id: 'human-one', pendingId: 'lost', taskId: 'task-one', messages: [{ id: 'reply', role: 'assistant', text: '', state: 'pending' }] }))
  assert.equal(restored.pendingId, undefined)
  assert.equal(restored.taskId, undefined)
  assert.equal(restored.messages[0].state, 'failed')
})

test('completion targets its pending reply, never a newer consultation', () => {
  const current = { id: 'human-one', title: '旅行', pendingId: 'reply', taskId: 'task-one', messages: [{ id: 'reply', role: 'assistant', text: '', state: 'pending' }] }
  assert.equal(finishAssistantReply(current, 'stale', '旧结果'), current)
  const completed = finishAssistantReply(current, 'reply', '最终答复')
  assert.equal(completed.messages[0].text, '最终答复')
  assert.equal(completed.messages[0].state, undefined)
  assert.equal(completed.taskId, undefined)
  assert.equal(completed.pendingId, undefined)
  const stopped = finishAssistantReply(current, 'reply', '已停止', 'stopped')
  assert.equal(stopped.messages[0].state, 'stopped')
})

test('friendly failures do not hide failure or print internal tool errors', () => {
  assert.match(assistantFailure(new Error('429 quota limit')), /额度/)
  assert.match(assistantFailure('403'), /会话状态/)
  assert.match(assistantFailure('mTLS dispatch_task secret endpoint'), /没能完成/)
  assert.doesNotMatch(assistantFailure('mTLS dispatch_task secret endpoint'), /mTLS|dispatch_task|secret/)
})

test('server cancellation is distinct from generic failures and connection loss', () => {
  assert.equal(assistantWasCancelled(new Error('任务已被用户取消')), true)
  assert.equal(assistantWasCancelled('网络中断'), false)
  assert.equal(assistantWasCancelled('任务已被取消或中断'), false)
})

test('speech strips markup, links and code and uses bounded chunks', () => {
  const text = speechText('# 建议\n查看[来源](https://example.org)！\n```js\nalert(1)\n```\n' + '甲'.repeat(500)).join('')
  assert.ok(text.includes('来源'))
  assert.ok(!text.includes('https://') && !text.includes('alert(1)'))
  assert.ok(speechText('甲'.repeat(20000)).every(s => s.length <= 181))
  assert.ok(speechText('甲'.repeat(20000)).join('').length <= 12000)
})

test('quota off/observe never imply a cap, enforcement meters stay bounded', () => {
  const metric = { used: 50, reserved: 10, limit: 100, remaining: 40 }
  assert.equal(quotaPercent(metric, 'off'), 0)
  assert.equal(quotaPercent(metric, 'observe'), 0)
  assert.equal(quotaPercent(metric, 'enforce'), 60)
  assert.equal(quotaPercent({ ...metric, used: 150 }, 'enforce'), 100)
  assert.equal(quotaPercent({ ...metric, limit: 0 }, 'enforce'), 0)
  assert.equal(quotaSize(1048576), '1 MB')
})
