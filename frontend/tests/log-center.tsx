// Dev-only visual fixture using the production page, with clearly labelled test data.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LogCenter, type LogClient } from '../src/LogCenter'
import type { LogRecord, LogStatus } from '../src/logs'
import '../src/styles.css'

const stamp = new Date().toISOString()
const common = { occurred_at: stamp, indexed_at: stamp, level: 'INFO', caller_aic: '', callee_aic: '', task_id: '', trace_id: '', message_id: '', request_id: '', actor: '', action: '', target: '', status_code: null, duration_ms: null, source_file: '', aic: '' }
const data: LogRecord[] = [
  { ...common, id: 3, origin: 'amp', kind: 'access', outcome: 'error', status_code: 422, duration_ms: 152, aic: '1.2.156.3088.1.BUPT.EXAMPLE.RESEARCH', task_id: 'task-preview-001', caller_aic: 'research-leader', callee_aic: 'external-agent', summary: 'POST /rpc · HTTP 422', source_file: 'amp_access_aegismesh.jsonl', delivery: 'not_observed', detail: { body: { response: { statusCode: 422 }, error: { message: '目标端点请求参数校验失败（测试示例）' } } } },
  { ...common, id: 2, origin: 'amp', kind: 'message', outcome: 'success', aic: '1.2.156.3088.1.BUPT.EXAMPLE.RESEARCH', task_id: 'task-preview-001', message_id: 'msg-preview-001', summary: 'rabbitmq · ack · basic.ack', source_file: 'amp_message_aegismesh.jsonl', delivery: 'not_observed', detail: { body: { eventType: 'ack', messageId: 'msg-preview-001' } } },
  { ...common, id: 1, origin: 'amp', kind: 'system', outcome: 'unknown', summary: 'AegisMesh 启动完成并已开启 AMP 可观测性追踪', source_file: 'amp_system_aegismesh.jsonl', delivery: 'not_observed', detail: { body: { category: 'lifecycle' } } },
  { ...common, id: 5, origin: 'admin', kind: 'audit', outcome: 'success', actor: '示例管理员', action: '修改路由策略', summary: '修改路由策略 · HTTP 200', target: '/api/policy', request_id: 'request-preview-002', status_code: 200, delivery: 'local_only', detail: { policy_changes: { interop_compatibility: { before: false, after: true } } } },
  { ...common, id: 4, origin: 'admin', kind: 'audit', outcome: 'error', actor: '示例管理员', action: '提交智能体审核', summary: '提交智能体审核 · HTTP 422', target: '/api/agents/agent_discovery/registration', request_id: 'request-preview-001', status_code: 422, delivery: 'local_only', detail: { note: '端点必须声明 mutualTLS 双向证书认证（测试示例）' } },
]
const status: LogStatus = { sources: ['access', 'message', 'system'].map(kind => ({ name: `amp_${kind}_aegismesh.jsonl`, offset: 4096, size: 4096, pending_bytes: 0, invalid_lines: 0, expired_lines: 0, rotations: 0, rotation_gaps: 0, error: '', checked_at: stamp })), indexer_enabled: true, poll_seconds: 5, audit_write_failures: 0, retention: { amp_days: 7, amp_limit: 100000, audit_days: 90, audit_limit: 50000 }, delivery: { state: 'not_observed', message: '本地落盘及 MQ ack 不代表 AMP 平台已接收或计榜；当前未接入平台回执。' } }
const client: LogClient = {
  logs: async query => {
    const params = new URLSearchParams(query)
    const kind = params.get('kind')
    const items = data.filter(row => row.origin === params.get('origin') && (!kind || kind === 'activity' || row.kind === kind) && (!params.get('outcome') || row.outcome === params.get('outcome')) && (!params.get('aic') || [row.aic, row.caller_aic, row.callee_aic].includes(params.get('aic')!)) && (!params.get('related_id') || [row.task_id, row.trace_id, row.message_id, row.request_id].includes(params.get('related_id')!)) && (!params.get('q') || JSON.stringify(row).includes(params.get('q')!)) && (!params.get('since') || row.occurred_at >= params.get('since')!) && (!params.get('until') || row.occurred_at <= params.get('until')!))
    return { items, total: items.length, errors: items.filter(row => row.outcome === 'error').length, next_cursor: '' }
  },
  logDetail: async id => data.find(row => row.id === id)!, logStatus: async () => status,
  exportLogs: async () => new Blob(['{"preview_only":true}\n'], { type: 'application/x-ndjson' }),
}
function Preview() {
  const [theme, setTheme] = useState('dark')
  return <main className="design-next" style={{ maxWidth: 1260, padding: '24px', margin: 'auto' }}><div className="fixture-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', marginBottom: 24 }}><strong>本地验收预览 · 以下均为测试示例，不是生产记录</strong><button className="secondary-button" onClick={() => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); document.documentElement.dataset.theme = next }}>切换深浅色</button></div><LogCenter client={client} /></main>
}
const previewRoot = createRoot(document.getElementById('root')!)
previewRoot.render(<Preview />)
if (import.meta.hot) import.meta.hot.dispose(() => previewRoot.unmount())
