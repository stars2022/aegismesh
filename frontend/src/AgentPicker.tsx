import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Bot, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { agentChoiceLabel, agentMenuLevels, type AgentChoice } from './agentMenu'

export function AgentPicker({ agents, value, onChange, className = '' }: {
  agents: readonly AgentChoice[]; value: string; onChange: (id: string) => void; className?: string
}) {
  const [open, setOpen] = useState(false)
  const [executors, setExecutors] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, bottom: 0, width: 0, height: 360, upward: false })
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const levels = agentMenuLevels(agents)
  const current = agents.find((agent) => agent.id === value)
  const label = current ? agentChoiceLabel(current) : agents.length ? '请选择智能体' : '暂无可用智能体'
  const close = (restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }
  const toggle = () => {
    if (open) { close(); return }
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(Math.max(rect.width, 300), window.innerWidth - 16)
    const above = rect.top - 14
    const below = window.innerHeight - rect.bottom - 14
    const upward = below < 300 && above > below
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: rect.bottom + 6, bottom: window.innerHeight - rect.top + 6, width,
      height: Math.max(80, Math.min(360, upward ? above : below)), upward })
    setExecutors(false)
    setOpen(true)
  }
  useLayoutEffect(() => {
    if (!open) return
    const target = menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?? menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
      ?? menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest' })
  }, [open, executors])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    const dismiss = () => setOpen(false)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', outside, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', outside, true)
    }
  }, [open])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault(); event.stopPropagation()
      if (executors) setExecutors(false)
      else if (event.key === 'Escape') close()
      return
    }
    if (event.key === 'Tab') { setOpen(false); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus({ preventScroll: true })
    buttons[next]?.scrollIntoView({ block: 'nearest' })
  }
  const options = executors ? levels.executors : levels.coordinators
  return <div className={`dropdown agent-picker ${className}`}>
    <button ref={trigger} type="button" className="dropdown-trigger" title={label}
      aria-label={`选择智能体：${label}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={toggle} onKeyDown={(event) => { if (!open && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); toggle() } }}>
      <span className="dropdown-leading-icon"><Bot size={15} /></span><span className="agent-picker-label">{label}</span>
      <ChevronDown size={13} className={`chev ${open ? 'open' : ''}`} />
    </button>
    {open && createPortal(<div id={menuId} ref={menu} role="menu" aria-label={executors ? '执行型智能体' : '选择智能体'}
      className="dropdown-menu dropdown-menu-portal agent-picker-menu" onKeyDown={onKeyDown}
      style={{ left: position.left, top: position.upward ? 'auto' : position.top,
        bottom: position.upward ? position.bottom : 'auto', width: position.width, maxHeight: position.height }}>
      {executors && <button type="button" role="menuitem" className="agent-picker-back" onClick={() => setExecutors(false)}><ArrowLeft size={15} /><span>执行型智能体</span></button>}
      {options.map((agent) => <button type="button" key={agent.id} role="menuitemradio" aria-checked={agent.id === value}
        title={agent.name} className={agent.id === value ? 'active' : ''}
        onClick={() => { onChange(agent.id); close() }}><span>{agent.name}</span>{agent.id === value && <Check size={14} />}</button>)}
      {!executors && levels.executors.length > 0 && <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={false}
        className="agent-picker-next" onClick={() => setExecutors(true)}
        onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); setExecutors(true) } }}>
        <span>执行型智能体</span><ChevronRight size={15} />
      </button>}
      {agents.length === 0 && <div className="dropdown-empty">暂无可用智能体</div>}
    </div>, document.body)}
  </div>
}
