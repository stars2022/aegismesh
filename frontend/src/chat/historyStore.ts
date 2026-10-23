import { conversationStorage, conversationStorageForOwner, getConversationOwner } from "../conversationStorage";
import type { ConversationMeta } from "../conversationHistory";
import { ConversationSync } from "../conversationSync";
import { mergeHistory, type Conversation } from "../historyDocument";
import { createId } from "../randomId.mjs";

export let historySync: ConversationSync | undefined;
export function currentHistorySync() {
  const owner = getConversationOwner();
  if (!owner.startsWith('account_')) return undefined;
  if (historySync?.owner !== owner) historySync = new ConversationSync(owner, conversationStorageForOwner(owner), mergeHistory);
  return historySync;
}

export function loadConversationIndex(): ConversationMeta[] {
  try {
    const raw = conversationStorage.getItem("aegismesh-conversations-index");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
    // Migration from old monolithic localStorage blob
    const oldBlob = conversationStorage.getItem("aegismesh-conversations");
    if (oldBlob) {
      const oldList = JSON.parse(oldBlob);
      if (Array.isArray(oldList)) {
        const index: ConversationMeta[] = [];
        for (const item of oldList) {
          if (item && item.id) {
            try {
              conversationStorage.setItem(`aegismesh-conv-${item.id}`, JSON.stringify(item));
            } catch {}
            index.push({
              id: item.id,
              title: item.title || "会话",
              session: item.session,
              agentId: item.agentId,
              messageCount: Array.isArray(item.messages) ? item.messages.length : 0,
              isGroup: item.isGroup,
              groupMemberCount: item.groupConfig?.members?.length,
              isCanvas: item.isCanvas,
            });
          }
        }
        try {
          conversationStorage.setItem("aegismesh-conversations-index", JSON.stringify(index));
        } catch {}
        return index;
      }
    }
  } catch {}
  return [];
}

export function saveConversationIndex(metas: ConversationMeta[]): void {
  try {
    conversationStorage.setItem("aegismesh-conversations-index", JSON.stringify(metas));
  } catch {}
}

export function loadConversationData(id: string): Conversation | null {
  const memory = historySync?.owner === getConversationOwner() ? historySync.cached(id) : null;
  if (memory) return memory;
  try {
    const raw = conversationStorage.getItem(`aegismesh-conv-${id}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
    const oldBlob = conversationStorage.getItem("aegismesh-conversations");
    if (oldBlob) {
      const oldList = JSON.parse(oldBlob);
      if (Array.isArray(oldList)) {
        const found = oldList.find((c: any) => c && c.id === id);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

export function saveConversationData(conv: Conversation): void {
  conv.session ||= `ses-${conv.id}`;
  const previous = loadConversationData(conv.id)?.messages || [];
  conv.messages = conv.messages.map((message, index) => message.historyId ? message : {
    ...message, historyId: previous[index]?.role === message.role && previous[index]?.createdAt === message.createdAt
      ? previous[index].historyId || createId() : createId(),
  });
  const sync = currentHistorySync();
  sync?.remember(conv);
  const value = JSON.stringify(conv);
  // 账号会话写不下时淘汰最旧的已同步缓存；访客会话只存在本地，不做淘汰。
  if (sync) sync.storeLocal(`aegismesh-conv-${conv.id}`, value, conv.id);
  else {
    try { conversationStorage.setItem(`aegismesh-conv-${conv.id}`, value); } catch { /* 访客本地容量已满 */ }
  }
  sync?.enqueue(conv);
}
