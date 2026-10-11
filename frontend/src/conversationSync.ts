import type { Conversation } from './historyDocument'
import type { ConversationMeta } from './conversationHistory'

type Store = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void }
type CloudMeta = ConversationMeta & { revision: number; deleted: boolean }
type Change = (error?: string, indexChanged?: boolean) => void
const INDEX = 'aegismesh-conversations-index'
const DATA = 'aegismesh-conv-'
const ROOT = '/api/account/history'
function writeBody(revision: number | undefined, document: Conversation) {
  return JSON.stringify({ revision, conversation: { ...document, messages: document.messages.map(message => {
    const { result, streaming: _streaming, taskId: _taskId, ...saved } = message
    const ref = result?.invocation_id || message.recoveryInvocationId
    return { ...saved, ...(ref ? { result: { invocation_id: ref } } : {}) }
  }) } })
}

export class HistoryError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(ROOT + path, { credentials: 'same-origin', ...init,
    signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new HistoryError(typeof data.detail === 'string' ? data.detail : '历史同步失败', response.status)
  return data as T
}

export class ConversationSync {
  readonly owner: string
  private store: Store
  private merge: (remote: Conversation, local: Conversation) => Conversation
  private pending = new Map<string, Conversation>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private busy = new Map<string, Promise<void>>()
  private revisions = new Map<string, number>()
  private deleted = new Set<string>()
  private listeners = new Set<Change>()
  private listing?: Promise<ConversationMeta[]>
  constructor(owner: string, store: Store, merge: (remote: Conversation, local: Conversation) => Conversation) {
    this.owner = owner; this.store = store; this.merge = merge
  }
  private request<T>(path: string, init?: RequestInit): Promise<T> {
    return request(path, { ...init, headers: { ...init?.headers, 'X-Conversation-Owner': this.owner } })
  }
  subscribe(fn: Change) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private notify(error?: string, indexChanged = false) { for (const listener of this.listeners) listener(error, indexChanged) }
  index(): ConversationMeta[] {
    try { const data = JSON.parse(this.store.getItem(INDEX) || '[]'); return Array.isArray(data) ? data : [] } catch { return [] }
  }
  cached(id: string): Conversation | null {
    try { return JSON.parse(this.store.getItem(DATA + id) || 'null') } catch { return null }
  }
  private cache(document: Conversation) {
    try { this.store.setItem(DATA + document.id, JSON.stringify(document)) }
    catch { this.notify('浏览器缓存已满，正在尝试云端保存') }
  }
  enqueue(document: Conversation) {
    if (!document.session || this.deleted.has(document.session)) return
    this.pending.set(document.session, structuredClone(document))
    clearTimeout(this.timers.get(document.session))
    // Streaming deltas stay local. Final turns are saved in one debounced write.
    if (document.messages.some(message => message.streaming)) return
    this.timers.set(document.session, setTimeout(() => { void this.flush(document.session!) }, 1500))
  }
  private async write(session: string): Promise<void> {
    const local = this.pending.get(session)
    if (!local || this.deleted.has(session) || local.messages.some(message => message.streaming)) return
    let document = local
    try {
      if (!this.revisions.has(session)) {
        try {
          const cloud = await this.request<{ revision: number; conversation: Conversation }>('/' + encodeURIComponent(session))
          this.revisions.set(session, cloud.revision)
          document = this.merge(cloud.conversation, local)
        } catch (error) {
          if (!(error instanceof HistoryError) || error.status !== 404) throw error
          this.revisions.set(session, 0)
        }
      }
      let result: { revision: number }
      try {
        result = await this.request('/' + encodeURIComponent(session), { method: 'PUT', body: writeBody(this.revisions.get(session), document) })
      } catch (error) {
        if (!(error instanceof HistoryError) || error.status !== 409) throw error
        const cloud = await this.request<{ revision: number; conversation: Conversation }>('/' + encodeURIComponent(session))
        document = this.merge(cloud.conversation, document)
        result = await this.request('/' + encodeURIComponent(session), { method: 'PUT', body: writeBody(cloud.revision, document) })
      }
      this.revisions.set(session, result.revision)
      if (this.pending.get(session) === local) {
        this.pending.delete(session)
        this.cache(document)
      }
      this.notify()
    } catch (error) {
      if (error instanceof HistoryError && error.status === 410) {
        this.deleted.add(session); this.pending.delete(session); await this.refresh(); this.notify(undefined, true)
      } else this.notify(error instanceof Error ? error.message : '历史同步失败，本地记录已保留')
    }
  }
  async flush(session: string): Promise<void> {
    clearTimeout(this.timers.get(session)); this.timers.delete(session)
    const running = this.busy.get(session)
    if (running) { await running; if (this.pending.has(session)) return this.flush(session); return }
    const job = this.write(session)
    this.busy.set(session, job)
    try { await job } finally { this.busy.delete(session) }
  }
  async retry() {
    for (const session of this.pending.keys()) await this.flush(session)
    return this.refresh()
  }
  async cloudIndex(): Promise<CloudMeta[]> {
    const items: CloudMeta[] = []
    let offset: number | null = 0
    do {
      const page: { items: CloudMeta[]; next_offset: number | null } = await this.request(`?offset=${offset}`)
      items.push(...page.items); offset = page.next_offset
    } while (offset !== null)
    return items
  }
  async refresh(): Promise<ConversationMeta[]> {
    if (this.listing) return this.listing
    const job = (async () => {
      const cloud = await this.cloudIndex()
      const local = this.index()
      for (const item of cloud.filter(item => item.deleted)) {
        this.deleted.add(item.session!); this.pending.delete(item.session!)
      }
      const next = local.filter(item => !item.session || !this.deleted.has(item.session))
      for (const item of cloud.filter(item => !item.deleted)) {
        this.deleted.delete(item.session!)
        const match = next.findIndex(meta => meta.session === item.session)
        const old = next[match]
        const id = old?.id || (next.some(meta => meta.id === item.id) ? item.session! : item.id)
        const meta = { ...item, id, updatedAt: Math.max(item.updatedAt || 0, old?.updatedAt || 0) }
        if (match >= 0) next[match] = meta
        else next.push(meta)
      }
      next.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      try { this.store.setItem(INDEX, JSON.stringify(next)) } catch { this.notify('浏览器缓存已满，云端历史仍可读取') }
      return next
    })()
    this.listing = job
    try { return await job } finally { this.listing = undefined }
  }
  async load(meta: ConversationMeta): Promise<Conversation | null> {
    const local = this.cached(meta.id)
    if (!meta.session) return local
    try {
      const cloud = await this.request<{ revision: number; conversation: Conversation }>('/' + encodeURIComponent(meta.session))
      this.revisions.set(meta.session, cloud.revision)
      const document = local ? this.merge(cloud.conversation, local) : { ...cloud.conversation, queue: [] }
      document.id = meta.id
      this.cache(document)
      return document
    } catch (error) {
      if (error instanceof HistoryError && error.status === 404 && local) return local
      this.notify(error instanceof Error ? error.message : '历史加载失败')
      return local
    }
  }
  async remove(meta: ConversationMeta) {
    if (!meta.session) return
    // Stop queued saves first; wait for any already-started CAS before deleting.
    clearTimeout(this.timers.get(meta.session)); this.pending.delete(meta.session)
    await this.busy.get(meta.session)
    const cloud = await this.cloudIndex()
    const known = cloud.find(item => item.session === meta.session)
    if (known) await this.request('/' + encodeURIComponent(meta.session) + `?revision=${known.revision}`, { method: 'DELETE' })
    this.deleted.add(meta.session)
  }
  async restore(meta: CloudMeta) {
    await this.request('/' + encodeURIComponent(meta.session!) + `/restore?revision=${meta.revision}`, { method: 'POST' })
    this.deleted.delete(meta.session!); this.revisions.delete(meta.session!); await this.refresh(); this.notify(undefined, true)
  }
  async importLegacy(documents: Conversation[], copy: (source: Conversation, id: string) => Conversation) {
    const imports: Record<string, string> = JSON.parse(this.store.getItem('history-legacy-imports') || '{}')
    for (const source of documents) {
      if (imports[source.id]) continue
      const document = copy(source, crypto.randomUUID())
      this.cache(document)
      // Write the recovery index before the first network request; failed imports remain retryable.
      const metas = this.index()
      metas.unshift({ id: document.id, session: document.session, title: document.title, agentId: document.agentId,
        messageCount: document.messages.length, isCanvas: document.isCanvas, isGroup: document.isGroup, updatedAt: Date.now() })
      this.store.setItem(INDEX, JSON.stringify(metas))
      imports[source.id] = document.id
      this.store.setItem('history-legacy-imports', JSON.stringify(imports))
      this.enqueue(document); await this.flush(document.session!)
      if (this.pending.has(document.session!)) throw new Error('部分记录尚未保存到云端，原件已保留，请重试同步')
    }
    await this.refresh(); this.notify(undefined, true)
  }
}

export function legacyConversations(storage: Storage): Conversation[] {
  const found = new Map<string, Conversation>()
  const add = (value: string | null) => {
    try { const item = JSON.parse(value || 'null'); if (item?.id && Array.isArray(item.messages)) found.set(item.id, item) } catch { /* Retain malformed originals. */ }
  }
  try {
    const blob = JSON.parse(storage.getItem('aegismesh-conversations') || '[]')
    if (Array.isArray(blob)) for (const item of blob) add(JSON.stringify(item))
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key?.startsWith(DATA)) add(storage.getItem(key))
    }
  } catch { /* No legacy storage access; never fall back to another owner namespace. */ }
  return [...found.values()]
}
