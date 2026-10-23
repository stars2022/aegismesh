/** Opaque UI/session identifiers, including on HTTP IP-based test deployments.
 * Never substitute Math.random: the fallback keeps the browser's secure RNG.
 * Authentication and ownership must still be enforced by the server.
 */
export function createId() {
  const source = globalThis.crypto
  if (typeof source?.randomUUID === 'function') return source.randomUUID()
  if (typeof source?.getRandomValues !== 'function') {
    throw new Error('浏览器不支持安全随机数，请更新浏览器后重试。')
  }
  const bytes = source.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
