// Dev-only UI fixture: no credentials, API calls, or production writes.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WebSearchSettings, type SearchSettings } from '../src/WebSearchSettings'
import type { Provider } from '../src/types'
import '../src/styles.css'

let settings: SearchSettings = { backend: 'legacy', deepseek_provider_id: '', timeout_seconds: 30, max_results: 5, max_queries: 8, exa_key_configured: false }
const client = {
  searchSettings: async () => settings,
  updateSearchSettings: async (payload: Parameters<typeof import('../src/api').api.updateSearchSettings>[0]) => {
    settings = { backend: payload.backend, deepseek_provider_id: payload.deepseek_provider_id,
      timeout_seconds: payload.timeout_seconds, max_results: payload.max_results, max_queries: payload.max_queries,
      exa_key_configured: payload.clear_exa_api_key ? false : Boolean(payload.exa_api_key || settings.exa_key_configured) }
    return settings
  },
  testSearchSettings: async () => ({ ok: true, latency_ms: 1000, backend: 'exa',
    sources: [{ title: '示例搜索来源（仅测试数据）', url: 'https://example.org' }],
    usage: { llm_calls: 0, prompt_tokens: 0, completion_tokens: 0 } }),
}
const providers: Provider[] = [
  { id: 'model', name: 'OpenCode 推理', base_url: 'https://opencode.ai/zen/go/v1', kind: 'openai-chat', default_model: 'mimo-v2.5', active: true, key_configured: true, api_key_env: '', updated_at: '' },
  { id: 'search', name: 'DeepSeek 搜索（示例）', base_url: 'https://api.deepseek.com', kind: 'openai-chat', default_model: 'deepseek-flash', active: true, key_configured: true, api_key_env: '', updated_at: '' },
]
function Preview() {
  const [light, setLight] = useState(false)
  const [narrow, setNarrow] = useState(false)
  return <main className="design-next" style={{ maxWidth: narrow ? 390 : 1000, padding: 16, margin: 'auto' }}>
    <h2>搜索配置 · 本地测试数据</h2>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <button className="secondary-button" onClick={() => { setLight(!light); document.documentElement.dataset.theme = light ? 'dark' : 'light' }}>切换深浅色</button>
      <button className="secondary-button" onClick={() => setNarrow(!narrow)}>切换窄屏</button>
    </div>
    <WebSearchSettings providers={providers} client={client} />
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
