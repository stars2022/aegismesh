import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Database, Gauge, Info, Monitor, Moon, Network, Settings2, Sun, UserRound, X } from 'lucide-react'
import { AccountPanel, QuotaPanel, useAccountFeatures } from './AccountPanel'
import { Dropdown, DropdownPortalContext, Switch } from './components'
import { COMPRESSION_STRATEGIES, CONTEXT_WINDOWS, type CompressionStrategy, type UserSettings } from './settings'
import './SettingsDialog.css'
import type { SettingsSection } from './accountNavigation'

export type { SettingsSection } from './accountNavigation'
const sections = [
  { id: 'general', label: '通用设置', icon: Settings2 },
  { id: 'account', label: '账号管理', icon: UserRound },
  { id: 'quota', label: '用量与配额', icon: Gauge },
  { id: 'data', label: '数据管理', icon: Database },
  { id: 'about', label: '关于', icon: Info },
] as const
const themes = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '跟随系统', icon: Monitor },
] as const

export function SettingsDialog({ settings, onChange, onClose, onClear, initialSection = 'general' }: {
  settings: UserSettings; onChange: (patch: Partial<UserSettings>) => void
  onClose: () => void; onClear: () => void; initialSection?: SettingsSection
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const features = useAccountFeatures()
  const visibleSections = sections.filter(item => item.id === 'account' ? features?.enabled : item.id === 'quota' ? features && features.quota_mode !== 'off' : true)
  const activeSection = visibleSections.some(item => item.id === section) ? section : 'general'
  const [closing, setClosing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [portal, setPortal] = useState<HTMLDivElement | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const id = useId()
  const dismiss = () => setClosing(true)

  useEffect(() => {
    if (!closing) return
    const delay = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150
    const timer = window.setTimeout(() => closeRef.current(), delay)
    return () => window.clearTimeout(timer)
  }, [closing])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overlay = dialog.current
    const siblings = Array.from(document.body.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node !== overlay)
    const inertStates = siblings.map(node => [node, node.inert] as const)
    for (const [node] of inertStates) node.inert = true
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus({ preventScroll: true })
    const keydown = (event: KeyboardEvent) => {
      // A select's first Escape dismisses its menu, not the whole settings dialog.
      if (event.key === 'Escape' && !dialog.current?.querySelector('[role="listbox"]')) {
        event.preventDefault(); event.stopPropagation(); setClosing(true)
      }
      if (event.key !== 'Tab') return
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') || [])
        .filter(node => node.getClientRects().length && !node.closest('[hidden], [inert]'))
      const first = controls[0], last = controls[controls.length - 1]
      if (!first) { event.preventDefault(); dialog.current?.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    // Capture before dropdowns' document listeners so Escape is predictable.
    document.addEventListener('keydown', keydown, true)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      document.body.style.overflow = overflow
      for (const [node, inert] of inertStates) node.inert = inert
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
      else document.querySelector<HTMLButtonElement>('.chat-side-toggle[data-side="left"], .mobile-header-btn')?.focus({ preventScroll: true })
    }
  }, [])

  const changeSection = (next: SettingsSection) => { setSection(next); setConfirmClear(false) }
  return createPortal(<div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} className={`settings-overlay${closing ? ' is-closing' : ''}`} onClick={event => { if (event.target === event.currentTarget) dismiss() }}>
    <section className="settings-dialog">
      <header className="settings-dialog-header"><h2 id={`${id}-title`}>设置</h2><button ref={closeButton} className="icon-button" type="button" aria-label="关闭设置" onClick={dismiss}><X size={20}/></button></header>
      <div className="settings-dialog-layout">
        <nav className="settings-dialog-nav" aria-label="设置分类">{visibleSections.map(({ id: key, label, icon: Icon }) => <button key={key} type="button" aria-current={activeSection === key ? 'page' : undefined} aria-controls={`${id}-content`} onClick={() => changeSection(key)}><Icon size={19}/><span>{label}</span></button>)}</nav>
        <DropdownPortalContext.Provider value={portal}>
          <div className="settings-dialog-content" id={`${id}-content`} key={activeSection}>
            {activeSection === 'general' && <>
              <section className="settings-dialog-section"><h3>主题</h3><div className="settings-theme-options" role="group" aria-label="主题">{themes.map(({ id: theme, label, icon: Icon }) => <button key={theme} type="button" aria-pressed={settings.theme === theme} onClick={() => onChange({ theme })}><Icon size={23}/><span>{label}</span>{settings.theme === theme && <Check className="settings-theme-check" size={14}/>}</button>)}</div></section>
              <section className="settings-dialog-section"><h3>上下文</h3>
                <div className="settings-dialog-row"><span>上下文窗口</span><Dropdown title="上下文窗口" value={String(settings.contextWindow)} onChange={value => onChange({ contextWindow: Number(value) })} options={CONTEXT_WINDOWS}/></div>
                <div className="settings-dialog-row"><span>压缩阈值</span><Dropdown title="压缩阈值" value={settings.compressionStrategy || 'auto'} onChange={value => onChange({ compressionStrategy: value as CompressionStrategy, autoCompress: value !== 'off' })} options={COMPRESSION_STRATEGIES}/></div>
                <div className="settings-dialog-row"><span>保留最近轮次</span><Dropdown title="保留最近轮次" value={String(settings.keepRecentTurns ?? 4)} onChange={value => onChange({ keepRecentTurns: Number(value) })} options={[{ value: '0', label: '不限制' }, { value: '2', label: '2 轮' }, { value: '4', label: '4 轮' }, { value: '8', label: '8 轮' }]}/></div>
                <div className="settings-dialog-row settings-switch-row"><Switch label="显示上下文圆环指示器" checked={settings.showContextMeter} onChange={showContextMeter => onChange({ showContextMeter })}/></div>
              </section>
            </>}
            {activeSection === 'account' && <AccountPanel standalone showQuota={false} embedded managementOnly/>}
            {activeSection === 'quota' && <QuotaPanel/>}
            {activeSection === 'data' && <section className="settings-dialog-section"><h3>本地会话记录</h3><p className="settings-dialog-note">仅清空此浏览器中当前身份的会话记录，不会删除服务器上的任务和审计记录。</p>{confirmClear ? <div className="settings-clear-confirm" role="alert"><p>清空后无法在此浏览器恢复，确定继续？</p><div><button type="button" className="secondary-button" onClick={() => setConfirmClear(false)}>取消</button><button type="button" className="secondary-button danger" onClick={onClear}>确认清空</button></div></div> : <button type="button" className="secondary-button danger" onClick={() => setConfirmClear(true)}>清空本地会话记录</button>}</section>}
            {activeSection === 'about' && <section className="settings-dialog-section settings-about"><Network size={30}/><h3>AegisMesh</h3><p className="settings-dialog-note">请勿提交密码、密钥或其他敏感资料。AI 生成内容可能有误，重要结论请核实。</p></section>}
          </div>
        </DropdownPortalContext.Provider>
      </div>
    </section>
    <div ref={setPortal} className="settings-dialog-menus"/>
  </div>, document.body)
}
