import type { Agent, Attachment, ChatResult, DashboardData, Policy, ProbeResult, Provider, Trace, UploadResponse, StructuredTaskOptions } from './types'
import type { LogPage, LogRecord, LogStatus } from './logs'
import type { SearchSettings, SearchSettingsUpdate, SearchTestResult } from './WebSearchSettings'

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
  try {
    return await response.json() as T
  } catch {
    throw new Error('服务响应格式不正确，请稍后重试')
  }
}

export type StreamEvent = {
  type: string
  text?: string
  message?: string
  data?: any
}

export type CanvasDocument = {
  id: string
  title: string
  content: string
  version: number
  created_at?: string | null
  updated_at?: string | null
  revisions: { version: number; editor_name: string; summary: string; created_at: string }[]
}

function parseSseData(frame: string): StreamEvent | null {
  const data = frame.split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  return data ? JSON.parse(data) as StreamEvent : null
}

function parseSseIndex(frame: string): number | null {
  const line = frame.split('\n').find((item) => item.startsWith('id:'))
  if (!line) return null
  const index = Number(line.slice(3).trim())
  return Number.isSafeInteger(index) && index >= 0 ? index : null
}

async function waitBeforeReconnect(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('已取消', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
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
  let currentPath = path
  let currentMethod = method
  let taskId = path.match(/\/tasks\/([^/]+)\/stream(?:\?|$)/)?.[1]
  if (taskId) taskId = decodeURIComponent(taskId)
  const taskBase = path.startsWith('/api/demo/') ? '/api/demo/tasks' : '/api/tasks'
  let nextIndex = 0
  let reconnects = 0
  let hasUnindexedDelta = false

  while (true) {
    let terminalError = false
    try {
      const response = await fetch(currentPath, {
        method: currentMethod,
        credentials: 'same-origin',
        headers,
        signal,
        body: currentMethod === 'POST' ? JSON.stringify(payload) : undefined,
      })
      if (!response.ok) {
        terminalError = [401, 403, 404, 422].includes(response.status)
        const body = await response.json().catch(() => ({}))
        throw new Error(typeof body.detail === 'string' ? body.detail : `请求失败 (${response.status})`)
      }
      const headerTaskId = response.headers.get('X-Task-Id') || response.headers.get('x-task-id')
      if (headerTaskId) {
        taskId = headerTaskId
        onTaskId?.(headerTaskId)
      }
      if (!response.body) throw new Error('浏览器不支持流式响应')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const chunk = await reader.read()
        buffer = (buffer + decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done }))
          .replace(/\r\n/g, '\n')
        const frames = buffer.split('\n\n')
        buffer = frames.pop() || ''
        if (chunk.done && buffer.trim()) {
          frames.push(buffer)
          buffer = ''
        }
        for (const frame of frames) {
          const event = parseSseData(frame)
          if (!event) continue
          const index = parseSseIndex(frame)
          onEvent?.(event)
          if (event.type === 'status' && typeof event.data?.task_id === 'string') {
            const reportedTaskId: string = event.data.task_id
            taskId = reportedTaskId
            onTaskId?.(reportedTaskId)
          }
          if (event.type === 'delta' && event.text) {
            onDelta(event.text)
            if (index === null) hasUnindexedDelta = true
          }
          if (index !== null) nextIndex = Math.max(nextIndex, index + 1)
          if (event.type === 'error') {
            terminalError = true
            throw new Error(event.message || '任务执行失败')
          }
          if (event.type === 'result' && event.data) {
            await reader.cancel().catch(() => undefined)
            return event.data as ChatResult
          }
        }
        if (chunk.done) break
      }
      throw new Error('流式连接提前结束')
    } catch (error) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
      if (terminalError || !taskId || hasUnindexedDelta || reconnects >= 3) {
        throw error
      }
      reconnects += 1
      await waitBeforeReconnect(150 * 2 ** (reconnects - 1), signal)
      currentPath = `${taskBase}/${encodeURIComponent(taskId)}/stream?from_index=${nextIndex}`
      currentMethod = 'GET'
    }
  }
}

export const api = {
  logs: (query: string, signal?: AbortSignal) => request<LogPage>(`/api/admin/logs?${query}`, { signal }),
  logStatus: (signal?: AbortSignal) => request<LogStatus>('/api/admin/logs/status', { signal }),
  logDetail: (id: number, signal?: AbortSignal) => request<LogRecord>(`/api/admin/logs/${id}`, { signal }),
  exportLogs: async (query: string) => {
    const response = await fetch(`/api/admin/logs/export?${query}`, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`导出失败 (${response.status})，请确认登录状态后重试`)
    return response.blob()
  },
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
  demoSession: () => request<{ enabled: boolean; authenticated: boolean; owner_id?: string }>('/api/demo/session'),
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
  discoveryFeed: (refresh = false, query = '') =>
    request<any[]>(`/api/discovery/feed?${new URLSearchParams({ refresh: String(refresh), query })}`),
  discoverySearch: (query: string, limit?: number) =>
    request<{ result?: any; acsMap?: Record<string, any>; raw?: any; aliveMap?: Record<string, any>; candidates?: any[] }>('/api/discovery/search', {
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
  searchSettings: () => request<SearchSettings>('/api/admin/web-search'),
  updateSearchSettings: (payload: SearchSettingsUpdate) => request<SearchSettings>('/api/admin/web-search', {
    method: 'PUT', headers: jsonHeaders, body: JSON.stringify(payload),
  }),
  testSearchSettings: (payload: SearchSettingsUpdate) => request<SearchTestResult>('/api/admin/web-search/test', {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload),
  }),
  policy: () => request<Policy>('/api/policy'),
  chatConfig: () => request<{ interop_compatibility: boolean; bounty_enabled?: boolean; default_coordinator_id: string | null }>('/api/chat/config'),
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
  createGroupChat: (payload: { name: string; host_agent_id?: string; members: string[] }) =>
    request<{ id: string; name: string; transport: "local" | "aip-mq"; members: string[] }>('/api/group-chat', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    }),
  sendGroupChatMessage: (groupId: string, text: string, mentioned?: string) =>
    request<{ reply: string | null; agent_id: string | null; agent_name: string | null; transport: string; error?: string }>(
      `/api/group-chat/${groupId}/messages`,
      { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ text, mentioned: mentioned || undefined }) },
    ),
  getCanvas: (canvasId: string) =>
    request<CanvasDocument>(
      `/api/canvas/${canvasId}`,
    ),
  getCanvasRevision: (canvasId: string, version: number) =>
    request<{ version: number; content: string; summary: string }>(`/api/canvas/${encodeURIComponent(canvasId)}/revisions/${version}`),
  getSessionCanvas: (sessionId: string) =>
    request<CanvasDocument>(
      `/api/canvas/session/${encodeURIComponent(sessionId)}`,
    ),
  updateSessionCanvas: (sessionId: string, content: string, baseVersion: number) =>
    request<CanvasDocument>(`/api/canvas/session/${encodeURIComponent(sessionId)}`, {
      method: 'PUT', headers: jsonHeaders,
      body: JSON.stringify({ content, base_version: baseVersion }),
    }),
  chat: (message: string, sessionId?: string, agentId?: string, attachments?: Attachment[]) =>
    request<ChatResult>('/api/demo/chat', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        message,
        session_id: sessionId,
        agent_id: agentId || undefined,
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
    canvas?: boolean,
    mode: 'route' | 'bounty' = 'route',
    structuredOptions?: StructuredTaskOptions,
  ) =>
    streamChat(
      '/api/demo/chat/stream',
      {
        message,
        session_id: sessionId,
        agent_id: agentId || undefined,
        canvas: canvas || undefined,
        mode,
        interface: 'harness',
        attachments: attachments || [],
        ...structuredOptions,
      },
      onDelta,
      onEvent,
      'POST',
      signal,
      onTaskId,
    ),
  getActiveTask: (sessionId: string) =>
    request<{ active: boolean; interrupted?: { invocation_id: string; message: string; partial_result?: string }; task?: { task_id: string; agent_id?: string; status: string; event_count: number; has_result: boolean; error?: string; created_at?: number } }>(
      `/api/demo/tasks/active?session_id=${encodeURIComponent(sessionId)}`,
    ),
  assistantChatStream: (message: string, sessionId: string, signal: AbortSignal, onTaskId: (taskId: string) => void) =>
    streamChat('/api/demo/chat/stream', { message, session_id: sessionId, interface: 'harness', presentation: 'assistant', mode: 'collaborate', collab_style: 'auto' }, () => undefined, undefined, 'POST', signal, onTaskId),
  sessionActivity: (sessionId: string, before?: string) =>
    request<{ session_id: string; items: ChatResult[]; next_before: string | null }>(
      `/api/chat/sessions/${encodeURIComponent(sessionId)}/activity${before ? `?before=${encodeURIComponent(before)}` : ''}`,
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
