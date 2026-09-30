export type SettingsSection = 'general' | 'account' | 'quota' | 'data' | 'about'

export function requestedSettings(location: { pathname: string; search: string }): SettingsSection | null {
  if (location.pathname === '/account') return 'account'
  if (location.pathname === '/quota') return 'quota'
  const value = new URLSearchParams(location.search).get('settings')
  return ['general', 'account', 'quota', 'data', 'about'].includes(value || '') ? value as SettingsSection : null
}

export function workbenchAfterSettings(location: { pathname: string; search: string; hash: string }): string {
  const query = new URLSearchParams(location.search)
  query.delete('settings')
  const path = ['/account', '/quota'].includes(location.pathname) ? '/' : location.pathname
  return path + (query.size ? '?' + query.toString() : '') + location.hash
}
