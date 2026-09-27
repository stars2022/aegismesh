export type RecoverableAssistantMessage = {
  role: string;
  streaming?: boolean;
  taskId?: string;
  recoveryInvocationId?: string;
  result?: { invocation_id: string };
  createdAt?: number;
};

export function hasCompletedTaskMessage<T extends RecoverableAssistantMessage>(
  messages: T[],
  taskId: string,
): boolean {
  return messages.some((message) =>
    message.role === "assistant" && message.taskId === taskId && !message.streaming,
  );
}

export function upsertRecoveredAssistant<T extends RecoverableAssistantMessage>(
  messages: T[],
  incoming: T,
): T[] {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "assistant" && (
      (incoming.taskId && message.taskId === incoming.taskId) ||
      (incoming.recoveryInvocationId &&
        message.recoveryInvocationId === incoming.recoveryInvocationId) ||
      (incoming.result?.invocation_id &&
        message.result?.invocation_id === incoming.result.invocation_id)
    )) {
      index = i;
      break;
    }
  }
  if (index >= 0) {
    const existing = messages[index];
    if (!existing.streaming && incoming.streaming) return messages;
    const next = [...messages];
    next[index] = {
      ...existing,
      ...incoming,
      streaming: incoming.streaming === true,
      createdAt: existing.createdAt ?? incoming.createdAt,
    };
    return next;
  }
  const last = messages.at(-1);
  if (last?.role === "assistant" && (
    last.streaming ||
    (incoming.recoveryInvocationId && !last.result && !last.taskId && !last.recoveryInvocationId)
  )) {
    return [...messages.slice(0, -1), { ...last, ...incoming, streaming: incoming.streaming === true }];
  }
  return [...messages, incoming];
}
