import assert from 'node:assert/strict'
import test from 'node:test'
import { api } from '../src/api.ts'

function sseResponse(wire, taskId = 'task-1') {
  return new Response(wire, {
    status: 200,
    headers: { 'X-Task-Id': taskId },
  })
}

test('chat stream accepts split UTF-8, CRLF frames and a final frame without a blank line', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const wire = [
    'event: delta\r\ndata: {"type":"delta","text":"你好"}\r\n\r\n',
    'event: result\r\ndata: {"type":"result",\r\ndata: "data":{"answer":"你好","session_id":"s1"}}',
  ].join('')
  const bytes = new TextEncoder().encode(wire)
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  })
  globalThis.fetch = async () => new Response(stream, {
    status: 200,
    headers: { 'X-Task-Id': 'task-1' },
  })

  const deltas = []
  const events = []
  const taskIds = []
  const result = await api.chatStream(
    '测试', 's1', 'leader', (text) => deltas.push(text),
    (event) => events.push(event.type), undefined,
    (taskId) => taskIds.push(taskId),
  )

  assert.deepEqual(deltas, ['你好'])
  assert.deepEqual(events, ['delta', 'result'])
  assert.deepEqual(taskIds, ['task-1'])
  assert.equal(result.answer, '你好')
})

test('idle SSE keep-alive comments do not appear as chat events or text', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => sseResponse(
    ': keep-alive\n\n' +
    'id: 0\nevent: delta\ndata: {"type":"delta","text":"你好"}\n\n' +
    ': keep-alive\n\n' +
    'id: 1\nevent: result\ndata: {"type":"result","data":{"answer":"你好"}}\n\n',
  )

  const deltas = []
  const events = []
  const result = await api.chatStream('测试', 's1', 'leader',
    (text) => deltas.push(text), (event) => events.push(event.type))

  assert.deepEqual(deltas, ['你好'])
  assert.deepEqual(events, ['delta', 'result'])
  assert.equal(result.answer, '你好')
})

test('self-claim mode is explicit and stays bound to its captured session and agent', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const requests = []
  globalThis.fetch = async (path, init) => {
    requests.push({ path, body: JSON.parse(init.body), credentials: init.credentials })
    return sseResponse('event: result\ndata: {"type":"result","data":{"answer":"结果"}}\n\n')
  }
  await api.chatStream('默认任务', 'ordinary-session', 'ordinary-leader', () => {})
  await api.chatStream('自主认领', 'private-session', 'private-leader', () => {}, undefined,
    undefined, undefined, [], false, 'bounty')
  assert.equal(requests[0].body.mode, 'route')
  assert.equal(requests[1].body.mode, 'bounty')
  assert.equal(requests[1].body.session_id, 'private-session')
  assert.equal(requests[1].body.agent_id, 'private-leader')
  assert.equal(requests[1].body.owner_id, undefined)
  assert.equal(requests[1].credentials, 'same-origin')
})

test('interrupted chat stream resumes after the last event without repeating text', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const requests = []
  const responses = [
    sseResponse('id: 0\nevent: delta\ndata: {"type":"delta","text":"前"}\n\n'),
    sseResponse(
      'id: 1\nevent: delta\ndata: {"type":"delta","text":"后"}\n\n' +
      'id: 2\nevent: result\ndata: {"type":"result","data":{"answer":"前后"}}\n\n',
    ),
  ]
  globalThis.fetch = async (path, init) => {
    requests.push([path, init.method])
    return responses.shift()
  }

  const deltas = []
  const result = await api.chatStream('测试', 's1', 'leader', (text) => deltas.push(text))

  assert.deepEqual(deltas, ['前', '后'])
  assert.equal(result.answer, '前后')
  assert.deepEqual(requests, [
    ['/api/demo/chat/stream', 'POST'],
    ['/api/demo/tasks/task-1/stream?from_index=1', 'GET'],
  ])
})

test('explicit task error does not trigger a reconnect', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return sseResponse('id: 0\nevent: error\ndata: {"type":"error","message":"权限拒绝"}\n\n')
  }

  await assert.rejects(api.chatStream('测试', 's1', 'leader', () => {}), /权限拒绝/)
  assert.equal(fetchCalls, 1)
})

test('user abort prevents reconnect after a partial reply', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return sseResponse('id: 0\nevent: delta\ndata: {"type":"delta","text":"前"}\n\n')
  }
  const controller = new AbortController()

  await assert.rejects(
    api.chatStream('测试', 's1', 'leader', () => controller.abort(), undefined, controller.signal),
    (error) => error.name === 'AbortError',
  )
  assert.equal(fetchCalls, 1)
})

test('digital-human requests preserve the normal task pipeline and return only the terminal answer', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let sent
  globalThis.fetch = async (path, init) => {
    sent = { path, body: JSON.parse(init.body), credentials: init.credentials }
    return sseResponse([
      { type: 'status', data: { task_id: 'task-human' } },
      { type: 'event', data: { event_type: 'DISPATCH_STARTED', detail: { agent: 'hidden agent' } } },
      { type: 'delta', text: '调用工具的过程，不应成为气泡' },
      { type: 'result', data: { session_id: 'human-one', status: 'completed', answer: '您的行程建议。' } },
    ].map((frame, i) => `id: ${i}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), 'task-human')
  }
  const ids = []
  const result = await api.assistantChatStream('请规划旅行', 'human-one', new AbortController().signal, id => ids.push(id))
  assert.equal(sent.path, '/api/demo/chat/stream')
  assert.equal(sent.credentials, 'same-origin')
  assert.equal(sent.body.presentation, 'assistant')
  assert.equal(sent.body.interface, 'harness')
  assert.equal(sent.body.mode, 'collaborate')
  assert.equal(sent.body.session_id, 'human-one')
  assert.equal(sent.body.agent_id, undefined)
  assert.equal(result.answer, '您的行程建议。')
  assert.ok(ids.every(id => id === 'task-human'))
})
