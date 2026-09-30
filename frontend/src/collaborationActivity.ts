import type { ChatResult, SubagentCollaboration, ToolActivity } from './types'

export function mergeTools(previous: ToolActivity[] = [], incoming: ToolActivity[] = []): ToolActivity[] {
  const result = [...previous]
  incoming.forEach((tool, index) => {
    const found = result.findIndex(old => tool.id && old.id ? tool.id === old.id :
      old.name === tool.name && JSON.stringify(old.arguments) === JSON.stringify(tool.arguments) &&
      result.indexOf(old) === index)
    if (found < 0) result.push(tool)
    else {
      const old = result[found]
      const stale = old.status && old.status !== 'running' && tool.status === 'running'
      result[found] = { ...old, ...tool, status: stale ? old.status : tool.status || old.status,
        output_preview: tool.output_preview || old.output_preview }
    }
  })
  return result
}

export function collaborationKey(item: SubagentCollaboration): string {
  return item.task_id || `${item.invocation_id || 'legacy'}:${item.agent_id}:${item.task}`
}

export function mergeCollaborations(items: SubagentCollaboration[]): SubagentCollaboration[] {
  const records = new Map<string, SubagentCollaboration>()
  for (const item of items) {
    const key = collaborationKey(item)
    const old = records.get(key)
    if (!old) { records.set(key, item); continue }
    // A late replay/start event cannot erase a completed task or its tools.
    const stale = old.status !== 'running' && item.status === 'running'
    records.set(key, { ...old, ...item,
      status: stale ? old.status : item.status,
      result: item.result || old.result, error: item.error || old.error,
      current_tool: stale ? undefined : item.current_tool,
      tools: mergeTools(old.tools, item.tools),
    })
  }
  return [...records.values()]
}

export function mergeSessionResults(sessionId: string, ...batches: ChatResult[][]): ChatResult[] {
  const result = new Map<string, ChatResult>()
  for (const item of batches.flat()) {
    if (item.session_id !== sessionId) continue
    const old = result.get(item.invocation_id)
    const running = (status: string) => status === 'working' || status === 'routing'
    const stale = old && !running(old.status) && running(item.status)
    result.set(item.invocation_id, { ...old, ...item,
      status: stale ? old.status : item.status,
      answer: item.answer || old?.answer || '',
      result_data: { ...old?.result_data, ...item.result_data,
        collaborations: mergeCollaborations([...(old?.result_data?.collaborations || []), ...(item.result_data?.collaborations || [])]),
        runtime_tools: mergeTools(old?.result_data?.runtime_tools, item.result_data?.runtime_tools),
      },
    })
  }
  return [...result.values()]
}
