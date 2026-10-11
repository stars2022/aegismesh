// Browser caches are namespaced by the server-verified principal, not by IP,
// email, display name, or the rotating login cookie. Legacy keys stay untouched.
let owner = ''

export function getConversationOwner() { return owner }

export function setConversationOwner(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('会话身份无效')
  owner = value
}

export function conversationStorageKey(key: string) {
  if (!owner) throw new Error('会话身份尚未初始化')
  return `aegismesh-owner:${owner}:${key}`
}

export function conversationStorageForOwner(principal: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(principal)) throw new Error('会话身份无效')
  const key = (name: string) => `aegismesh-owner:${principal}:${name}`
  return { getItem: (name: string) => localStorage.getItem(key(name)), setItem: (name: string, value: string) => localStorage.setItem(key(name), value), removeItem: (name: string) => localStorage.removeItem(key(name)) }
}

export const conversationStorage = {
  getItem: (key: string) => localStorage.getItem(conversationStorageKey(key)),
  setItem: (key: string, value: string) => localStorage.setItem(conversationStorageKey(key), value),
  removeItem: (key: string) => localStorage.removeItem(conversationStorageKey(key)),
}
