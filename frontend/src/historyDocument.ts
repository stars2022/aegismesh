import type { Attachment, ChatResult, StructuredTaskOptions } from './types'
import { createId } from './randomId.mjs'

export type GroupConfig = {
  name: string; members: string[]; hostAgentId?: string | null;
  backendId?: string; transport?: 'local' | 'aip-mq';
}
export type ChatMessage = {
  role: 'user' | 'assistant'; text: string; result?: ChatResult; streaming?: boolean;
  historyId?: string; attachments?: Attachment[]; feedback?: 'positive' | 'negative';
  senderAgentId?: string; senderName?: string; isHost?: boolean; createdAt?: number;
  taskId?: string; recoveryInvocationId?: string;
}
export type QueuedTask = {
  id: string; text: string; agentId: string; attachments?: Attachment[];
  mode?: 'route' | 'bounty'; structuredOptions?: StructuredTaskOptions;
}
export type Conversation = {
  id: string; title: string; session?: string; agentId?: string; messages: ChatMessage[];
  queue?: QueuedTask[]; isGroup?: boolean; groupConfig?: GroupConfig; isCanvas?: boolean;
}

/** Union concurrent branches without silently discarding either browser's turns. */
export function mergeHistory(remote: Conversation, local: Conversation): Conversation {
  const remaining = [...local.messages]
  const messages = remote.messages.map(message => {
    const ref = message.result?.invocation_id || message.recoveryInvocationId
    let index = remaining.findIndex(item => (ref && ref === (item.result?.invocation_id || item.recoveryInvocationId)) ||
      (message.historyId && message.historyId === item.historyId))
    if (index < 0) index = remaining.findIndex(item => item.role === message.role && item.text === message.text)
    if (index < 0) return message
    const [item] = remaining.splice(index, 1)
    // An authoritative completed response wins over an interrupted local stream.
    return message.result ? { ...item, ...message, streaming: false, taskId: undefined,
      historyId: item.historyId || message.historyId } : { ...message, ...item }
  })
  messages.push(...remaining)
  return { ...remote, ...local, session: remote.session, messages, queue: local.queue || [] }
}

/** Explicit import copies a transcript, not another principal's resource handles. */
export function copyLegacyHistory(source: Conversation, id: string): Conversation {
  return {
    id, session: `ses-${id}`, title: source.title || '导入的会话', agentId: source.agentId,
    isCanvas: source.isCanvas, isGroup: source.isGroup,
    groupConfig: source.groupConfig ? {
      name: source.groupConfig.name, members: source.groupConfig.members,
      hostAgentId: source.groupConfig.hostAgentId,
    } : undefined,
    messages: (source.messages || []).map(message => ({
      role: message.role, text: message.text, createdAt: message.createdAt,
      senderAgentId: message.senderAgentId, senderName: message.senderName, isHost: message.isHost,
      historyId: createId(),
    })), queue: [],
  }
}
