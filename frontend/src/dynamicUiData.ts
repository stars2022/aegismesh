/** Boundary for model-generated UI. Keep returned content readable without
 * assuming that the model obeyed every field name in the component contract. */
export type UiRecord = Record<string, unknown>
export type DynamicUiBlock = { type: string; [key: string]: any }
const record = (value: unknown): UiRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as UiRecord : {}
export function uiText(value: unknown, depth = 0): string {
  if (value == null || depth > 5) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(item => uiText(item, depth + 1)).filter(Boolean).join('\n')
  return Object.entries(record(value)).map(([key, item]) => {
    const text = uiText(item, depth + 1)
    return text ? `${key}：${text}` : ''
  }).filter(Boolean).join('\n')
}
const firstText = (...values: unknown[]) => values.map(value => uiText(value)).find(Boolean) || ''
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const content = (item: UiRecord) => firstText(item.summary, item.content, item.body, item.description, item.text, item.markdown)
export function normalizeDynamicUiBlocks(raw: unknown): DynamicUiBlock[] {
  return list(raw).slice(0, 10).flatMap<DynamicUiBlock>(value => {
    const block = record(value), type = uiText(block.type), title = firstText(block.title, block.label)
    if (type === 'tabs') {
      const tabs = list(block.tabs ?? block.items).map((value, i) => {
        const item = record(value)
        return { label: firstText(item.label, item.title, item.name) || `分项 ${i + 1}`, summary: content(item), bullets: list(item.bullets ?? item.points).map(item => uiText(item)).filter(Boolean) }
      })
      return tabs.length ? [{ type: 'comparison', title: title || '方案对比', items: tabs }] : []
    }
    if (type === 'table') {
      const cols = list(block.columns ?? block.headers)
      const keys = cols.map(value => typeof value === 'string' ? value : firstText(record(value).key, record(value).field, record(value).label))
      const columns = cols.map(value => typeof value === 'string' ? value : firstText(record(value).label, record(value).title, record(value).key))
      const rows = list(block.rows ?? block.data).map(row => Array.isArray(row) ? row.map(item => uiText(item)) : keys.map(key => uiText(record(row)[key])))
      return columns.length ? [{ type, title, columns, rows }] : []
    }
    if (['cards', 'kpi_grid', 'bar_chart', 'actions'].includes(type)) {
      const items = list(block.items).filter(value => value != null).map(value => {
        const item = record(value)
        if (type === 'cards') return { title: firstText(item.title, item.label, item.name), subtitle: uiText(item.subtitle), body: content(item), badge: uiText(item.badge), url: firstText(item.url, item.link) }
        if (type === 'actions') return { label: firstText(item.label, item.title), prompt: firstText(item.prompt, item.label, item.title) }
        if (type === 'bar_chart') return { label: firstText(item.label, item.name), value: Number.isFinite(Number(item.value)) ? Number(item.value) : 0, display: firstText(item.display, item.value) }
        return { label: firstText(item.label, item.name), value: uiText(item.value), delta: uiText(item.delta), trend: ['up', 'down', 'flat'].includes(String(item.trend)) ? item.trend : 'flat' }
      })
      return items.length ? [{ type, title, items }] : []
    }
    // Unsupported blocks often contain valid prose. Preserve it as text rather
    // than silently dropping everything after a model's custom component name.
    const text = content(block) || uiText(block.items ?? block.data)
    return text ? [{ type: 'text', title, text }] : []
  })
}
