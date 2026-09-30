import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { accountRequest } from './AccountPanel'
import { Dropdown, Switch } from './components'
import { quotaModeLabel, quotaSize, roleLabels } from './accountPresentation'
import { directoryQuery, policyChanges, roleDefaults, userChanges, withOptionalLimit, withProviderLimit } from './accountAdminModel'
import type { AccountDetail, AccountPolicy, AccountRow, Administration, Page, Provider, RoleLimits, Usage, UserLimits } from './accountAdminModel'
import './AccountAdministration.css'

const roleOptions = ['member', 'trusted', 'admin'].map(value => ({ value, label: roleLabels[value] }))
const allRoles = ['guest', 'member', 'trusted', 'admin', 'service'].map(value => ({ value, label: roleLabels[value] }))
const date = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
const problem = (error: unknown) => error instanceof Error ? error.message : '请求未完成'
const providerOptions = (providers: Provider[]) => [{ value: 'default', label: '默认模型通道' }, ...providers.map(p => ({ value: p.id, label: p.name + (p.active ? '' : ' · 已停用') }))]

function Tabs({ value, items, onChange }: { value: string; items: [string, string][]; onChange: (value: string) => void }) {
  return <nav className="admin-tabs" aria-label="管理分类">{items.map(([key, name]) => <button key={key} type="button" aria-current={value === key ? 'page' : undefined} className={value === key ? 'active' : ''} onClick={() => onChange(key)}>{name}</button>)}</nav>
}

function Pagination({ total, page, size = 20, busy, onChange }: { total: number; page: number; size?: number; busy: boolean; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size))
  return <footer className="admin-pagination"><span>共 {total} 条</span><div><button className="icon-button" type="button" aria-label="上一页" disabled={busy || page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={17}/></button><span>{page} / {pages}</span><button className="icon-button" type="button" aria-label="下一页" disabled={busy || page >= pages} onClick={() => onChange(page + 1)}><ChevronRight size={17}/></button></div></footer>
}

function NumberField({ label, value, onChange, min = 0, max = 1000000000, optional = false, step = 1, placeholder }: { label: string; value: number | undefined; onChange: (value: number | undefined) => void; min?: number; max?: number; optional?: boolean; step?: number; placeholder?: string }) {
  return <label className="admin-field"><span>{label}</span><input type="number" value={value ?? ''} min={min} max={max} step={step} required={!optional} placeholder={placeholder || (optional ? '继承角色额度' : '')} onChange={e => onChange(e.target.value === '' && optional ? undefined : e.target.valueAsNumber || 0)}/></label>
}

function Feedback({ error, notice }: { error: string; notice: string }) {
  return <>{error && <p className="admin-feedback error" role="alert">{error}</p>}{notice && <p className="admin-feedback success" role="status">{notice}</p>}</>
}

function SaveBar({ reason, onReason, busy, disabled, children }: { reason: string; onReason: (value: string) => void; busy: boolean; disabled?: boolean; children?: ReactNode }) {
  return <div className="admin-savebar"><label className="admin-field"><span>操作原因</span><input value={reason} maxLength={200} required placeholder="填写本次调整原因" onChange={e => onReason(e.target.value)}/></label>{children}<button className="primary-button" disabled={busy || disabled || !reason.trim()}>{busy ? '保存中…' : '保存修改'}</button></div>
}

function useAdministration(refreshKey: number) {
  const [data, setData] = useState<Administration | null>(null)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let live = true; setError('')
    accountRequest<Administration>('/api/admin/accounts').then(value => { if (live) setData(value) }).catch(e => { if (live) setError(problem(e)) })
    return () => { live = false }
  }, [refreshKey, version])
  return { data, error, refresh: () => setVersion(v => v + 1) }
}

export function AccountAdministration({ refreshKey = 0 }: { refreshKey?: number }) {
  const { data, error, refresh } = useAdministration(refreshKey)
  const [tab, setTab] = useState('users')
  const [selected, setSelected] = useState('')
  const [generation, setGeneration] = useState(0)
  return <div className="account-admin">
    <Tabs value={tab} items={[["users", "用户列表"], ["settings", "登录设置"]]} onChange={value => { setTab(value); setSelected('') }}/>
    <Feedback error={error} notice=""/>
    {!data ? <p className="admin-empty">{error ? <button className="secondary-button" onClick={refresh}>重试</button> : '正在读取账号…'}</p> : <>
      {tab === 'settings' ? <PolicyEditor data={data} section="accounts" onSaved={refresh}/> : <>
        <div hidden={!!selected}>
          <div className="admin-counts">{([['total', '全部用户'], ['active', '启用'], ['disabled', '已停用']] as const).map(([key, label]) => <div key={key}><span>{label}</span><strong>{data.counts[key]}</strong></div>)}</div>
          <UserDirectory refreshKey={refreshKey + generation} onSelect={setSelected}/>
        </div>
        {selected && <UserDetail key={selected} id={selected} data={data} refreshKey={refreshKey} onBack={() => setSelected('')} onChanged={() => { setGeneration(v => v + 1); refresh() }}/>}
      </>}
    </>}
  </div>
}

function UserDirectory({ refreshKey, onSelect }: { refreshKey: number; onSelect: (id: string) => void }) {
  const [q, setQ] = useState(''); const [search, setSearch] = useState('')
  const [role, setRole] = useState('all'); const [status, setStatus] = useState('all'); const [page, setPage] = useState(1)
  const [result, setResult] = useState<Page<AccountRow> | null>(null)
  const [busy, setBusy] = useState(true); const [error, setError] = useState('')
  useEffect(() => {
    let live = true; setBusy(true); setError('')
    accountRequest<Page<AccountRow>>('/api/admin/accounts/users?' + directoryQuery({ q: search, role, status, page, page_size: 20 })).then(data => {
      if (!live) return
      if (page > 1 && !data.items.length) setPage(Math.max(1, Math.ceil(data.total / 20)))
      else setResult(data)
    }).catch(e => { if (live) setError(problem(e)) }).finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [search, role, status, page, refreshKey])
  return <section className="admin-surface">
    <form className="admin-filters" onSubmit={e => { e.preventDefault(); setSearch(q); setPage(1) }}><label className="admin-search"><Search size={17}/><input aria-label="搜索用户" placeholder="名称、邮箱或用户 ID" value={q} maxLength={128} onChange={e => setQ(e.target.value)}/></label><button className="secondary-button">搜索</button><Dropdown title="筛选角色" value={role} options={[{ value: 'all', label: '全部角色' }, {value: 'owner', label: roleLabels.owner}, ...roleOptions]} onChange={v => { setRole(v); setPage(1) }}/><Dropdown title="筛选状态" value={status} options={[{value:'all',label:'全部状态'}, {value:'active',label:'启用'}, {value:'disabled',label:'已停用'}]} onChange={v => { setStatus(v); setPage(1) }}/></form>
    <Feedback error={error} notice=""/>
    <div className="admin-table-wrap" aria-busy={busy}><table className="admin-table"><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>最近登录</th><th><span className="admin-visually-hidden">操作</span></th></tr></thead><tbody>{result?.items.map(row => <tr key={row.id}><td><strong>{row.display_name || '未命名用户'}</strong><small>{row.email || row.id}</small>{row.custom_quota && <span className="admin-badge">单独额度</span>}</td><td>{roleLabels[row.role]}</td><td><span className={'admin-badge ' + (row.active ? 'good' : '')}>{row.active ? '启用' : '已停用'}</span></td><td>{date(row.last_login_at)}</td><td><button className="secondary-button" onClick={() => onSelect(row.id)}>管理<span className="admin-visually-hidden"> {row.display_name}</span></button></td></tr>)}</tbody></table></div>
    {!result?.items.length && <p className="admin-empty">{busy ? '正在读取用户…' : error ? '用户列表暂不可用' : '没有符合条件的用户'}</p>}
    <Pagination total={result?.total || 0} page={page} busy={busy} onChange={setPage}/>
  </section>
}

function UserDetail({ id, data, refreshKey, onBack, onChanged }: { id: string; data: Administration; refreshKey: number; onBack: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<AccountDetail | null>(null)
  const [draft, setDraft] = useState<AccountRow | null>(null); const [limits, setLimits] = useState<UserLimits>({})
  const [tab, setTab] = useState('profile'); const [reason, setReason] = useState('')
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0); const [revoke, setRevoke] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    accountRequest<AccountDetail>('/api/admin/accounts/users/' + encodeURIComponent(id)).then(value => { if (live) { setDetail(value); setDraft(value.account); setLimits(value.limits); setReason(''); setRevoke(null) } }).catch(e => { if (live) setError(problem(e)) })
    return () => { live = false }
  }, [id, refreshKey, reload])
  const refresh = () => { setError(''); setReload(v => v + 1) }
  const mutate = async (path: string, body: unknown, method: string) => {
    setBusy(true); setError(''); setNotice('')
    try { await accountRequest(path, body, method); setNotice('已保存并记录审计'); refresh(); onChanged() }
    catch (e) { setError(problem(e)) } finally { setBusy(false) }
  }
  const save = (event: FormEvent) => {
    event.preventDefault()
    if (!detail || !draft || !reason.trim()) return
    void mutate('/api/admin/accounts/users/' + encodeURIComponent(id), { ...userChanges(detail, draft, limits), revision: detail.revision, reason }, 'PATCH')
  }
  const protectedOwner = draft?.role === 'owner'
  const dirty = !!detail && !!draft && Object.keys(userChanges(detail, draft, limits)).length > 0
  return <section className="admin-surface admin-user-detail">
    <header className="admin-detail-heading"><button className="secondary-button" onClick={onBack}><ArrowLeft size={16}/>用户列表</button><button className="icon-button" aria-label="刷新用户详情并放弃未保存修改" disabled={busy} onClick={refresh}><RefreshCw size={17}/></button></header>
    <Feedback error={error} notice={notice}/>
    {!detail || !draft ? <p className="admin-empty">正在读取用户详情…</p> : <>
      <div className="admin-user-heading"><span className="account-avatar">{draft.display_name.slice(0,1) || 'U'}</span><div><h2>{detail.account.display_name || '未命名用户'}</h2><p>{detail.account.email || id}</p></div><span className="admin-badge">{roleLabels[detail.account.role]}</span></div>
      <Tabs value={tab} items={[["profile", "基本信息"], ["quota", "单独额度"], ["sessions", "登录会话"], ["usage", "用量明细"], ["audit", "操作记录"]]} onChange={value => { setTab(value); setRevoke(null) }}/>
      {protectedOwner && <p className="admin-note"><ShieldCheck size={16}/>站点所有者受保护，不可在此停用、改角色或限制额度。</p>}
      {(tab === 'profile' || tab === 'quota') && <form onSubmit={save}>
        <fieldset className="admin-fieldset" disabled={busy || protectedOwner}>
          {tab === 'profile' ? <><div className="admin-form-grid"><label className="admin-field"><span>显示名称</span><input required maxLength={80} value={draft.display_name} onChange={e => setDraft({ ...draft, display_name: e.target.value })}/></label><label className="admin-field"><span>用户角色</span><Dropdown title="用户角色" value={draft.role} disabled={busy || protectedOwner} options={protectedOwner ? [{value:'owner',label:roleLabels.owner}] : roleOptions} onChange={role => setDraft({ ...draft, role })}/></label></div><Switch label="启用账号" checked={draft.active} disabled={busy || protectedOwner} onChange={active => setDraft({ ...draft, active })}/><p className="admin-note">角色控制本站额度；管理后台仍需独立管理员登录。改角色或停用后，该用户需重新登录。</p><dl className="admin-facts"><div><dt>用户 ID</dt><dd>{id}</dd></div><div><dt>注册时间</dt><dd>{date(detail.account.created_at)}</dd></div><div><dt>登录方式</dt><dd>{detail.login_methods.map(v => v === 'email' ? '邮箱' : v).join('、') || '—'}</dd></div></dl></> : <>
            {detail.quota.tasks && <div className="admin-effective"><strong>当前生效：{detail.quota.exempt ? '不限额' : quotaModeLabel[detail.quota.mode]}</strong><span>对话 {detail.quota.tasks.used} / {detail.quota.tasks.limit} 轮</span><span>并发 {detail.quota.concurrency.reserved} / {detail.quota.concurrency.limit}</span><span>上传 {quotaSize(detail.quota.upload_bytes.used)} / {quotaSize(detail.quota.upload_bytes.limit)}</span></div>}
            <div className="admin-section-heading"><h3>单用户覆盖</h3><button type="button" className="secondary-button" onClick={() => setLimits({})}>恢复角色额度</button></div><p className="admin-note">留空继承角色，0 表示禁止。恢复额度不会清除已有用量。</p>
            <div className="admin-form-grid"><NumberField label="每日对话轮数" optional value={limits.daily_tasks} max={10000} onChange={v => setLimits(withOptionalLimit(limits, 'daily_tasks', v))}/><NumberField label="同时运行任务" optional value={limits.concurrent_tasks} max={32} onChange={v => setLimits(withOptionalLimit(limits, 'concurrent_tasks', v))}/><NumberField label="每日上传（MiB）" optional step={1/1024} value={limits.daily_upload_bytes === undefined ? undefined : limits.daily_upload_bytes / 1048576} max={1024} onChange={v => setLimits(withOptionalLimit(limits, 'daily_upload_bytes', v === undefined ? undefined : Math.round(v * 1048576)))}/><NumberField label="30 天模型额度（点）" optional value={limits.monthly_units} onChange={v => setLimits(withOptionalLimit(limits, 'monthly_units', v))}/><label className="admin-field"><span>额度豁免</span><Dropdown title="额度豁免" disabled={busy || protectedOwner} value={limits.exempt === undefined ? 'inherit' : String(limits.exempt)} options={[{value:'inherit',label:'继承角色'}, {value:'true',label:'不限额'}, {value:'false',label:'执行额度限制'}]} onChange={v => setLimits(withOptionalLimit(limits, 'exempt', v === 'inherit' ? undefined : v === 'true'))}/></label></div>
            <h3>按供应商覆盖</h3><div className="admin-form-grid">{providerOptions(data.model_providers).map(p => <NumberField key={p.value} label={p.label + '（点 / 30 天）'} optional value={limits.provider_monthly_units?.[p.value]} onChange={v => setLimits(withProviderLimit(limits, p.value, v))}/>)}</div>
          </>}
        </fieldset>
        {!protectedOwner && <><SaveBar reason={reason} onReason={setReason} busy={busy} disabled={!dirty}/>{dirty && <p className="admin-note">基本信息和单独额度的未保存修改将一起提交。</p>}</>}
      </form>}
      {tab === 'sessions' && <><div className="admin-section-heading"><h3>有效登录（{detail.sessions.length}）</h3><button className="secondary-button" disabled={busy || protectedOwner || !detail.sessions.length} onClick={() => setRevoke('all')}>退出全部设备</button></div>{detail.sessions.map((s, index) => <div className="admin-session" key={s.id}><div><strong>登录会话 {index + 1}</strong><small>{date(s.created_at)} 登录 · {date(s.expires_at)} 到期</small></div><button className="secondary-button" disabled={busy || protectedOwner} onClick={() => setRevoke(s.id)}>退出</button></div>)}{!detail.sessions.length && <p className="admin-empty">暂无有效登录会话</p>}{revoke && <form className="admin-confirm" onSubmit={e => { e.preventDefault(); void mutate('/api/admin/accounts/users/' + encodeURIComponent(id) + '/sessions/revoke', { reason, ...(revoke === 'all' ? {} : { session_id: revoke }) }, 'POST') }}><strong>确认{revoke === 'all' ? '退出全部设备' : '退出这个登录会话'}？</strong><label className="admin-field"><span>操作原因</span><input required maxLength={200} value={reason} onChange={e => setReason(e.target.value)}/></label><div className="admin-actions"><button type="button" className="secondary-button" onClick={() => setRevoke(null)}>取消</button><button className="primary-button" disabled={busy || !reason.trim()}>确认退出</button></div></form>}</>}
      {tab === 'usage' && <UsageLedger providers={data.model_providers} owner={'account_' + id} refreshKey={refreshKey}/>}
      {tab === 'audit' && <>{!detail.audit.length && <p className="admin-empty">暂无管理操作记录</p>}{detail.audit.map(a => <details className="admin-audit" key={a.id}><summary><strong>{a.action}</strong><span>{date(a.created_at)}</span></summary><p>{a.actor} · {a.note}</p><pre>{JSON.stringify(a.changes, null, 2)}</pre></details>)}</>}
    </>}
  </section>
}

export function QuotaAdministration({ refreshKey = 0 }: { refreshKey?: number }) {
  const { data, error, refresh } = useAdministration(refreshKey)
  return <div className="account-admin"><Feedback error={error} notice=""/>{data ? <PolicyEditor data={data} section="quotas" refreshKey={refreshKey} onSaved={refresh}/> : <p className="admin-empty">{error ? <button className="secondary-button" onClick={refresh}>重试</button> : '正在读取配额…'}</p>}</div>
}

function PolicyEditor({ data, section, onSaved, refreshKey = 0 }: { data: Administration; section: 'accounts' | 'quotas'; onSaved: () => void; refreshKey?: number }) {
  const [policy, setPolicy] = useState<AccountPolicy>(data.policy)
  const [tab, setTab] = useState('global'); const [role, setRole] = useState('member'); const [provider, setProvider] = useState('default')
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { setPolicy(data.policy); setReason(''); setError('') }, [data])
  const patch = (values: Partial<AccountPolicy>) => setPolicy(p => ({ ...p, ...values }))
  const roleLimit = roleDefaults(policy, role)
  const providerLimit = policy.provider_budgets[provider] || { monthly_units: policy.public_monthly_units, output_tokens: policy.model_output_tokens, role_monthly_units: {} }
  const rolePatch = (values: Partial<RoleLimits>) => patch({ roles: { ...policy.roles, [role]: { ...roleLimit, ...values } } })
  const providerPatch = (values: Partial<typeof providerLimit>) => patch({ provider_budgets: { ...policy.provider_budgets, [provider]: { ...providerLimit, ...values } } })
  const dirty = JSON.stringify(policyChanges(policy, section)) !== JSON.stringify(policyChanges(data.policy, section))
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try { await accountRequest('/api/admin/accounts/policy', { section, changes: policyChanges(policy, section), revision: data.policy_revision, reason }, 'PATCH'); setNotice('已保存并记录审计'); onSaved() }
    catch(e) { setError(problem(e)) } finally { setBusy(false) }
  }
  return <>
    {section === 'quotas' && <Tabs value={tab} items={[["global", "全局额度"], ["roles", "角色额度"], ["providers", "供应商额度"], ["usage", "用量明细"]]} onChange={setTab}/>}
    {section === 'quotas' && tab === 'usage' ? <UsageLedger providers={data.model_providers} refreshKey={refreshKey}/> : <form className="admin-surface admin-policy" onSubmit={e => void save(e)}>
      <Feedback error={error} notice={notice}/>
      <fieldset className="admin-fieldset" disabled={busy}>
        {section === 'accounts' ? <><h2>登录设置</h2><Switch label="启用账号系统" checked={policy.accounts_enabled} disabled={busy} onChange={accounts_enabled => patch({ accounts_enabled })}/><Switch label="启用邮箱注册与登录" checked={policy.email_enabled} disabled={busy} onChange={email_enabled => patch({ email_enabled })}/><p className="admin-note">关闭账号系统后，站点仍以访客模式开放；原有账号和记录保留。</p><dl className="admin-facts"><div><dt>邮件通道</dt><dd>{data.mail_configured ? '已配置' : '未配置'}</dd></div><div><dt>人机验证</dt><dd>{data.turnstile?.enabled ? data.turnstile.ready ? '已启用' : '配置未完成' : '未启用'}</dd></div><div><dt>第三方登录</dt><dd>{data.providers.filter(p => p.available).map(p => p.label).join('、') || '均未启用'}</dd></div></dl></> : tab === 'global' ? <>
          <h2>全局额度</h2><label className="admin-field"><span>配额策略</span><Dropdown title="配额策略" disabled={busy} value={policy.quota_mode} options={[{value:'enforce',label:'启用限制'}, {value:'observe',label:'只统计用量'}, {value:'off',label:'关闭'}]} onChange={quota_mode => patch({ quota_mode })}/></label>
          {policy.quota_mode !== 'enforce' && <p className="admin-feedback warning">当前策略不会按用户额度拦截请求。</p>}
          <div className="admin-form-grid"><NumberField label="访客累计体验轮数" value={policy.guest_turns} min={1} max={100} onChange={v => patch({ guest_turns: v! })}/><NumberField label="默认每日对话轮数" value={policy.daily_tasks} min={1} max={10000} onChange={v => patch({ daily_tasks: v! })}/><NumberField label="默认同时运行任务" value={policy.concurrent_tasks} min={1} max={32} onChange={v => patch({ concurrent_tasks: v! })}/><NumberField label="默认每日上传（MiB）" value={policy.daily_upload_bytes / 1048576} min={1/1024} max={1024} step={1/1024} onChange={v => patch({ daily_upload_bytes: Math.round(v! * 1048576) })}/><NumberField label="普通用户 30 天额度（点）" value={policy.member_monthly_units} min={1000} onChange={v => patch({ member_monthly_units: v! })}/><NumberField label="公共 30 天总池（点）" value={policy.public_monthly_units} min={1000} max={2000000000} onChange={v => patch({ public_monthly_units: v! })}/><NumberField label="单次模型输出上限（token）" value={policy.model_output_tokens} min={512} max={16384} onChange={v => patch({ model_output_tokens: v! })}/></div><p className="admin-note">模型额度同时约束最近 5 小时、7 天、30 天，分别为 30 天额度的 20%、50%、100%。</p>
        </> : tab === 'roles' ? <>
          <div className="admin-section-heading"><h2>角色额度</h2><Dropdown title="额度角色" disabled={busy} value={role} options={allRoles} onChange={setRole}/><button type="button" className="secondary-button" disabled={!policy.roles[role]} onClick={() => { const roles = { ...policy.roles }; delete roles[role]; patch({ roles }) }}>恢复默认</button></div><div className="admin-form-grid"><NumberField label="每日对话轮数" value={roleLimit.daily_tasks} min={1} max={10000} onChange={v => rolePatch({daily_tasks:v!})}/><NumberField label="同时运行任务" value={roleLimit.concurrent_tasks} min={1} max={32} onChange={v => rolePatch({concurrent_tasks:v!})}/><NumberField label="每日上传（MiB）" value={roleLimit.daily_upload_bytes / 1048576} min={1/1024} step={1/1024} max={1024} onChange={v => rolePatch({daily_upload_bytes:Math.round(v! * 1048576)})}/><NumberField label="30 天模型额度（点）" value={roleLimit.monthly_units} min={1000} onChange={v => rolePatch({monthly_units:v!})}/></div><Switch label="该角色不限额" checked={roleLimit.exempt} disabled={busy} onChange={exempt => rolePatch({exempt})}/><p className="admin-note">{role === 'guest' && policy.accounts_enabled ? '访客对话按全局“累计体验轮数”限制。' : '单用户覆盖优先于角色额度。'}站点所有者始终不限额。</p>
        </> : <>
          <div className="admin-section-heading"><h2>供应商额度</h2><Dropdown title="额度供应商" disabled={busy} value={provider} options={providerOptions(data.model_providers)} onChange={setProvider}/><button type="button" className="secondary-button" disabled={!policy.provider_budgets[provider]} onClick={() => { const budgets = { ...policy.provider_budgets }; delete budgets[provider]; patch({provider_budgets:budgets}) }}>恢复默认</button></div><div className="admin-form-grid"><NumberField label="供应商 30 天总池（点）" value={providerLimit.monthly_units} min={1000} max={2000000000} onChange={v => providerPatch({monthly_units:v!})}/><NumberField label="单次输出上限（token）" value={providerLimit.output_tokens} min={512} max={16384} onChange={v => providerPatch({output_tokens:v!})}/>{allRoles.map(r => <NumberField key={r.value} label={r.label + '（点 / 30 天）'} value={providerLimit.role_monthly_units[r.value]} optional min={1000} placeholder="继承用户额度" onChange={v => { const roles = { ...providerLimit.role_monthly_units }; if (v === undefined) delete roles[r.value]; else roles[r.value] = v; providerPatch({role_monthly_units:roles}) }}/>)}</div><p className="admin-note">这是本站配额，不会更改供应商套餐或账单。角色豁免时不执行用户额度限制。</p>
        </>}
      </fieldset>
      <SaveBar reason={reason} onReason={setReason} busy={busy} disabled={!dirty}><button type="button" className="secondary-button" disabled={busy} onClick={onSaved}>重新载入</button></SaveBar>
    </form>}
  </>
}

function UsageLedger({ providers, owner = '', refreshKey }: { providers: Provider[]; owner?: string; refreshKey: number }) {
  const [ownerInput, setOwnerInput] = useState(owner); const [ownerId, setOwnerId] = useState(owner)
  const [provider, setProvider] = useState(''); const [status, setStatus] = useState('all'); const [page, setPage] = useState(1)
  const [result, setResult] = useState<(Page<Usage> & { units: number }) | null>(null)
  const [error, setError] = useState(''); const [busy, setBusy] = useState(true)
  useEffect(() => {
    let live = true; setBusy(true); setError('')
    accountRequest<Page<Usage> & { units: number }>('/api/admin/quotas/usage?' + directoryQuery({owner_id:ownerId,provider_id:provider,status,page,page_size:20})).then(value => { if (live) setResult(value) }).catch(e => { if (live) setError(problem(e)) }).finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [ownerId, provider, status, page, refreshKey])
  const names = Object.fromEntries(providerOptions(providers).map(p => [p.value, p.label]))
  return <section className="admin-surface admin-ledger"><form className="admin-filters" onSubmit={e => { e.preventDefault(); setOwnerId(ownerInput); setPage(1) }}>{!owner && <><label className="admin-search"><Search size={16}/><input aria-label="筛选用量归属" placeholder="account_用户ID / guest_ID" maxLength={128} value={ownerInput} onChange={e => setOwnerInput(e.target.value)}/></label><button className="secondary-button">筛选</button></>}<Dropdown title="用量供应商" value={provider} options={[{value:'',label:'全部供应商'}, ...providerOptions(providers)]} onChange={v => {setProvider(v);setPage(1)}}/><Dropdown title="用量状态" value={status} options={[{value:'all',label:'全部状态'}, {value:'actual',label:'已结算'}, {value:'estimated',label:'预估消耗'}, {value:'reserved',label:'已预留'}]} onChange={v => {setStatus(v);setPage(1)}}/></form><Feedback error={error} notice=""/><div className="admin-section-heading"><h3>最近 30 天</h3><span>{(result?.units || 0).toLocaleString()} 点</span></div><p className="admin-note">包含预留和估算值；不等于供应商账单。点击记录可查看关联会话与调用。</p><div aria-busy={busy}>{result?.items.map(row => <details className="admin-usage-row" key={row.id}><summary><span><strong>{row.display_name}</strong><small>{names[row.provider_id] || row.provider_id} · {row.model}</small></span><span>{row.units.toLocaleString()} 点<small>{row.status === 'actual' ? '已结算' : row.status === 'estimated' ? '预估消耗' : '已预留'}{row.exempt ? ' · 豁免' : ''}</small></span><span>{date(row.created_at)}</span></summary><dl className="admin-facts"><div><dt>归属</dt><dd>{row.owner_id}</dd></div><div><dt>会话</dt><dd>{row.session_id || '—'}</dd></div><div><dt>调用</dt><dd>{row.invocation_id || '—'}</dd></div><div><dt>Token</dt><dd>输入 {row.prompt_tokens} / 输出 {row.completion_tokens}</dd></div></dl></details>)}</div>{!result?.items.length && <p className="admin-empty">{busy ? '正在读取用量…' : error ? '用量暂不可用' : '暂无匹配的用量记录'}</p>}<Pagination total={result?.total || 0} page={page} busy={busy} onChange={setPage}/></section>
}
