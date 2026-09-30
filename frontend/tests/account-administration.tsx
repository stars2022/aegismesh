// All mutations are in-memory fixture data. No account request reaches a server.
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { api } from '../src/api'
import type { AccountPolicy, AccountRow, UserLimits } from '../src/accountAdminModel'
import '../src/styles.css'

if (location.hostname !== '127.0.0.1' || location.port !== '5197') throw new Error('Use dedicated fixture port 5197')
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'
api.dashboard = async () => ({} as never)
api.agents = async () => []
api.providers = async () => []
api.policy = async () => ({} as never)
api.traces = async () => []
api.probes = async () => []
const users: AccountRow[] = Array.from({length:125}, (_, i) => ({id:'user-'+i,display_name:i === 0 ? '示例所有者' : '研究用户 '+i,email:'researcher'+i+'@example.test',role:i === 0 ? 'owner' : i % 3 === 0 ? 'trusted' : 'member',active:i % 7 !== 0 || i === 0,created_at:'2026-09-30T01:00:00Z',last_login_at:'2026-09-30T04:45:00Z'}))
const providers = [{id:'opencode',name:'OpenCode',active:true},{id:'search',name:'DeepSeek 搜索',active:false}]
let revision = '1'.repeat(64)
let policy: AccountPolicy = {accounts_enabled:true,email_enabled:true,quota_mode:'enforce',daily_tasks:20,concurrent_tasks:2,daily_upload_bytes:104857600,guest_turns:3,member_monthly_units:1600000,public_monthly_units:160000000,model_output_tokens:4096,roles:{},provider_budgets:{}}
const limits: Record<string, UserLimits> = {}
const history: Record<string, unknown[]> = {}
const revoked = new Set<string>()
const result = (body: unknown, status = 200) => Response.json(body, {status})
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin)
  const path = url.pathname; const body = init?.body ? JSON.parse(String(init.body)) : {}; const method = init?.method || 'GET'
  if (path === '/api/admin/accounts' && method === 'GET') return result({enabled:policy.accounts_enabled,email_enabled:policy.email_enabled,email_registration_ready:true,quota_mode:policy.quota_mode,providers:[],turnstile:{enabled:true,ready:true,site_key:''},policy,policy_revision:revision,mail_configured:true,model_providers:providers,counts:{total:users.length,active:users.filter(u=>u.active).length,disabled:users.filter(u=>!u.active).length}})
  if (path === '/api/admin/accounts/policy' && method === 'PATCH') {
    if (body.revision !== revision || new URLSearchParams(location.search).has('conflict')) return result({detail:'配置已被其他管理员修改，请刷新后重试'},409)
    policy = {...policy,...body.changes}; revision = String(Number(revision.slice(0,1)) + 1).repeat(64)
    return result({policy,policy_revision:revision})
  }
  if (path === '/api/admin/accounts/users') {
    const q = url.searchParams.get('q')?.toLowerCase() || ''; const role = url.searchParams.get('role') || 'all'; const status = url.searchParams.get('status') || 'all'
    const rows = users.filter(u => `${u.display_name} ${u.email} ${u.id}`.toLowerCase().includes(q) && (role === 'all' || role === u.role) && (status === 'all' || u.active === (status === 'active')))
    const page = Number(url.searchParams.get('page') || 1)
    return result({items:rows.slice((page-1)*20,page*20).map(u=>({...u,custom_quota:!!limits[u.id]})),total:rows.length,page,page_size:20})
  }
  if (path.startsWith('/api/admin/accounts/users/')) {
    const id = path.split('/')[5]; const user = users.find(u=>u.id === id)!
    if (!user) return result({detail:'账号不存在'},404)
    if (method === 'PATCH') {
      if (user.role === 'owner') return result({detail:'站点所有者受保护'},409)
      if ('limits' in body) limits[id] = body.limits || {}
      for (const key of ['active','role','display_name']) if (key in body) Object.assign(user,{[key]:body[key]})
      history[id] = [{id:Date.now(),actor:'fixture-admin',action:'修改用户角色与额度',created_at:new Date().toISOString(),note:body.reason,changes:{after:{role:user.role,active:user.active,limits:limits[id]}}},...(history[id] || [])]
      return result(user)
    }
    if (path.endsWith('/sessions/revoke')) { revoked.add(id); return result({ok:true,revoked_sessions:1}) }
    return result({account:user,revision:'a'.repeat(64),limits:limits[id] || {},quota:{},login_methods:['email'],sessions:revoked.has(id)?[]:[{id:'b'.repeat(64),created_at:'2026-09-30T01:00:00Z',expires_at:'2026-10-07T01:00:00Z'}],audit:history[id] || []})
  }
  if (path === '/api/admin/quotas/usage') {
    const page = Number(url.searchParams.get('page') || 1)
    const owner = url.searchParams.get('owner_id') || 'account_user-1'
    return result({items:[{id:'usage-1',owner_id:owner,display_name:'研究用户 1',provider_id:'opencode',model:'deepseek-v4.1-flash',session_id:'session_'+ 'long-id-'.repeat(16),invocation_id:'call_preview',prompt_tokens:5420,completion_tokens:860,units:8860,status:'actual',created_at:'2026-09-30T03:42:00Z',exempt:false}],total:1,page,page_size:20,units:8860,window_days:30})
  }
  throw new Error('Live request blocked in isolated admin fixture: '+path)
}
createRoot(document.getElementById('root')!).render(<App/>)
