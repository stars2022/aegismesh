import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationSync, legacyConversations } from '../src/conversationSync.ts'
import { mergeHistory, copyLegacyHistory } from '../src/historyDocument.ts'

function store(initial = {}) {
  const map = new Map(Object.entries(initial))
  return { getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key),
    get length() { return map.size }, key: index => [...map.keys()][index] }
}
const doc = (text, extra = {}) => ({ id: 'local', session: 'ses-local', title: '标题', messages: [{ role: 'user', text }], ...extra })

test('merge retains both concurrent branches and does not duplicate matched turns', () => {
  const remote = doc('common'); remote.messages.push({ role: 'assistant', text: 'cloud', result: { invocation_id: 'call' } })
  const local = doc('common'); local.messages.push({ role: 'assistant', text: 'partial', result: { invocation_id: 'call' }, streaming: true }, { role: 'user', text: 'local new' })
  const merged = mergeHistory(remote, local)
  assert.deepEqual(merged.messages.map(message => message.text), ['common', 'cloud', 'local new'])
  assert.equal(mergeHistory(remote, remote).messages.length, 2)
})

test('legacy discovery is explicit and never scans another account namespace', () => {
  const original = doc('legacy')
  const storage = store({ 'aegismesh-conv-local': JSON.stringify(original), 'aegismesh-conversations': JSON.stringify([original]),
    'aegismesh-owner:other:aegismesh-conv-secret': JSON.stringify(doc('secret', { id: 'other' })) })
  assert.deepEqual(legacyConversations(storage).map(item => item.id), ['local'])
  original.messages[0].result = { invocation_id: 'foreign' }; original.messages[0].taskId = 'foreign-task'
  original.groupConfig = { name: 'group', members: [], backendId: 'foreign-group' }; original.queue = [{ id: 'queued' }]
  const copied = copyLegacyHistory(original, 'fresh')
  assert.equal(copied.session, 'ses-fresh'); assert.equal(copied.messages[0].result, undefined)
  assert.equal(copied.messages[0].taskId, undefined); assert.equal(copied.groupConfig.backendId, undefined)
  assert.deepEqual(copied.queue, []); assert.ok(storage.getItem('aegismesh-conv-local'))
})

test('sidebar cloud recovery merges by session, retains local IDs and removes tombstones', async () => {
  const storage = store({ 'aegismesh-conversations-index': JSON.stringify([{ id: 'local', session: 'ses-a', title: 'local' }, { id: 'gone', session: 'ses-gone' }]) })
  globalThis.fetch = async (_path, init) => {
    assert.equal(init.headers['X-Conversation-Owner'], 'account-a')
    return Response.json({ items: [{ id: 'cloud-id', session: 'ses-a', title: 'cloud', revision: 1, updatedAt: 20 },
      { id: 'new', session: 'ses-new', title: 'restored', revision: 0, updatedAt: 10 }, { id: 'gone', session: 'ses-gone', deleted: true }], next_offset: null })
  }
  const sync = new ConversationSync('account-a', storage, mergeHistory)
  const list = await sync.refresh()
  assert.deepEqual(list.map(item => item.id), ['local', 'new'])
  assert.equal(list[0].title, 'cloud')
})

test('CAS conflict merges new cloud turns before retrying once', async () => {
  const storage = store(); const sync = new ConversationSync('account-a', storage, mergeHistory)
  let writes = 0
  const cloud = doc('cloud')
  globalThis.fetch = async (_path, init) => {
    if (init.method !== 'PUT') return Response.json({ revision: writes ? 2 : 1, conversation: cloud })
    writes++
    if (writes === 1) return Response.json({ detail: 'conflict' }, { status: 409 })
    const body = JSON.parse(init.body)
    assert.equal(body.revision, 2)
    assert.deepEqual(body.conversation.messages.map(item => item.text), ['cloud', 'local'])
    return Response.json({ revision: 3 })
  }
  sync.enqueue(doc('local')); await sync.flush('ses-local')
  assert.equal(writes, 2)
  assert.deepEqual(sync.cached('local').messages.map(item => item.text), ['cloud', 'local'])
})

test('network failures retain pending content and streaming deltas never write cloud', async () => {
  const sync = new ConversationSync('account-a', store(), mergeHistory)
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('offline') }
  let error = ''
  sync.subscribe(value => { error = value || '' })
  sync.enqueue(doc('partial', { messages: [{ role: 'assistant', text: 'partial', streaming: true }] })); await sync.flush('ses-local')
  assert.equal(calls, 0)
  sync.enqueue(doc('kept')); await sync.flush('ses-local')
  assert.equal(error, 'offline')
  globalThis.fetch = async (_path, init) => init.method === 'PUT' ? Response.json({ revision: 1 }) : Response.json({ detail: 'new' }, { status: 404 })
  await sync.flush('ses-local')
  assert.equal(sync.cached('local').messages[0].text, 'kept')
})
