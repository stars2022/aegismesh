import { ExternalLink, TrendingDown, TrendingUp } from 'lucide-react'
import './DynamicUiRenderer.css'

import { normalizeDynamicUiBlocks, type DynamicUiBlock } from './dynamicUiData'
export type { DynamicUiBlock } from './dynamicUiData'

function safeHttpUrl(raw?: string): string | null {
  if (!raw || typeof raw !== 'string') return null
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

export function DynamicUiRenderer({
  blocks,
  onAction,
  fallbackText,
}: {
  blocks: DynamicUiBlock[]
  onAction: (prompt: string) => void
  fallbackText?: string
}) {
  const normalized = normalizeDynamicUiBlocks(blocks)
  return (
    <div className="dh-prefab-root">
      {!normalized.length && <p className="dh-ui-empty">未返回可展示的数据，请查看答复或继续追问。</p>}
      {normalized.map((block, index) => {
        if (!block || typeof block !== 'object') return null

        if (block.type === 'text') return <section key={index} className="dh-ui-block">{block.title && <h3 className="dh-ui-block-title">{block.title}</h3>}<p className="dh-ui-summary">{block.text}</p></section>

        if (block.type === 'kpi_grid' && Array.isArray(block.items) && block.items.length > 0) {
          return (
            <section key={index} className="dh-ui-block">
              {block.title && <h3 className="dh-ui-block-title">{block.title}</h3>}
              <div className="dh-ui-kpi-grid">
                {block.items.map((item: any, idx: number) => (
                  <div key={idx} className="dh-ui-kpi-card">
                    <span className="dh-ui-kpi-label">{item.label}</span>
                    <strong className="dh-ui-kpi-value">{item.value}</strong>
                    {item.delta && (
                      <span className={`dh-ui-kpi-delta is-${item.trend || 'flat'}`}>
                        {item.trend === 'up' && <TrendingUp size={13} />}
                        {item.trend === 'down' && <TrendingDown size={13} />}
                        {item.delta}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )
        }

        if (block.type === 'bar_chart' && Array.isArray(block.items) && block.items.length > 0) {
          const maxVal = Math.max(1, ...block.items.map((i: any) => Math.abs(Number(i.value) || 0)))
          return (
            <section key={index} className="dh-ui-block">
              {block.title && <h3 className="dh-ui-block-title">{block.title}</h3>}
              <div className="dh-ui-bars">
                {block.items.map((item: any, idx: number) => {
                  const pct = Math.max(2, Math.min(100, (Math.abs(Number(item.value) || 0) / maxVal) * 100))
                  return (
                    <div key={idx} className="dh-ui-bar-row">
                      <div className="dh-ui-bar-meta">
                        <span>{item.label}</span>
                        <strong>{item.display || String(item.value)}</strong>
                      </div>
                      <div className="dh-ui-bar-track">
                        <div className="dh-ui-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )
        }

        if (block.type === 'table' && Array.isArray(block.columns) && block.columns.length > 0) {
          const rows = Array.isArray(block.rows) ? block.rows : []
          return (
            <section key={index} className="dh-ui-block">
              {block.title && <h3 className="dh-ui-block-title">{block.title}</h3>}
              <div className="dh-ui-table-wrap">
                <table className="dh-ui-table">
                  <thead>
                    <tr>
                      {block.columns.map((col: string, idx: number) => (
                        <th key={idx}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row: string[], rIdx: number) => (
                      <tr key={rIdx}>
                        {block.columns!.map((_: string, cIdx: number) => (
                          <td key={cIdx}>{row?.[cIdx] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )
        }

        if (block.type === 'comparison' && block.items?.length) {
          const complete = block.items.filter((item: any) => item.summary || item.bullets?.length)
          const missing = block.items.filter((item: any) => !item.summary && !item.bullets?.length)
          return <section key={index} className="dh-ui-block dh-ui-comparison">
            <h3 className="dh-ui-block-title">{block.title}</h3>
            <dl className="dh-ui-comparison-list">{complete.map((item: any, idx: number) => <div key={idx} className="dh-ui-comparison-row">
              <dt>{item.label}</dt><dd>{item.summary && <p>{item.summary}</p>}{item.bullets?.length > 0 && <ul>{item.bullets.map((point: string, i: number) => <li key={i}>{point}</li>)}</ul>}</dd>
            </div>)}</dl>
            {missing.length > 0 && <p className="dh-ui-pending">待补充：{missing.map((item: any) => item.label).join('、')}</p>}
          </section>
        }

        if (block.type === 'cards' && Array.isArray(block.items) && block.items.length > 0) {
          return (
            <section key={index} className="dh-ui-block">
              {block.title && <h3 className="dh-ui-block-title">{block.title}</h3>}
              <div className="dh-ui-cards">
                {block.items.map((item: any, idx: number) => {
                  const href = safeHttpUrl(item.url)
                  return (
                    <article key={idx} className="dh-ui-card">
                      <div className="dh-ui-card-head">
                        <strong>{item.title}</strong>
                        {item.badge && <span className="dh-ui-badge">{item.badge}</span>}
                      </div>
                      {item.subtitle && <div className="dh-ui-card-sub">{item.subtitle}</div>}
                      {item.body && <p className="dh-ui-card-body">{item.body}</p>}
                      {href && (
                        <a className="dh-ui-card-link" href={href} target="_blank" rel="noopener noreferrer">
                          <span>查看来源</span>
                          <ExternalLink size={12} />
                        </a>
                      )}
                    </article>
                  )
                })}
              </div>
            </section>
          )
        }

        if (block.type === 'actions' && Array.isArray(block.items) && block.items.length > 0) {
          return (
            <div key={index} className="dh-ui-actions">
              {block.items.map((item: any, idx: number) => (
                <button key={idx} type="button" onClick={() => onAction(item.prompt || item.label)}>
                  {item.label}
                </button>
              ))}
            </div>
          )
        }

        return null
      })}
      {fallbackText && <details className="dh-ui-source"><summary>完整任务结果</summary><div className="dh-ui-summary">{fallbackText}</div></details>}
    </div>
  )
}
