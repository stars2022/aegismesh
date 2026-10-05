import type { BountyBoardData } from './types'
import './BountyBoard.css'

const statusLabel: Record<string, string> = {
  open: '待认领', claimed: '执行中', submitted: '待复核', accepted: '已通过',
  rejected: '未通过', expired: '已过期', failed: '失败', cancelled: '已结束',
}

export function BountyBoardView({ board }: { board: BountyBoardData }) {
  return <section className="bounty-board" aria-label="自主认领任务板">
    <header><strong>任务板</strong><span>{board.items.length} / {board.max_items}</span></header>
    {board.items.map(item => <details key={item.id} className="bounty-item" data-status={item.status}>
      <summary><span className="bounty-title">{item.title}</span>
        <span className="bounty-status">{statusLabel[item.status] || item.status}</span></summary>
      <dl><div><dt>认领者</dt><dd>{item.claimed_by || '—'}</dd></div>
        <div><dt>优先级</dt><dd>{item.priority}</dd></div>
        <div><dt>验收条件</dt><dd>{item.acceptance}</dd></div></dl>
      {item.result && <p className="bounty-result">{item.result}</p>}
      {!!item.evidence?.length && <ul>{item.evidence.map((entry, index) => <li key={index}>{entry}</li>)}</ul>}
      {item.review_note && <p className="bounty-review">{item.reviewed_by || '系统'}：{item.review_note}</p>}
    </details>)}
    {!board.items.length && <p>等待成员提出并认领任务</p>}
  </section>
}
