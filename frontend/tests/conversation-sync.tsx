import { createRoot } from 'react-dom/client'
import { ChatDemo } from '../src/chat/ChatDemo'
import { api } from '../src/api'
import { conversationStorage, setConversationOwner } from '../src/conversationStorage'
import { applyTheme, DEFAULT_SETTINGS } from '../src/settings'
import type { Agent } from '../src/types'
import '../src/styles.css'

if (location.hostname !== '127.0.0.1' || location.port !== '5197') throw new Error('Use isolated port 5197')
const owner = 'account_history-sync-fixture'
setConversationOwner(owner)
applyTheme({ ...DEFAULT_SETTINGS, theme: new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light' })
conversationStorage.removeItem('aegismesh-conversations-index')
const agents = [{ id: 'research_leader', name: '科研智能体协作工作台', role: 'leader', active: true,
  usage_mode: 'internal', health: 'online', skills: [], tools: [] }] as unknown as Agent[]
const documents = new Map([['ses-cloud', { revision: 1, deleted: false, conversation: { id: 'cloud-only', session: 'ses-cloud',
  title: '从云端恢复的科研会话', agentId: agents[0].id,
  messages: [{ role: 'user', text: '云端历史是否恢复？', historyId: 'user' }, { role: 'assistant', text: '已恢复完整消息，不需要重新调用模型。', historyId: 'assistant' }] } }]])
window.fetch = async (input, init) => {
  const path = String(input)
  if (path === '/api/account/config') return Response.json({ enabled: true, quota_mode: 'enforce', providers: [] })
  if (path === '/api/account/me') return Response.json({ owner_id: owner, account: { id: 'fixture', display_name: 'stars', email: 'owner@example.test', role: 'owner' }, identities: [], quota: { mode: 'enforce', exempt: true } })
  if (!path.startsWith('/api/account/history')) throw new Error('Live APIs are blocked: ' + path)
  if (path.startsWith('/api/account/history?')) return Response.json({ items: [...documents.values()].map(item => ({ ...item.conversation,
    messageCount: item.conversation.messages.length, updatedAt: Date.now(), revision: item.revision, deleted: item.deleted })), next_offset: null })
  const item = documents.get(decodeURIComponent(path.split('/')[4].split('?')[0]))
  if (!item) return Response.json({ detail: '不存在' }, { status: 404 })
  if (init?.method === 'DELETE') { item.deleted = true; item.revision++; return Response.json({ deleted: true }) }
  if (path.includes('/restore?')) { item.deleted = false; item.revision++; return Response.json({ revision: item.revision }) }
  if (init?.method === 'PUT') { item.revision++; return Response.json({ revision: item.revision }) }
  return Response.json({ revision: item.revision, conversation: item.conversation })
}
api.agents = async () => agents
api.chatConfig = async () => ({ interop_compatibility: false, default_coordinator_id: agents[0].id })
api.getActiveTask = async () => ({ active: false })
api.sessionActivity = async session => ({ session_id: session, items: [], next_before: null })
createRoot(document.getElementById('root')!).render(<ChatDemo onComplete={async () => {}} />)
