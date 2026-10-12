export type DigitalHumanPreferences = { largeText: boolean; voiceId: string; voiceRate: number; voiceOn: boolean }

/** Preferences share the same account-scoped storage as consultations. 播报默认开启，用户手动关闭后会被记住。 */
export function readDigitalHumanPreferences(raw: string | null): DigitalHumanPreferences {
  let value: Partial<DigitalHumanPreferences> | null = null
  try { value = JSON.parse(raw || 'null') } catch { /* Invalid saved preferences use defaults. */ }
  return {
    largeText: value?.largeText === true,
    voiceId: typeof value?.voiceId === 'string' ? value.voiceId.slice(0, 256) : '',
    voiceRate: [.8, .9, 1].includes(value?.voiceRate as number) ? value!.voiceRate! : .9,
    voiceOn: value?.voiceOn !== false,
  }
}

export function isNearConversationEnd(metrics: { scrollHeight: number; scrollTop: number; clientHeight: number }) {
  return metrics.scrollHeight - Math.max(0, metrics.scrollTop) - metrics.clientHeight <= 80
}
