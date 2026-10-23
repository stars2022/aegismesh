export type AssistantMessage = { id: string; role: 'user' | 'assistant'; text: string; state?: 'pending' | 'failed' | 'stopped' }
export type AssistantSession = { id: string; title: string; messages: AssistantMessage[]; taskId?: string; pendingId?: string }
import { createId } from './randomId.mjs'

export function newAssistantSession(): AssistantSession {
  return { id: `human-${createId()}`, title: '新的咨询', messages: [] }
}
export function readAssistantSession(raw: string | null): AssistantSession | null {
  try {
    const value = JSON.parse(raw || '')
    if (!value || typeof value.id !== 'string' || !/^human-[a-zA-Z0-9-]{1,100}$/.test(value.id) || !Array.isArray(value.messages)) return null
    const messages: AssistantMessage[] = value.messages.filter((m: AssistantMessage) => m && ['user','assistant'].includes(m.role) && typeof m.id === 'string' && typeof m.text === 'string').map((m: AssistantMessage) => ({ id: m.id.slice(0, 128), role: m.role, text: m.text.slice(0, 100000), state: ['pending','failed','stopped'].includes(m.state || '') ? m.state : undefined }))
    const pendingId = messages.some(m => m.id === value.pendingId && m.role === 'assistant' && m.state === 'pending') && messages.some(m => m.role === 'user') ? value.pendingId : undefined
    return { id: value.id, title: String(value.title || '新的咨询').slice(0, 80),
      taskId: pendingId && typeof value.taskId === 'string' ? value.taskId.slice(0, 128) : undefined,
      pendingId,
      messages: messages.map(m => m.state === 'pending' && m.id !== pendingId ? { ...m, state: 'failed', text: '这条答复未能恢复，请重新提问。' } : m) }
  } catch { return null }
}
export function finishAssistantReply(session: AssistantSession, replyId: string, text: string, state?: 'failed' | 'stopped'): AssistantSession {
  if (session.pendingId !== replyId) return session
  return { ...session, pendingId: undefined, taskId: undefined, messages: session.messages.map(m => m.id === replyId ? { ...m, text, state } : m) }
}
export function assistantFailure(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/配额|额度|429|并发.*上限/.test(message)) return '当前可用额度或同时处理数量已达上限，请稍后再试。'
  if (/401|403|登录|身份|无权|404|会话不存在|会话状态/.test(message)) return '会话状态已变化，请刷新页面，或新建咨询后重试。'
  return '这次没能完成答复，请稍后重试。已收到的内容不会被当作完成结果。'
}
export function assistantWasCancelled(reason: unknown): boolean {
  return (reason instanceof Error ? reason.message : String(reason)) === '任务已被用户取消'
}
export function speechText(markdown: string): string[] {
  const text = markdown.replace(/```[\s\S]*?```/g, '（代码内容请查看文字答复）').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/[#*_>`~|]/g, '').trim().slice(0, 12000)
  return text.match(/[^。！？.!?\n]{1,180}[。！？.!?\n]?/g)?.map(s => s.trim()).filter(Boolean) || []
}
