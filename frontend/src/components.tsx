import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export function StatusDot({ status }: { status: string }) {
  const tone = status === 'online' || status === 'completed' || status === 'closed' ? 'good' : status === 'offline' || status === 'failed' || status === 'open' ? 'bad' : 'warn'
  return <span className={`status-dot ${tone}`} aria-label={status} />
}

export function MetricCard({ label, value, note }: { label: string; value: string | number; note: string }) {
  return (
    <article className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-note">{note}</div>
    </article>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>
}

export function ScoreBar({ value, max = 100 }: { value: number; max?: number }) {
  return <div className="score-track"><span style={{ width: `${Math.min(100, (value / max) * 100)}%` }} /></div>
}

export type DropdownOption = { value: string; label: string }

export function Dropdown({ value, options, onChange, placeholder, className, align, title }: { value: string; options: DropdownOption[]; onChange: (value: string) => void; placeholder?: string; className?: string; align?: 'left' | 'right'; title?: string }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  const current = options.find((option) => option.value === value)
  const emptyText = placeholder || (options.length === 0 ? '暂无可用选项' : '请选择')
  return (
    <div className={`dropdown ${className || ''}`} ref={root}>
      <button type="button" className="dropdown-trigger" onClick={() => setOpen((state) => !state)} aria-haspopup="listbox" aria-expanded={open} title={title}>
        <span>{current?.label || emptyText}</span>
        <ChevronDown size={13} className={`chev ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className={`dropdown-menu ${align === 'right' ? 'right' : ''}`} role="listbox">
          {options.length === 0 ? (
            <div className="dropdown-empty" style={{ padding: '8px 12px', color: 'var(--c777771)', fontSize: '11px', whiteSpace: 'nowrap' }}>
              暂无可选项
            </div>
          ) : (
            options.map((option) => (
              <button key={option.value} type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'active' : ''} onClick={() => { onChange(option.value); setOpen(false) }}>
                <span>{option.label}</span>
                {option.value === value && <Check size={12} />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label?: string }) {
  return (
    <label className="switch-row">
      {label && <span>{label}</span>}
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
        <span className="knob" />
      </button>
    </label>
  )
}
