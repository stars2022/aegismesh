export type ThemeChoice = 'system' | 'light' | 'dark'

export type CompressionStrategy = 'auto' | 'aggressive' | 'conservative' | 'off'

export type UserSettings = {
  theme: ThemeChoice
  contextWindow: number
  showContextMeter: boolean
  autoCompress: boolean
  compressionStrategy: CompressionStrategy
  keepRecentTurns: number
}

export const COMPRESSION_STRATEGIES = [
  { value: 'auto', label: '60%' },
  { value: 'aggressive', label: '40%' },
  { value: 'conservative', label: '80%' },
  { value: 'off', label: '关闭' },
]

export const CONTEXT_WINDOWS = [
  { value: '8192', label: '8K tokens' },
  { value: '32768', label: '32K tokens' },
  { value: '131072', label: '128K tokens' },
  { value: '262144', label: '256K tokens' },
  { value: '1048576', label: '100万 tokens (1M)' },
]

export const DEFAULT_SETTINGS: UserSettings = {
  theme: 'system',
  contextWindow: 32768,
  showContextMeter: true,
  autoCompress: true,
  compressionStrategy: 'auto',
  keepRecentTurns: 4,
}

const STORAGE_KEY = 'aegismesh-settings'

export function loadSettings(): UserSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<UserSettings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: UserSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function resolveTheme(theme: ThemeChoice): 'light' | 'dark' {
  if (theme !== 'system') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(settings: UserSettings): void {
  const resolved = resolveTheme(settings.theme)
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (themeColor) themeColor.content = resolved === 'dark' ? '#09090a' : '#f5f5f2'
}

export function watchSystemTheme(onChange: (settings: UserSettings) => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const listener = () => onChange(loadSettings())
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

/** 粗略 token 估算：中日韩字符约 0.6 token/字，其余约 4 字符 1 token。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length
  const rest = text.length - cjk
  return Math.ceil(cjk * 0.6 + rest / 4)
}
