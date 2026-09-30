import type { AccountConfig } from './AccountPanel'
import type { QuotaSummary } from './accountPresentation'

export type RoleLimits = { daily_tasks: number; concurrent_tasks: number; daily_upload_bytes: number; monthly_units: number; exempt: boolean }
export type UserLimits = Partial<RoleLimits> & { provider_monthly_units?: Record<string, number> }
export type ProviderBudget = { monthly_units: number; output_tokens: number; role_monthly_units: Record<string, number> }
export type AccountPolicy = {
  accounts_enabled: boolean; email_enabled: boolean; quota_mode: string
  daily_tasks: number; concurrent_tasks: number; daily_upload_bytes: number; guest_turns: number
  member_monthly_units: number; public_monthly_units: number; model_output_tokens: number
  roles: Record<string, RoleLimits>; provider_budgets: Record<string, ProviderBudget>
}
export type Provider = { id: string; name: string; active: boolean }
export type Administration = AccountConfig & { policy: AccountPolicy; policy_revision: string; mail_configured: boolean; model_providers: Provider[]; counts: { total: number; active: number; disabled: number } }
export type AccountRow = { id: string; display_name: string; email: string | null; role: string; active: boolean; created_at: string; last_login_at?: string | null; custom_quota?: boolean }
export type AccountDetail = {
  account: AccountRow; revision: string; limits: UserLimits; quota: QuotaSummary; login_methods: string[]
  sessions: { id: string; created_at: string; expires_at: string }[]
  audit: { id: number; actor: string; action: string; created_at: string; note: string; changes: Record<string, unknown> }[]
}
export type Page<T> = { items: T[]; total: number; page: number; page_size: number }
export type Usage = { id: string; owner_id: string; display_name: string; provider_id: string; model: string; session_id: string; invocation_id: string; prompt_tokens: number; completion_tokens: number; units: number; status: string; exempt: boolean; created_at: string }

export function directoryQuery(values: Record<string, string | number>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (String(value).trim()) query.set(key, String(value).trim())
  return query.toString()
}

export function policyChanges(policy: AccountPolicy, section: 'accounts' | 'quotas') {
  const { accounts_enabled, email_enabled, ...quotas } = policy
  return section === 'accounts' ? { accounts_enabled, email_enabled } : quotas
}

export function roleDefaults(policy: AccountPolicy, role: string): RoleLimits {
  const multiplier = role === 'trusted' ? 3 : 1
  return policy.roles[role] || {
    daily_tasks: policy.daily_tasks * multiplier,
    concurrent_tasks: role === 'guest' ? 1 : policy.concurrent_tasks,
    daily_upload_bytes: policy.daily_upload_bytes * multiplier,
    monthly_units: role === 'guest' ? Math.min(160000, policy.member_monthly_units) : policy.member_monthly_units * multiplier,
    exempt: role === 'admin',
  }
}

export function userChanges(before: AccountDetail, account: AccountRow, limits: UserLimits) {
  const changes: Record<string, unknown> = {}
  for (const key of ['display_name', 'role', 'active'] as const) if (account[key] !== before.account[key]) changes[key] = account[key]
  if (JSON.stringify(limits) !== JSON.stringify(before.limits)) changes.limits = Object.keys(limits).length ? limits : null
  return changes
}

export function withOptionalLimit(limits: UserLimits, key: keyof RoleLimits, value: number | boolean | undefined): UserLimits {
  const next = { ...limits }
  if (value === undefined) delete next[key]
  else Object.assign(next, { [key]: value })
  return next
}

export function withProviderLimit(limits: UserLimits, id: string, value: number | undefined): UserLimits {
  const next = { ...limits, provider_monthly_units: { ...limits.provider_monthly_units } }
  if (value === undefined) delete next.provider_monthly_units[id]
  else next.provider_monthly_units[id] = value
  if (!Object.keys(next.provider_monthly_units).length) delete (next as UserLimits).provider_monthly_units
  return next
}
