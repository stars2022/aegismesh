import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowLeft, ArrowRight, Check, ChevronRight, Gauge, Monitor, Network, ShieldCheck, UserRound } from 'lucide-react'
import { ProviderMark } from './ProviderMark'
import { quotaModeLabel, quotaPercent, quotaSize, roleLabels, type QuotaSummary } from './accountPresentation'
import { Turnstile } from './Turnstile'

export type AccountConfig = {
  enabled: boolean; email_enabled: boolean; email_registration_ready: boolean; quota_mode: string
  providers: { id: string; label: string; available: boolean; reason: string }[]
  turnstile?: { enabled: boolean; site_key: string; ready: boolean }
}
export type AccountMe = {
  owner_id: string; account: { id: string; display_name: string; email: string | null; role?: string } | null
  identities: { id: string; provider: string }[]
  quota: QuotaSummary
}

export async function accountRequest<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '请求未完成，请重试')
  return data
}

const request = accountRequest

export function useAccountFeatures() {
  const [config, setConfig] = useState<AccountConfig | null>(null)
  useEffect(() => {
    let live = true
    const refresh = () => { void request<AccountConfig>('/api/account/config').then(value => { if (live) setConfig(value) }).catch(() => undefined) }
    refresh(); window.addEventListener('focus', refresh)
    return () => { live = false; window.removeEventListener('focus', refresh) }
  }, [])
  return config
}

export function AccountPanel({ standalone = false, showQuota = true, embedded = false, managementOnly = false }: { standalone?: boolean; showQuota?: boolean; embedded?: boolean; managementOnly?: boolean }) {
  const [config, setConfig] = useState<AccountConfig | null>(null)
  const [me, setMe] = useState<AccountMe | null>(null)
  const [sessions, setSessions] = useState<{ id: string; current: boolean; created_at: string }[]>([])
  const action = new URLSearchParams(window.location.search).get('account_action')
  const [mode, setMode] = useState(action === 'register' ? 'verify' : action === 'reset' ? 'reset' : 'login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState(() => standalone ? new URLSearchParams(window.location.hash.slice(1)).get('token') || '' : '')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState('')
  const [verificationReset, setVerificationReset] = useState(0)
  const verificationAction = ({ login: 'login', register: 'signup', forgot: 'reset' } as Record<string, string>)[mode]
  const needsVerification = !!config?.turnstile?.enabled && !!verificationAction
  useEffect(() => {
    if (standalone && window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search)
    let live = true
    request<AccountConfig>('/api/account/config').then(async cfg => {
      if (!live) return
      setConfig(cfg)
      if (cfg.enabled) {
        const mine = await request<AccountMe>('/api/account/me')
        if (live) setMe(mine)
        if (mine.account) {
          const rows = await request<typeof sessions>('/api/account/sessions')
          if (live) setSessions(rows)
        }
      }
    }).catch(e => { if (live) setError(e.message) })
    return () => { live = false }
  }, [standalone])
  const returnToSettings = standalone && !embedded && !managementOnly && !!me?.account && !['verify', 'reset'].includes(mode)
  useEffect(() => {
    if (returnToSettings) window.location.replace('/?settings=account')
  }, [returnToSettings])
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : '请求失败') }
    finally { setBusy(false) }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      const paths: Record<string, string> = { login: 'login', register: 'register', verify: 'verify-email', forgot: 'password/request-reset', reset: 'password/reset' }
      const body = mode === 'verify' ? { token } : mode === 'reset' ? { token, password } : mode === 'forgot' ? { email } : { email, password }
      let result: { message?: string }
      try {
        result = await request<{ message?: string }>('/api/account/' + paths[mode], { ...body, ...(needsVerification ? { turnstile_token: turnstileToken } : {}) })
      } finally {
        setTurnstileToken(''); setVerificationReset(value => value + 1)
      }
      setPassword('')
      if (mode === 'login' || mode === 'verify') { window.location.assign('/'); return }
      setNotice(result.message || '已完成')
      if (mode === 'register') setMode('verify')
      if (mode === 'reset') { setToken(''); setMode('login') }
    })
  }
  if (!config?.enabled && !standalone) return null
  if (!config) return <section className="account-section account-placeholder"><p>{error || '正在读取账号状态…'}</p>{error && <a href="/">返回工作台</a>}</section>
  if (!config.enabled) return <section className="account-section"><h2>账号系统未启用</h2><a className="account-text-link" href="/">返回工作台 <ArrowRight size={15}/></a></section>
  if (returnToSettings) return <section className="account-section"><p role="status">正在打开设置…</p></section>
  if (managementOnly && !me) return <section className="account-section"><p>{error || '正在读取账号…'}</p></section>
  if (managementOnly && !me?.account) return <section className="account-section"><h2>账号管理</h2><a className="primary-button" href="/login">前往登录 <ArrowRight size={16}/></a></section>
  return <section className="settings-section account-section" aria-label="账号与配额">
    <div className="account-intro"><span className="account-page-icon"><UserRound size={22}/></span><h2>{me?.account ? '账号管理' : ({login: '登录 AegisMesh', register: '注册账号', forgot: '找回密码', reset: '重置密码', verify: '验证邮箱'} as Record<string,string>)[mode]}</h2></div>
    {me?.account && !['verify', 'reset'].includes(mode) ? <>
      <div className="account-identity"><span className="account-avatar">{me.account.display_name.slice(0,1)}</span><div><strong>{me.account.display_name}</strong>{me.account.email && <small>{me.account.email}</small>}<small>{roleLabels[me.account.role || 'member']}</small></div><Check size={17}/></div>
      <div className="account-actions"><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { await request('/api/account/logout', {}); window.location.assign('/') })}>退出登录</button>
        <button className="secondary-button" disabled={busy} onClick={() => void run(async () => { await request('/api/account/logout?all_sessions=true', {}); window.location.assign('/') })}>退出全部设备</button></div>
      <details className="account-detail"><summary><Monitor size={17}/>登录设备 <small>{sessions.length}</small><ChevronRight size={15}/></summary>{sessions.map(s => <div className="account-session-row" key={s.id}><span>{s.current ? '当前浏览器' : '其他登录'}<small>{new Date(s.created_at).toLocaleDateString()}</small></span><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { await request('/api/account/sessions/' + s.id, undefined, 'DELETE'); if (s.current) window.location.assign('/'); else setSessions(v => v.filter(r => r.id !== s.id)) })}>退出</button></div>)}</details>
      {config.providers.some(p => p.available || me.identities.some(i => i.provider === p.id)) && <details className="account-detail"><summary><ShieldCheck size={17}/>绑定登录方式<ChevronRight size={15}/></summary><div className="account-provider-list">{config.providers.filter(p => p.available || me.identities.some(i => i.provider === p.id)).map(p => {
        const linked = me.identities.find(i => i.provider === p.id)
        return <button className="account-provider-button" key={p.id} disabled={busy || (!linked && !p.available)} title={linked ? `解绑 ${p.label}` : p.reason} onClick={() => void run(async () => {
          if (linked) { await request('/api/account/identities/' + linked.id, undefined, 'DELETE'); setMe(await request<AccountMe>('/api/account/me')) }
          else { const { url } = await request<{ url: string }>(`/api/account/oauth/${p.id}/start?link=true`, {}); window.location.assign(url) }
        })}><ProviderMark provider={p.id}/><span>{linked ? '解绑' : '绑定'} {p.label}</span>{!linked && !p.available ? <small>未接入</small> : <ChevronRight size={15}/>}</button>
      })}</div></details>}
    </> : <>
      {config.providers.some(p => p.available) && <div className="account-provider-list">{config.providers.filter(p => p.available).map(p => <button key={p.id} className="account-provider-button" disabled={busy} title={p.reason || `使用 ${p.label} 登录`} onClick={() => void run(async () => { const { url } = await request<{ url: string }>(`/api/account/oauth/${p.id}/start`, {}); window.location.assign(url) })}><ProviderMark provider={p.id}/><span>使用 {p.label} 账号继续</span></button>)}</div>}
      {config.email_enabled && config.providers.some(p => p.available) && <div className="account-divider"><span>或使用邮箱</span></div>}
      {config.email_enabled && <form onSubmit={submit}>
        {['login', 'register', 'forgot'].includes(mode) && <label>邮箱<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required maxLength={254} /></label>}
        {['login', 'register', 'reset'].includes(mode) && <label>{mode === 'reset' ? '新密码' : '密码'}<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} minLength={8} maxLength={256} required /></label>}
        {['verify', 'reset'].includes(mode) && <label>邮件中的验证令牌<input value={token} onChange={e => setToken(e.target.value)} autoComplete="off" maxLength={128} required /></label>}
        {needsVerification && config.turnstile?.ready && <Turnstile siteKey={config.turnstile.site_key} action={verificationAction} resetCount={verificationReset} onToken={setTurnstileToken}/>}
        {needsVerification && !config.turnstile?.ready && <p role="alert">人机验证尚未配置完成，请稍后重试。</p>}
        <div className="account-actions"><button className="primary-button" disabled={busy || (needsVerification && !turnstileToken) || (['register', 'forgot'].includes(mode) && !config.email_registration_ready)}>{busy ? '处理中…' : ({login: '登录', register: '注册', verify: '验证邮箱', forgot: '发送重置邮件', reset: '重置密码'} as Record<string,string>)[mode]}</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setPassword(''); setError('') }}>{mode === 'login' ? '注册邮箱账号' : '返回登录'}</button>
          {mode === 'login' && <button type="button" className="secondary-button" disabled={busy} onClick={() => setMode('forgot')}>忘记密码</button>}</div>
        {!config.email_registration_ready && <p className="settings-note">邮件通道尚未接入，暂不能注册或重置密码。</p>}
      </form>}
      <a className="account-text-link" href="/">先以访客身份体验 <ArrowRight size={15}/></a>
    </>}
    {me && showQuota && config.quota_mode !== 'off' && <a href="/?settings=quota" className="account-quota-link"><Gauge size={18}/><span>用量与配额<small>{quotaModeLabel[me.quota.mode]}</small></span><ChevronRight size={16}/></a>}
    {notice && <p role="status">{notice}</p>}{error && <p className="login-error" role="alert">{error}</p>}
    {standalone && !embedded && me?.account && <a href="/">返回工作台</a>}
  </section>
}

export function QuotaPanel() {
  const [data, setData] = useState<AccountMe | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { let live = true; request<AccountMe>('/api/account/me').then(value => { if (live) setData(value) }).catch(e => { if (live) setError(e.message) }); return () => { live = false } }, [])
  const quota = data?.quota
  return <section className="account-section quota-page-panel" aria-label="用量与配额"><div className="account-intro"><span className="account-page-icon"><Gauge size={22}/></span><h2>用量与配额</h2></div>
    {error && <p className="login-error" role="alert">{error}</p>}
    {!quota ? <p>{error ? '暂时无法获取用量。' : '正在读取用量…'}</p> : <>
      <div className="quota-mode-banner"><span className="quota-status-dot"/><strong>{quota.exempt ? '不限额' : quotaModeLabel[quota.mode]}</strong><span>{roleLabels[quota.role || (data?.account ? 'member' : 'guest')]}</span></div>
      <div className="quota-metrics">{(['tasks','concurrency','upload_bytes'] as const).map(key => {
        const metric = quota[key]
        const labels = { tasks: [quota.task_period === 'lifetime' ? '访客体验' : '今日对话', '完成的对话轮次'], concurrency: ['同时进行', '正在处理的任务'], upload_bytes: ['今日上传', '成功上传的文件大小'] }
        const used = key === 'concurrency' ? metric.reserved : metric.used
        const format = (value: number) => key === 'upload_bytes' ? quotaSize(value) : String(value)
        const mode = quota.exempt ? 'observe' : quota.mode
        return <div className="quota-metric" key={key}><div><strong>{labels[key][0]}</strong><span>{quota.mode === 'off' ? '—' : format(used)}{mode === 'enforce' && <small> / {format(metric.limit)}</small>}</span></div><div className="quota-meter" role={mode === 'enforce' ? 'progressbar' : undefined} aria-label={labels[key][0]} aria-valuenow={quotaPercent(metric, mode)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${quotaPercent(metric, mode)}%` }}/></div><p>{quota.mode === 'off' ? '当前不计量、不拦截' : labels[key][1]}{quota.mode !== 'off' && key === 'tasks' && metric.reserved > 0 ? ` · ${metric.reserved} 项处理中` : ''}</p></div>
      })}</div>
      {quota.mode !== 'off' && quota.model_budget && <div className="quota-model-budget"><h3>模型额度</h3>{Object.entries(quota.model_budget.windows).map(([key, value]) => <div className="account-session-row" key={key}><span>{{five_hours: '最近 5 小时', week: '最近 7 天', month: '最近 30 天'}[key] || key}</span><strong>{value.used.toLocaleString()}<small>{!quota.exempt && ` / ${value.limit.toLocaleString()}`} 点</small></strong></div>)}{quota.model_budget.providers.length > 0 && <details className="account-detail"><summary>按供应商查看<ChevronRight size={15}/></summary>{quota.model_budget.providers.map(p => <div className="account-session-row" key={p.id}><span>{p.name}</span><strong>{p.used.toLocaleString()}<small>{!quota.exempt && ` / ${p.limit.toLocaleString()}`} 点</small></strong></div>)}</details>}<p className="settings-note">{quota.model_budget.unit}。滚动窗口，本地估算不等于供应商账单。未返回完整用量时保留预估消耗。</p></div>}
      <div className="quota-explanation"><ShieldCheck size={18}/><div><p>{quota.mode === 'off' ? '配额系统已关闭。' : quota.exempt ? '不受本站用户额度限制，仍受供应商服务上限约束。' : quota.note}{quota.task_period === 'lifetime' && quota.mode !== 'off' && <><br/><a href="/login">登录后获得账号额度</a></>}</p></div></div>
    </>}
  </section>
}

export function LoginPage() {
  return <main className="account-center account-login-page"><header className="account-center-header"><a className="account-center-brand" href="/"><Network size={20}/><strong>AegisMesh</strong></a><a className="account-back" href="/"><ArrowLeft size={16}/>返回工作台</a></header><div className="account-center-content"><AccountPanel standalone showQuota={false}/></div></main>
}
