import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, CirclePlus, Pencil, Sparkles } from 'lucide-react'
import './AgentDesigner.css'

export type CreationMode = 'manual' | 'ai'
export type CreationRequest = { mode: CreationMode; sequence: number }

export function NewAgentMenu({ onCreate, variant = 'toolbar', compact = false }: {
  onCreate: (mode: CreationMode) => void
  variant?: 'sidebar' | 'toolbar'
  compact?: boolean
}) {
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = (focus = false) => { setPosition(null); if (focus) trigger.current?.focus() }
  const open = () => {
    const rect = root.current!.getBoundingClientRect()
    const width = Math.max(180, Math.min(230, rect.width))
    setPosition({ width, left: Math.max(8, Math.min(window.innerWidth - width - 8,
      variant === 'sidebar' ? rect.left : rect.right - width)),
      top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 112)) })
  }
  useEffect(() => {
    if (!position) return
    menu.current?.querySelector('button')?.focus()
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close()
    }
    const dismiss = () => close()
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [position])
  const choose = (mode: CreationMode) => { close(); trigger.current?.focus(); onCreate(mode) }
  return <div ref={root} className={`agent-create-control agent-create-control--${variant}`} data-compact={compact}>
    {!compact && <button type="button" className="agent-create-main" title="手动创建智能体" onClick={() => choose('manual')}>
      <CirclePlus size={16}/><span className="agent-create-label">新建智能体</span>
    </button>}
    <button ref={trigger} type="button" className="agent-create-trigger" aria-label={compact ? '新建智能体' : '选择智能体创建方式'}
      title={compact ? '新建智能体' : '选择智能体创建方式'}
      aria-haspopup="menu" aria-expanded={Boolean(position)} aria-controls={position ? id : undefined}
      onClick={() => position ? close() : open()}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); open() } }}>
      {compact ? <CirclePlus size={18}/> : <ChevronDown size={15}/>}
    </button>
    {position && createPortal(<div ref={menu} id={id} role="menu" aria-label="智能体创建方式"
      className="agent-create-menu" style={position} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); close(true) }
        if (event.key === 'Tab') close()
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const items = Array.from(menu.current!.querySelectorAll('button'))
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
          items[next]?.focus()
        }
      }}>
      <button type="button" role="menuitem" onClick={() => choose('manual')}><Pencil size={16}/>手动创建</button>
      <button type="button" role="menuitem" onClick={() => choose('ai')}><Sparkles size={16}/>AI 生成</button>
    </div>, document.body)}
  </div>
}
