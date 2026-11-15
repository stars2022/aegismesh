import { useState } from 'react'
import { CheckCircle2, ExternalLink, TrendingDown, TrendingUp, XCircle } from 'lucide-react'
import './DynamicUiRenderer.css'

import { normalizeDynamicUiBlocks, type DynamicUiBlock } from './dynamicUiData'
export type { DynamicUiBlock } from './dynamicUiData'

const CHART_COLORS = ['#38bdf8', '#34d399', '#a78bfa', '#fbbf24', '#f87171', '#22d3ee']

function QuizBlock({ block, onAction }: { block: DynamicUiBlock; onAction: (prompt: string) => void }) {
  const [selected, setSelected] = useState<Record<string, string>>({})
  const questions = Array.isArray(block.questions) ? block.questions : []
  return (
    <section className="dh-ui-block dh-ui-quiz">
      {block.title && <h3 className="dh-ui-block-title">{block.title}</h3>}
      <div className="dh-ui-quiz-list">
        {questions.map((q: any, qIdx: number) => {
          const pickedKey = selected[q.id]
          const pickedOpt = q.options.find((o: any) => o.key === pickedKey)
          const hasCorrectFlag = q.options.some((o: any) => typeof o.correct === 'boolean')
          return (
            <div key={q.id || qIdx} className="dh-ui-quiz-item">
              <p className="dh-ui-quiz-question">{questions.length > 1 ? `${qIdx + 1}. ` : ''}{q.question}</p>
              <div className="dh-ui-quiz-options">
                {q.options.map((opt: any) => {
                  const isPicked = pickedKey === opt.key
                  const stateClass = isPicked && hasCorrectFlag
                    ? (opt.correct ? ' is-correct' : ' is-wrong')
                    : (isPicked ? ' is-selected' : '')
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      className={`dh-ui-quiz-opt${stateClass}`}
                      onClick={() => {
                        setSelected(prev => ({ ...prev, [q.id]: opt.key }))
                        if (!hasCorrectFlag) {
                          onAction(`我选择 ${opt.key}. ${opt.label}`)
                        }
                      }}
                    >
                      <span className="dh-ui-quiz-key">{opt.key}</span>
                      <span className="dh-ui-quiz-label">{opt.label}</span>
                      {isPicked && hasCorrectFlag && (opt.correct ? <CheckCircle2 size={16} /> : <XCircle size={16} />)}
                    </button>
                  )
                })}
              </div>
              {pickedOpt && hasCorrectFlag && (
                <div className={`dh-ui-quiz-feedback ${pickedOpt.correct ? 'is-correct' : 'is-wrong'}`}>
                  <strong>{pickedOpt.correct ? '回答正确' : '回答有误'}</strong>
                  <span>{pickedOpt.explanation || q.explanation || (pickedOpt.correct ? '做得很好！' : `正确答案：${q.options.find((o: any) => o.correct)?.key || ''}`)}</span>
                  <button type="button" className="dh-ui-quiz-next" onClick={() => onAction(`这道题“${q.question}”我选了 ${pickedOpt.key}（${pickedOpt.label}），请继续讲解或出下一题`)}>
                    继续讲解 / 下一题
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function LineChartBlock({ block }: { block: DynamicUiBlock }) {
  const items = Array.isArray(block.items) ? block.items : []
  const values = items.map((i: any) => Number(i.value) || 0)
  const minVal = Math.min(...values, 0)
  const maxVal = Math.max(...values, minVal + 1)
  const span = maxVal - minVal || 1
  const width = 460
  const height = 160
  const padX = 28
  const padY = 20
  const plotW = width - padX * 2
  const plotH = height - padY * 2
  const pts = items.map((item: any, idx: number) => {
    const x = items.length <= 1 ? padX + plotW / 2 : padX + (idx / (items.length - 1)) * plotW
    const y = padY + (1 - ((Number(item.value) || 0) - minVal) / span) * plotH
    return { x, y, item }
  })
  const poly = pts.map((p: any) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const area = pts.length ? `${pts[0].x.toFixed(1)},${padY + plotH} ${poly} ${pts[pts.length - 1].x.toFixed(1)},${padY + plotH}` : ''
  return (
    <section className="dh-ui-block">
      {block.title && <h3 className="dh-ui-block-title">{block.title}</h3>}
      <svg className="dh-ui-svg-chart" viewBox={`0 0 ${width} ${height + 24}`} role="img" aria-label={block.title || '趋势图'}>
        <defs>
          <linearGradient id="dhLineFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={padX} y1={padY + plotH} x2={width - padX} y2={padY + plotH} stroke="rgba(148,163,184,0.28)" strokeWidth="1" />
        {area && <polygon points={area} fill="url(#dhLineFill)" />}
        {poly && <polyline points={poly} fill="none" stroke="#38bdf8" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
        {pts.map((p: any, idx: number) => (
          <g key={idx}>
            <circle cx={p.x} cy={p.y} r="4" fill="#0f172a" stroke="#38bdf8" strokeWidth="2" />
            <text x={p.x} y={Math.max(12, p.y - 8)} textAnchor="middle" fill="#e0f2fe" fontSize="11">{p.item.display || p.item.value}</text>
            <text x={p.x} y={height + 12} textAnchor="middle" fill="#94a3b8" fontSize="11">{p.item.label}</text>
          </g>
        ))}
      </svg>
    </section>
  )
}

function PieChartBlock({ block }: { block: DynamicUiBlock }) {
  const items = Array.isArray(block.items) ? block.items : []
  const total = Math.max(1e-6, items.reduce((sum: number, i: any) => sum + Math.max(0, Number(i.value) || 0), 0))
  const r = 44
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <section className="dh-ui-block">
      {block.title && <h3 className="dh-ui-block-title">{block.title}</h3>}
      <div className="dh-ui-pie-wrap">
        <svg className="dh-ui-pie-svg" viewBox="0 0 120 120" role="img" aria-label={block.title || '占比图'}>
          {items.map((item: any, idx: number) => {
            const val = Math.max(0, Number(item.value) || 0)
            const dash = (val / total) * c
            const seg = (
              <circle
                key={idx}
                cx="60"
                cy="60"
                r={r}
                fill="none"
                stroke={CHART_COLORS[idx % CHART_COLORS.length]}
                strokeWidth="18"
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 60 60)"
              />
            )
            offset += dash
            return seg
          })}
        </svg>
        <ul className="dh-ui-pie-legend">
          {items.map((item: any, idx: number) => {
            const pct = ((Math.max(0, Number(item.value) || 0) / total) * 100).toFixed(1)
            return (
              <li key={idx}>
                <span className="dh-ui-pie-dot" style={{ background: CHART_COLORS[idx % CHART_COLORS.length] }} />
                <span className="dh-ui-pie-name">{item.label}</span>
                <strong>{item.display || `${pct}%`}</strong>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

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
  const contentBlocks = normalized.filter(block => block.type !== 'actions')
  const actionBlocks = normalized.filter(block => block.type === 'actions' && Array.isArray(block.items) && block.items.length > 0)
  return (
    <div className="dh-prefab-root">
      {!normalized.length && <p className="dh-ui-empty">未返回可展示的数据，请查看答复或继续追问。</p>}
      {contentBlocks.map((block, index) => {
        if (!block || typeof block !== 'object') return null

        if (block.type === 'quiz') return <QuizBlock key={index} block={block} onAction={onAction} />

        if (block.type === 'line_chart' && Array.isArray(block.items) && block.items.length > 0) return <LineChartBlock key={index} block={block} />

        if (block.type === 'pie_chart' && Array.isArray(block.items) && block.items.length > 0) return <PieChartBlock key={index} block={block} />

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

        return null
      })}
      {fallbackText && <details className="dh-ui-source"><summary>完整任务结果</summary><div className="dh-ui-summary">{fallbackText}</div></details>}
      {actionBlocks.length > 0 && (
        <div className="dh-ui-actions-dock" aria-label="快捷候选操作">
          {actionBlocks.map((block, bIdx) => (
            <div key={bIdx} className="dh-ui-actions">
              {block.items.map((item: any, idx: number) => (
                <button key={idx} type="button" onClick={() => onAction(item.prompt || item.label)}>
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
