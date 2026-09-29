import { ChevronDown } from 'lucide-react'

export type DispatchSummary = {
  id: string
  name: string
  task?: string
  status: string
  latency_ms?: number
  error?: string
}

/** Shared by chat's inspector and the canvas assistant. Long task prompts stay closed. */
export function DispatchCard({ dispatch }: { dispatch: DispatchSummary }) {
  const failed = dispatch.status === 'error' || dispatch.status === 'failed' || Boolean(dispatch.error)
  const running = ['running', 'working', 'pending', 'accepted'].includes(dispatch.status)
  const status = failed ? 'error' : running ? 'running' : 'completed'
  const task = dispatch.task || '暂无任务说明'
  const preview = task.replace(/\s+/g, ' ').slice(0, 140)
  return (
    <details className={`route-dispatch-card ${status}`}>
      <summary aria-label={`${dispatch.name}：任务详情`}>
        <div className="dispatch-header">
          <span className="dispatch-name" title={dispatch.name}>@{dispatch.name}</span>
          <span className={`dispatch-badge ${status}`}>{failed ? '调用异常' : running ? '执行中' : '已完成'}</span>
          <ChevronDown className="dispatch-chevron" size={14} />
        </div>
        <p className="dispatch-preview">{preview}{task.length > 140 ? '…' : ''}</p>
        <span className="dispatch-meta">
          <span className="dispatch-expand-label">展开任务</span><span className="dispatch-collapse-label">收起任务</span>
          {dispatch.latency_ms != null && ` · ${(dispatch.latency_ms / 1000).toFixed(1)} s`}
        </span>
      </summary>
      <div className="dispatch-body">
        <p className="dispatch-task">{task}</p>
        {dispatch.error && <p className="dispatch-err" role="note">{dispatch.error}</p>}
      </div>
    </details>
  )
}
