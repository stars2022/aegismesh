export type LogOrigin = 'amp' | 'admin'
export type LogFilter = {
  origin: LogOrigin
  kind: string
  outcome: string
  q: string
  aic: string
  related_id: string
  period: '24h' | '7d' | '30d' | 'all' | 'custom'
  since: string
  until: string
}
export type LogRecord = {
  id: number
  origin: LogOrigin
  kind: string
  occurred_at: string
  indexed_at: string
  level: string
  outcome: string
  aic: string
  caller_aic: string
  callee_aic: string
  task_id: string
  trace_id: string
  message_id: string
  request_id: string
  actor: string
  action: string
  target: string
  summary: string
  status_code: number | null
  duration_ms: number | null
  source_file: string
  delivery: 'not_observed' | 'local_only'
  detail?: Record<string, unknown>
}
export type LogPage = { items: LogRecord[]; next_cursor: string; total: number; errors: number }
export type LogStatus = {
  sources: { name: string; offset: number; size: number; pending_bytes: number; invalid_lines: number; expired_lines: number; rotations: number; rotation_gaps: number; error: string; checked_at: string }[]
  indexer_enabled: boolean
  poll_seconds: number
  audit_write_failures: number
  retention: { amp_days: number; amp_limit: number; audit_days: number; audit_limit: number }
  delivery: { state: string; message: string }
}
export const initialLogFilter: LogFilter = { origin: 'amp', kind: 'activity', outcome: '', q: '', aic: '', related_id: '', period: '7d', since: '', until: '' }

export function logQuery(filter: LogFilter, cursor = '', now = Date.now()): string {
  const params = new URLSearchParams({ origin: filter.origin, kind: filter.origin === 'admin' ? '' : filter.kind, limit: '25' })
  for (const key of ['q', 'aic', 'related_id', 'outcome'] as const) {
    if (filter[key].trim()) params.set(key, filter[key].trim())
  }
  if (cursor) params.set('cursor', cursor)
  if (filter.period === 'custom') {
    for (const key of ['since', 'until'] as const) {
      if (filter[key]) {
        const date = new Date(filter[key])
        if (!Number.isFinite(date.getTime())) throw new Error('请选择有效时间')
        params.set(key, date.toISOString())
      }
    }
    if (filter.since && filter.until && new Date(filter.since) > new Date(filter.until)) throw new Error('起始时间不能晚于结束时间')
  } else if (filter.period !== 'all') {
    const days = filter.period === '24h' ? 1 : filter.period === '7d' ? 7 : 30
    params.set('since', new Date(now - days * 86400000).toISOString())
  }
  return params.toString()
}

export const logKindNames: Record<string, string> = { access: '调用', message: '消息', heartbeat: '心跳', system: '系统', metrics: '指标', audit: '审计' }
export const logOutcomeNames: Record<string, string> = { success: '成功', error: '异常', unknown: '信息' }
