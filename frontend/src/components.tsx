import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { createPortal } from 'react-dom'

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

// Dialogs keep their menus inside the same focus/inert boundary.
export const DropdownPortalContext = createContext<HTMLElement | null>(null)

export function Dropdown({ value, options, onChange, placeholder, className, align, title, leadingIcon, disabled = false }: { value: string; options: DropdownOption[]; onChange: (value: string) => void; placeholder?: string; className?: string; align?: 'left' | 'right'; title?: string; leadingIcon?: ReactNode; disabled?: boolean }) {
  const portal = useContext(DropdownPortalContext)
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0, bottom: 0, width: 0, upward: false })
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  const positionMenu = () => {
    const rect = root.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(Math.max(rect.width, 210), window.innerWidth - 16)
    const upward = window.innerHeight - rect.bottom < 260 && rect.top > 260
    setMenuPosition({
      left: Math.max(8, Math.min(align === 'right' ? rect.right - width : rect.left, window.innerWidth - width - 8)),
      top: rect.bottom + 6,
      bottom: window.innerHeight - rect.top + 6,
      width,
      upward,
    })
  }
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const closeOnScroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    window.addEventListener('resize', closeOnScroll)
    window.addEventListener('scroll', closeOnScroll, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', key)
      window.removeEventListener('resize', closeOnScroll)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [open])
  const current = options.find((option) => option.value === value)
  const emptyText = placeholder || (options.length === 0 ? '暂无可用选项' : '请选择')
  return (
    <div className={`dropdown ${className || ''}`} ref={root}>
      <button type="button" className="dropdown-trigger" disabled={disabled} onClick={() => { if (!open) positionMenu(); setOpen((state) => !state) }} aria-haspopup="listbox" aria-expanded={open && !disabled} aria-label={title || current?.label || emptyText} title={title}>
        {leadingIcon && <span className="dropdown-leading-icon">{leadingIcon}</span>}
        <span>{current?.label || emptyText}</span>
        <ChevronDown size={13} className={`chev ${open ? 'open' : ''}`} />
      </button>
      {open && !disabled && createPortal(
        <div ref={menu} className="dropdown-menu dropdown-menu-portal" style={{ left: menuPosition.left, top: menuPosition.upward ? 'auto' : menuPosition.top, bottom: menuPosition.upward ? menuPosition.bottom : 'auto', minWidth: menuPosition.width }} role="listbox">
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
        </div>, portal || document.body
      )}
    </div>
  )
}

export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <label className="switch-row">
      {label && <span>{label}</span>}
      <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
        <span className="knob" />
      </button>
    </label>
  )
}
