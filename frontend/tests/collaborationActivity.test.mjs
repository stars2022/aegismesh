import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeTools, mergeCollaborations, mergeSessionResults } from '../src/collaborationActivity.ts'

test('tool IDs keep identical concurrent calls and handle reversed completion order', () => {
  const a = { id: 'a', name: 'web_search', arguments: { query: 'same' }, status: 'running' }
  const b = { ...a, id: 'b' }
  let tools = mergeTools([], [a, b])
  tools = mergeTools(tools, [{ ...b, status: 'completed', output_preview: 'second' }])
  tools = mergeTools(tools, [{ ...a, status: 'completed', output_preview: 'first' }])
  tools = mergeTools(tools, [{ ...a, output_preview: '' }])
  assert.equal(tools.length, 2)
  assert.deepEqual(tools.map(t => [t.status, t.output_preview]), [['completed', 'first'], ['completed', 'second']])
  assert.equal(mergeTools(tools, []).length, 2)
})

test('replayed running collab cannot erase completion or tool outputs', () => {
  const complete = { task_id: 'task', agent_id: 'worker', task: 'q', status: 'completed', result: 'answer',
    tools: [{ id: 'tool', name: 'search', status: 'completed', output_preview: 'evidence' }] }
  const stale = { ...complete, status: 'running', result: '', tools: [], current_tool: 'search' }
  const [merged] = mergeCollaborations([complete, stale])
  assert.equal(merged.status, 'completed')
  assert.equal(merged.current_tool, undefined)
  assert.equal(merged.result, 'answer')
  assert.equal(merged.tools[0].output_preview, 'evidence')
  assert.equal(mergeCollaborations([complete, { ...complete, task_id: 'retry' }]).length, 2)
})

test('session snapshots include prior turns but exclude other sessions', () => {
  const record = (id, session = 'mine') => ({ invocation_id: id, session_id: session, status: 'completed', answer: id,
    result_data: { collaborations: [{ agent_id: 'same', task: 'repeat', invocation_id: id, status: 'completed' }] } })
  const first = record('first')
  const second = record('second')
  const merged = mergeSessionResults('mine', [first, second], [record('private', 'other')],
    [{ ...first, status: 'working', answer: '', result_data: {} }])
  assert.equal(merged.length, 2)
  assert.equal(merged[0].status, 'completed')
  assert.equal(merged[0].answer, 'first')
  assert.equal(mergeCollaborations(merged.flatMap(r => r.result_data.collaborations)).length, 2)
})

test('missing tool IDs in old receipts retain repeated occurrences', () => {
  const tool = { name: 'search', arguments: { query: 'same' }, status: 'completed' }
  assert.equal(mergeTools([tool, tool], [tool, tool]).length, 2)
})
