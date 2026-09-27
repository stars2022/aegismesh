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
