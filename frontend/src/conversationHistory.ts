export type ConversationMeta = {
  id: string;
  title: string;
  session?: string;
  agentId?: string;
  messageCount?: number;
  isGroup?: boolean;
  groupMemberCount?: number;
  isCanvas?: boolean;
  updatedAt?: number;
};

/** Rendering/reading a conversation must not erase its activity timestamp. */
export function mergeConversationMeta(
  previous: ConversationMeta | undefined,
  incoming: ConversationMeta,
  activityAt?: number,
): ConversationMeta {
  return {
    ...previous,
    ...incoming,
    updatedAt: activityAt === undefined
      ? incoming.updatedAt ?? previous?.updatedAt
      : Math.max(previous?.updatedAt || 0, activityAt),
  };
}
