export type QuotaItem = { used: number; reserved: number; limit: number; remaining: number | null }
export type QuotaSummary = { mode: string; tasks: QuotaItem; concurrency: QuotaItem; upload_bytes: QuotaItem; note: string; role?: string; exempt?: boolean; task_period?: string
  model_budget?: { unit: string; rolling: boolean; windows: Record<string, { used: number; limit: number }>; providers: { id: string; name: string; used: number; limit: number }[] } }
export const roleLabels: Record<string, string> = { guest: '访客', member: '普通用户', trusted: '高级用户', admin: '管理员', owner: '站点所有者', service: '外部调用' }
export const quotaModeLabel: Record<string, string> = { off: '未启用限制', observe: '仅统计', enforce: '按额度使用' }
export function quotaPercent(item: QuotaItem, mode: string) {
  if (mode !== 'enforce' || !Number.isFinite(item.limit) || item.limit <= 0) return 0
  return Math.min(100, Math.max(0, (Math.max(0, item.used) + Math.max(0, item.reserved)) / item.limit * 100))
}
export function quotaSize(value: number) {
  return `${Math.max(0, value / 1048576).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} MB`
}
