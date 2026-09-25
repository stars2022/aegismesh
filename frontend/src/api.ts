import type { Agent, Attachment, ChatResult, DashboardData, Policy, ProbeResult, Provider, Trace, UploadResponse } from './types'

const jsonHeaders = { 'Content-Type': 'application/json' }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.headers || {}
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const detail = body.detail
    if (Array.isArray(detail)) {
      const messages = detail.map((item) => {
        const field = Array.isArray(item?.loc) ? item.loc.at(-1) : ''
        return `${field ? `${field}：` : ''}${item?.msg || '格式不正确'}`
      })
      throw new Error(messages.join('；'))
    }
    throw new Error(typeof detail === 'string' ? detail : `请求失败 (${response.status})`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export type StreamEvent = {
  type: string
  text?: string
  message?: string
  data?: any
}

async function streamChat(
  path: string,
  payload: Record<string, unknown>,
  onDelta: (text: string) => void,
  onEvent?: (event: StreamEvent) => void,
  method: 'POST' | 'GET' = 'POST',
  signal?: AbortSignal,
  onTaskId?: (taskId: string) => void,
): Promise<ChatResult> {
  const headers = { ...jsonHeaders }
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    signal,
    body: method === 'POST' ? JSON.stringify(payload) : undefined,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(typeof body.detail === 'string' ? body.detail : `请求失败 (${response.status})`)
  }
  const headerTaskId = response.headers.get('X-Task-Id') || response.headers.get('x-task-id')
  if (headerTaskId && onTaskId) {
    onTaskId(headerTaskId)
  }
  if (!response.body) throw new Error('浏览器不支持流式响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: ChatResult | null = null
  while (true) {
    const chunk = await reader.read()
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() || ''
    for (const frame of frames) {
      const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
      if (!data) continue
      const event = JSON.parse(data) as StreamEvent
      if (onEvent) onEvent(event)
      if (event.type === 'status' && event.data?.task_id && onTaskId) {
        onTaskId(event.data.task_id)
      }
      if (event.type === 'delta' && event.text) onDelta(event.text)
      if (event.type === 'error') throw new Error(event.message || '任务执行失败')
      if (event.type === 'result' && event.data) result = event.data as ChatResult
    }
    if (chunk.done) break
  }
  if (!result) throw new Error('流式响应未返回结果')
  return result
}

export const api = {
  adminSession: () => request<{ enabled: boolean; authenticated: boolean; username: string | null }>('/api/admin/session'),
  adminLogin: (username: string, password: string) =>
    request<{ enabled: boolean; authenticated: boolean; username: string | null }>('/api/admin/login', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ username, password }),
    }),
  adminLogout: () => request<{ authenticated: boolean }>('/api/admin/logout', { method: 'POST' }),
  accessSettings: () => request<{ api_key_configured: boolean; api_key_from_environment: boolean; demo_password_enabled: boolean }>('/api/admin/access'),
  updateAccessSettings: (payload: { api_key?: string; clear_api_key?: boolean; demo_password?: string; clear_demo_password?: boolean }) =>
    request<{ api_key_configured: boolean; api_key_from_environment: boolean; demo_password_enabled: boolean }>('/api/admin/access', {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify(payload),
    }),
  demoSession: () => request<{ enabled: boolean; authenticated: boolean }>('/api/demo/session'),
  demoLogin: (password: string) => request<{ enabled: boolean; authenticated: boolean }>('/api/demo/login', {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ password }),
  }),
  dashboard: () => request<DashboardData>('/api/dashboard'),
  agents: () => request<Agent[]>('/api/agents'),
  createAgent: (payload: Partial<Agent> & { id: string; aic: string; name: string }) =>
    request<Agent>('/api/agents', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload) }),
  updateAgent: (id: string, payload: Partial<Agent>) =>
    request<Agent>(`/api/agents/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(payload) }),
  deleteAgent: (id: string) =>
    request<void>(`/api/agents/${id}`, { method: 'DELETE' }),
  registerAgent: (id: string, options?: string | { rpc_url?: string }) => {
    const body = typeof options === 'string' ? { rpc_url: options } : (options || {});
    return request<Agent>(`/api/agents/${id}/registration`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
  },
  agentAcsPreview: (id: string) =>
    request<{ acs: Record<string, unknown>; target_registry: string; registry_username: string; public_rpc_url: string }>(`/api/agents/${id}/acs-preview`),
  syncRegistration: (id: string) =>
    request<Agent>(`/api/agents/${id}/registration/sync`, { method: 'POST' }),
  issueCertificate: (id: string) =>
    request<{ aic: string; certPath: string; keyPath: string; trustBundlePath: string }>(`/api/agents/${id}/certificate`, { method: 'POST' }),
  submitFeedback: (invocationId: string, rating: 'positive' | 'negative') =>
    request<{ invocation_id: string; agent_id: string; rating: 'positive' | 'negative'; positive_count: number; negative_count: number }>(
      `/api/invocations/${encodeURIComponent(invocationId)}/feedback`,
      { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ rating }) },
    ),
  discoveryFeed: (refresh?: boolean) =>
    request<any[]>(`/api/discovery/feed${refresh ? '?refresh=true' : ''}`),
  discoverySearch: (query: string, limit?: number) =>
    request<{ result?: any; acsMap?: Record<string, any>; raw?: any; aliveMap?: Record<string, any> }>('/api/discovery/search', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ query, limit: limit || 10 }),
    }),
  importDiscoveredAgent: (payload: { aic: string; name: string; description?: string; endpoint?: string; transport?: string; skills?: any[]; streaming?: boolean; notification?: boolean; alive?: boolean | null; group?: boolean }) =>
    request<Agent>('/api/discovery/import', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    }),
  providers: () => request<Provider[]>('/api/providers'),
  createProvider: (payload: Partial<Provider> & { id: string; name: string; kind: Provider['kind']; base_url: string; default_model: string; api_key?: string }) =>
    request<Provider>('/api/providers', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload) }),
  updateProvider: (id: string, payload: Partial<Provider> & { api_key?: string; clear_api_key?: boolean }) =>
    request<Provider>(`/api/providers/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(payload) }),
  deleteProvider: (id: string) => request<void>(`/api/providers/${id}`, { method: 'DELETE' }),
  testProvider: (id: string) => request<{ ok: boolean; latency_ms: number }>(`/api/providers/${id}/test`, { method: 'POST' }),
  policy: () => request<Policy>('/api/policy'),
  updatePolicy: (payload: Policy) =>
    request<Policy>('/api/policy', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(payload) }),
  uploadFile: async (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return request<UploadResponse>('/api/upload', {
      method: 'POST',
      body: formData,
    })
  },
  chat: (message: string, sessionId?: string, agentId?: string, attachments?: Attachment[], collabStyle?: string) =>
    request<ChatResult>('/api/demo/chat', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        message,
        session_id: sessionId,
        agent_id: agentId || undefined,
        collab_style: collabStyle && collabStyle !== 'auto' ? collabStyle : undefined,
        interface: 'harness',
        attachments: attachments || [],
      }),
    }),
  chatStream: (
    message: string,
    sessionId: string | undefined,
    agentId: string | undefined,
    onDelta: (text: string) => void,
    onEvent?: (event: StreamEvent) => void,
    signal?: AbortSignal,
    onTaskId?: (taskId: string) => void,
    attachments?: Attachment[],
    collabStyle?: string,
  ) =>
    streamChat(
      '/api/demo/chat/stream',
      {
        message,
        session_id: sessionId,
        agent_id: agentId || undefined,
        collab_style: collabStyle && collabStyle !== 'auto' ? collabStyle : undefined,
        interface: 'harness',
        attachments: attachments || [],
      },
      onDelta,
      onEvent,
      'POST',
      signal,
      onTaskId,
    ),
  getActiveTask: (sessionId: string) =>
    request<{ active: boolean; task?: { task_id: string; status: string; event_count: number; has_result: boolean; error?: string; created_at?: number } }>(
      `/api/demo/tasks/active?session_id=${encodeURIComponent(sessionId)}`,
    ),
  reconnectTaskStream: (
    taskId: string,
    onDelta: (text: string) => void,
    onEvent?: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ) =>
    streamChat(
      `/api/demo/tasks/${encodeURIComponent(taskId)}/stream`,
      {},
      onDelta,
      onEvent,
      'GET',
      signal,
    ),
  cancelTask: async (taskId: string) => {
    try {
      return await request<{ ok: boolean }>(`/api/demo/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' })
    } catch {
      return await request<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' })
    }
  },
  traces: (limit = 50, offset = 0) =>
    request<Trace[]>(`/api/invocations?limit=${limit}&offset=${offset}`),
  probes: () => request<ProbeResult[]>('/api/probes'),
  runProbes: () => request<ProbeResult[]>('/api/probes/run', { method: 'POST' }),
  exportDatabase: async () => {
    const response = await fetch('/api/admin/database/export', { credentials: 'same-origin' })
    if (!response.ok) throw new Error('数据库导出失败')
    return response.blob()
  },
  importDatabase: (data: Record<string, unknown>, mode: 'merge' | 'replace') =>
    request<{ imported: Record<string, number>; mode: string }>('/api/admin/database/import', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ data, mode }),
    }),
}
