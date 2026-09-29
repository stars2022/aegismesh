import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, Download, FileText, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { api } from './api'
import { Dropdown, Switch } from './components'
import { initialLogFilter, logKindNames, logOutcomeNames, logQuery, type LogFilter, type LogPage, type LogRecord, type LogStatus } from './logs'
import './LogCenter.css'

export type LogClient = Pick<typeof api, 'logs' | 'logStatus' | 'logDetail' | 'exportLogs'>
const kinds = [
  { value: 'activity', label: '调用、消息与系统事件' }, { value: '', label: '全部 AMP 类型' },
  ...Object.entries(logKindNames).map(([value, label]) => ({ value, label })),
]
const outcomes = [{ value: '', label: '全部结果' }, { value: 'error', label: '只看异常' }, { value: 'success', label: '成功' }, { value: 'unknown', label: '信息 / 未知' }]
const periods = [{ value: '24h', label: '最近 24 小时' }, { value: '7d', label: '最近 7 天' }, { value: '30d', label: '最近 30 天' }, { value: 'all', label: '全部保留记录' }, { value: 'custom', label: '自定义时间' }]
const timeLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`

function LogEvent({ record, client, onRelated }: { record: LogRecord; client: LogClient; onRelated: (id: string) => void }) {
  const [opened, setOpened] = useState(false)
  const [detail, setDetail] = useState<LogRecord | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!opened || detail) return
    const controller = new AbortController()
    setError('')
    client.logDetail(record.id, controller.signal).then(value => { if (!controller.signal.aborted) setDetail(value) }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '详情加载失败')
    })
    return () => controller.abort()
  }, [opened, detail, record.id, client, attempt])
  const diagnostic = detail?.detail?.note || (detail?.detail?.body as { error?: { message?: string } } | undefined)?.error?.message
  const identifiers = [['任务', record.task_id], ['链路', record.trace_id], ['消息', record.message_id], ['请求', record.request_id]].filter(([, value]) => value)
  return <details className="log-event" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>
      <time dateTime={record.occurred_at}>{timeLabel(record.occurred_at)}</time>
      <span className={`log-result ${record.outcome}`}>{logOutcomeNames[record.outcome] || record.outcome}</span>
      <span className="log-kind">{record.origin === 'admin' ? '管理' : logKindNames[record.kind]}</span>
      <span className="log-event-copy"><strong>{record.summary}</strong><small>{record.origin === 'admin' ? `${record.actor} · ${record.target}` : `${record.aic || '未标识 AIC'}${record.task_id ? ` · ${record.task_id}` : ''}`}</small></span>
      <ChevronDown size={16} className="log-chevron" />
    </summary>
    {opened && <div className="log-event-detail">
      <dl>
        {record.actor && <><dt>操作人</dt><dd>{record.actor}</dd></>}
        {record.caller_aic && <><dt>调用方</dt><dd>{record.caller_aic}</dd></>}
        {record.callee_aic && <><dt>被调用方</dt><dd>{record.callee_aic}</dd></>}
        {record.duration_ms != null && <><dt>耗时</dt><dd>{Math.round(record.duration_ms)} ms</dd></>}
        {record.source_file && <><dt>来源</dt><dd>{record.source_file}</dd></>}
        <dt>记录状态</dt><dd>{record.delivery === 'local_only' ? '仅本地管理审计，不参与 AMP 上报' : '本地已记录；平台接收 / 计榜未确认'}</dd>
        {typeof diagnostic === 'string' && diagnostic && <><dt>诊断信息</dt><dd>{diagnostic}</dd></>}
      </dl>
      {identifiers.length > 0 && <div className="log-related">{identifiers.map(([label, id]) => <button type="button" key={label} onClick={() => onRelated(id)} title={`查看关联${label}：${id}`}><span>{label}：{id}</span><ArrowRight size={14} /></button>)}</div>}
      {error ? <p className="log-error" role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>重试</button></p> : !detail ? <p className="turn-status-text">正在读取详情…</p> : <details className="log-json"><summary>查看脱敏字段 <ChevronDown size={14} /></summary><pre>{JSON.stringify(detail.detail, null, 2)}</pre><p>仅展示排障字段，不是原始签名载荷；请求正文、认证头和密钥字段不进入本地索引。</p></details>}
    </div>}
  </details>
}

export function LogCenter({ client = api, refreshKey = 0 }: { client?: LogClient; refreshKey?: number }) {
  const [draft, setDraft] = useState<LogFilter>(initialLogFilter)
  const [applied, setApplied] = useState<LogFilter>(initialLogFilter)
  const [page, setPage] = useState<LogPage | null>(null)
  const [status, setStatus] = useState<LogStatus | null>(null)
  const [trail, setTrail] = useState<string[]>([''])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [auto, setAuto] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState('')
  const pending = useRef<AbortController | null>(null)
  const activeFilter = useRef(initialLogFilter)
  const load = useCallback(async (filter: LogFilter, cursors: string[] = ['']) => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setLoading(true)
    setError('')
    try {
      const query = logQuery(filter, cursors.at(-1))
      const [next, health] = await Promise.all([client.logs(query, controller.signal), client.logStatus(controller.signal)])
      if (controller.signal.aborted) return
      setPage(next); setStatus(health); setApplied(filter); setTrail(cursors); activeFilter.current = filter
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '日志读取失败')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [client])
  useEffect(() => { void load(initialLogFilter); return () => pending.current?.abort() }, [load])
  useEffect(() => { if (refreshKey) void load(activeFilter.current) }, [refreshKey, load])
  useEffect(() => {
    if (!auto || trail.length > 1) return
    const timer = window.setInterval(() => { if (!loading && document.visibilityState === 'visible') void load(applied) }, 10000)
    return () => window.clearInterval(timer)
  }, [auto, applied, load, loading, trail.length])
  const change = <K extends keyof LogFilter>(key: K, value: LogFilter[K]) => setDraft(previous => ({ ...previous, [key]: value }))
  const search = (event: FormEvent) => { event.preventDefault(); void load(draft) }
  const related = (id: string) => {
    const next = { ...applied, q: '', aic: '', related_id: id, period: 'all' as const, kind: '', outcome: '' }
    setDraft(next); void load(next)
  }
  const exportLogs = async () => {
    setExporting(true); setNotice('')
    try {
      const blob = await client.exportLogs(logQuery(applied))
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = 'aegismesh-redacted-logs.jsonl'
      document.body.appendChild(anchor); anchor.click(); anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice('已导出当前筛选下最新最多 2000 条脱敏记录；文件首行包含匹配总数和截断说明。')
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : '导出失败') }
    finally { setExporting(false) }
  }
  const sourceWarnings = status?.sources.filter(source => (source.error && source.error !== 'not_created') || source.invalid_lines > 0 || source.rotation_gaps > 0) || []
  const pendingBytes = status?.sources.reduce((sum, source) => sum + source.pending_bytes, 0) || 0
  return <div className="log-center">
    <div className="log-center-intro"><div><h2>互联事件与管理操作</h2><p>本地查询不影响直通上报；落盘、MQ 确认和平台计榜分别看待。</p></div><button className="secondary-button" disabled={exporting || !page?.items.length || loading} onClick={() => void exportLogs()}><Download size={18} />{exporting ? '正在导出' : '导出脱敏日志'}</button></div>
    <div className="log-control-row">
      <div className="log-tabs" role="tablist" aria-label="日志来源" style={{ '--pill-index': draft.origin === 'admin' ? 1 : 0 } as CSSProperties}>{(['amp', 'admin'] as const).map(origin => <button role="tab" aria-label={origin === 'amp' ? '互联日志' : '管理审计'} title={origin === 'amp' ? '互联日志' : '管理审计'} aria-selected={draft.origin === origin} key={origin} onClick={() => { const next = { ...initialLogFilter, origin }; setDraft(next); void load(next) }}>{origin === 'amp' ? <FileText size={18} /> : <ShieldCheck size={18} />}<span>{origin === 'amp' ? '互联日志' : '管理审计'}</span></button>)}</div>
      <div className="log-live-controls"><Switch label="自动刷新" checked={auto} onChange={setAuto} /><button type="button" className="icon-button" title="刷新日志" aria-label="刷新日志" disabled={loading} onClick={() => void load(applied)}><RefreshCw size={18} /></button></div>
    </div>
    <form className="log-filters" onSubmit={search}>
      <label className="log-search"><Search size={17} /><input aria-label="搜索日志" placeholder="搜索任务号、AIC、操作人或错误" value={draft.q} maxLength={200} onChange={event => change('q', event.target.value)} /></label>
      {draft.origin === 'amp' && <Dropdown title="日志类型" value={draft.kind} options={kinds} onChange={value => change('kind', value)} />}
      <Dropdown title="执行结果" value={draft.outcome} options={outcomes} onChange={value => change('outcome', value)} />
      <Dropdown title="时间范围" value={draft.period} options={periods} onChange={value => change('period', value as LogFilter['period'])} />
      <button type="submit" className="primary-button" disabled={loading}>查询</button>
      <details className="log-advanced" open={draft.period === 'custom' || Boolean(draft.aic || draft.related_id) || undefined}><summary>精确筛选 <ChevronDown size={14} /></summary><div>
        {draft.origin === 'amp' && <label>智能体 AIC<input value={draft.aic} placeholder="发送方、接收方或报告方 AIC" maxLength={255} onChange={event => change('aic', event.target.value)} /></label>}
        <label>关联标识<input value={draft.related_id} placeholder="完整任务 / 链路 / 消息 / 请求 ID" maxLength={255} onChange={event => change('related_id', event.target.value)} /></label>
        {draft.period === 'custom' && <><label>起始时间<input type="datetime-local" value={draft.since} onChange={event => change('since', event.target.value)} /></label><label>结束时间<input type="datetime-local" value={draft.until} onChange={event => change('until', event.target.value)} /></label></>}
      </div></details>
    </form>
    {error && <p className="log-error" role="alert">{error}{page ? '；以下仍为上次查询结果。' : ''}</p>}
    {notice && <p className="log-notice" role="status">{notice}</p>}
    {(sourceWarnings.length > 0 || (status?.audit_write_failures || 0) > 0) && <p className="log-error" role="alert">采集曾跳过记录或发生读取 / 写入异常，请展开下方“采集与保留”查看；当前列表可能不完整。</p>}
    <div className="log-result-bar" aria-live="polite"><span>{loading ? <span className="turn-status-text">正在读取本地日志…</span> : `匹配 ${page?.total || 0} 条 · 异常 ${page?.errors || 0} 条`}</span><span>{applied.origin === 'admin' ? '本地管理审计' : pendingBytes ? `历史索引进行中 · 剩余 ${bytes(pendingBytes)}` : '平台回执：未接入'}</span></div>
    <section className="log-list" aria-label="日志列表" aria-busy={loading}>
      {page?.items.map(record => <LogEvent key={record.id} record={record} client={client} onRelated={related} />)}
      {!loading && !page?.items.length && !error && <div className="log-empty"><FileText size={24} /><h3>暂无匹配记录</h3><p>{applied.origin === 'admin' ? '管理审计从功能启用后开始记录，不补造历史操作。' : pendingBytes ? '已有日志正在建立索引，稍后刷新即可查看。' : '可扩大时间范围或选择其他日志类型。尚未落盘的事件不会被编造。'}</p></div>}
    </section>
    <div className="log-pagination"><span>第 {trail.length} 页 · 每页最多 25 条{auto && trail.length > 1 ? ' · 翻页时暂停自动刷新' : ''}</span><div><button className="secondary-button" disabled={trail.length === 1 || loading} onClick={() => void load(applied, trail.slice(0, -1))}><ArrowLeft size={18} />上一页</button><button className="secondary-button" disabled={!page?.next_cursor || loading} onClick={() => void load(applied, [...trail, page!.next_cursor])}>下一页<ArrowRight size={18} /></button></div></div>
    <details className="log-source-status"><summary>采集与保留 <span>{sourceWarnings.length ? `${sourceWarnings.length} 个来源异常` : `${status?.sources.filter(source => !source.error).length || 0} 个日志源`}</span><ChevronDown size={15} /></summary>
      {status && <><p>{status.delivery.message}</p><p>AMP 查询索引保留 {status.retention.amp_days} 天 / 最多 {status.retention.amp_limit.toLocaleString()} 条；管理审计保留 {status.retention.audit_days} 天 / 最多 {status.retention.audit_limit.toLocaleString()} 条（任一上限先到即清理索引）。原始 AMP 文件及上报游标不受影响。</p><p>采集周期 {status.poll_seconds} 秒；采集器{status.indexer_enabled ? '已启用' : '未启用'}。本进程审计写入失败 {status.audit_write_failures} 次。仅管理员可查，无界面删除入口；本地审计不是第三方防篡改存证。</p>
        <div className="log-sources">{status.sources.map(source => <div key={source.name}><strong>{source.name}</strong><span>{source.error === 'not_created' ? '尚未产生' : source.error ? '读取异常' : `已读取 ${bytes(source.offset)} / ${bytes(source.size)}`}</span><small>无效行 {source.invalid_lines} · 过期跳过 {source.expired_lines} · 文件重建 {source.rotations}{source.rotation_gaps > 0 ? `（其中 ${source.rotation_gaps} 次存在未读内容）` : ''} · {timeLabel(source.checked_at)}</small></div>)}</div></>}
    </details>
  </div>
}
