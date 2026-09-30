// Isolated preview: no request is forwarded to the account service.
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LoginPage } from '../src/AccountPanel'
import { SettingsDialog } from '../src/SettingsDialog'
import { DEFAULT_SETTINGS } from '../src/settings'
import '../src/styles.css'

const params = new URLSearchParams(window.location.search)
if (params.get('page') === 'admin') window.location.replace('/tests/account-administration.html?tab=accounts&theme=' + (params.get('theme') === 'dark' ? 'dark' : 'light'))
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light'
const providers = ['Google', 'Apple', '华为', '微信', 'QQ'].map((label, i) => ({ id: ['google', 'apple', 'huawei', 'wechat', 'qq'][i], label, available: false, reason: '仅隔离预览，未接入' }))
const quotaMode = params.get('quota') || 'off'
const base = { enabled: params.get('enabled') === '1', email_enabled: true, email_registration_ready: false, quota_mode: quotaMode, providers }
const signedIn = params.get('view') === 'account'
const quota = { mode: quotaMode, tasks: { used: 12, reserved: 2, limit: 100, remaining: 86 }, concurrency: { used: 0, reserved: 2, limit: 3, remaining: 1 }, upload_bytes: { used: 1572864, reserved: 0, limit: 104857600, remaining: 103284736 }, note: '任务按根调用计数；失败或取消释放额度。子调用不重复扣任务额度。' }
window.fetch = async (input, init) => {
  const path = String(input)
  const readonly = !init?.method || init.method === 'GET'
  const body = readonly && path.endsWith('/config') ? base : readonly && path.endsWith('/me') ? { owner_id: 'guest_preview', account: signedIn ? { id: 'preview', display_name: '示例用户', email: 'preview@example.org' } : null,
      identities: signedIn ? [{ id: 'link-preview', provider: 'google' }] : [], quota }
    : readonly && path.endsWith('/sessions') ? [{ id: 'device-preview', current: true, created_at: '2026-09-30T01:00:00Z' }]
    : readonly && path.endsWith('/accounts') ? { ...base, enabled: false, accounts: [], usage: [] } : { detail: '隔离预览，不会发起真实请求' }
  return new Response(JSON.stringify(body), { status: readonly && ['/config', '/me', '/accounts', '/sessions'].some(p => path.endsWith(p)) ? 200 : 503, headers: { 'Content-Type': 'application/json' } })
}
const root = createRoot(document.getElementById('root')!)
function AccountFixture() {
  const [open, setOpen] = useState(true)
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  if (!signedIn && params.get('page') !== 'quota') return <LoginPage/>
  return <main style={{padding:32}}><h1>AegisMesh</h1><button className="secondary-button" onClick={() => setOpen(true)}>设置</button>{open && <SettingsDialog settings={settings} onChange={patch => setSettings(value => ({...value,...patch}))} onClose={() => setOpen(false)} onClear={() => undefined} initialSection={params.get('page') === 'quota' ? 'quota' : 'account'}/>}</main>
}
root.render(<StrictMode><AccountFixture/></StrictMode>)
import.meta.hot?.dispose(() => root.unmount())
