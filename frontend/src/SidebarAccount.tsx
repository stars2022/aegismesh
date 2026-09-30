import { useEffect, useId, useRef, useState } from 'react'
import { ChevronUp, LogOut, Settings2, UserRound } from 'lucide-react'
import { accountRequest, type AccountConfig, type AccountMe } from './AccountPanel'
import type { SettingsSection } from './SettingsDialog'
import './SidebarAccount.css'

export function SidebarAccount({ onSettings }: { onSettings: (section: SettingsSection) => void }) {
  const [config, setConfig] = useState<AccountConfig | null>(null)
  const [me, setMe] = useState<AccountMe | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    let live = true
    accountRequest<AccountConfig>('/api/account/config').then(async value => {
      if (!live) return
      setConfig(value)
      if (value.enabled) {
        const mine = await accountRequest<AccountMe>('/api/account/me')
        if (live) setMe(mine)
      }
    }).catch(() => { /* Settings remain available even when account APIs are offline. */ })
    return () => { live = false }
  }, [])
  useEffect(() => {
    if (!open) return
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus() }
      if (event.key === 'Tab') setOpen(false)
    }
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key) }
  }, [open])
  const choose = (section: SettingsSection) => {
    trigger.current?.focus({ preventScroll: true }); setOpen(false); onSettings(section)
  }
  const account = me?.account
  return <div className="sidebar-account" ref={root}>
    {open && <div ref={menu} id={id} className="sidebar-account-menu" role="menu" aria-label="账号菜单" onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      items[next]?.focus()
    }}>
      <button role="menuitem" onClick={() => choose('general')}><Settings2 size={17}/><span>设置</span></button>
      {account && <button role="menuitem" disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try { await accountRequest('/api/account/logout', {}); window.location.assign('/') }
        catch { setError('退出失败，请重试'); setBusy(false) }
      }}><LogOut size={17}/><span>{busy ? '正在退出…' : '退出登录'}</span></button>}
      {error && <p role="alert">{error}</p>}
    </div>}
    <button ref={trigger} className="sidebar-account-trigger" type="button"
      aria-haspopup={account ? 'menu' : undefined} aria-expanded={account ? open : undefined} aria-controls={account && open ? id : undefined}
      onClick={() => { if (account) setOpen(value => !value); else if (config?.enabled) window.location.assign('/login'); else onSettings('general') }}
      onKeyDown={event => { if (account && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setOpen(true); requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()) } }}>
      {account ? <span className="sidebar-account-avatar" aria-hidden="true">{Array.from(account.display_name.trim() || '用户')[0]}</span> : config?.enabled ? <UserRound size={19}/> : <Settings2 size={19}/>}
      <span className="sidebar-account-name">{account?.display_name || (config?.enabled ? '登录账号' : '设置')}</span>
      {account ? <ChevronUp size={15} className={open ? 'is-open' : ''}/> : config?.enabled && <span className="sidebar-account-guest">访客</span>}
    </button>
    {config?.enabled && !account && <button className="sidebar-guest-settings" type="button" aria-label="设置" title="设置" onClick={() => onSettings('general')}><Settings2 size={17}/></button>}
  </div>
}
