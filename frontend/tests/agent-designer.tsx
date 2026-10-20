// Isolated UI fixture. No production API requests, credentials or paid model calls.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { NewAgentMenu, type CreationMode } from '../src/admin/NewAgentMenu'
import { AgentDesigner, type AgentDraft } from '../src/admin/AgentDesigner'
import { AgentBuilder } from '../src/admin/AgentBuilder'
import type { Provider } from '../src/types'
import { api } from '../src/api'
import App from '../src/App'
import '../src/styles.css'

const query = new URLSearchParams(location.search)
document.documentElement.dataset.theme = query.get('theme') || 'light'
const providers: Provider[] = [{ id: 'fixture', name: '示例模型', kind: 'openai-chat',
  base_url: 'https://example.invalid', default_model: 'fixture-model', active: true,
  key_configured: true, api_key_env: '', updated_at: '' }]
const draft: AgentDraft = { id: 'policy-researcher', name: '政策研究助手', role: 'partner', aic: '',
  description: '检索官方政策并附可追溯来源', system_prompt: '区分来源事实与推断，不编造政策或数据。',
  tools: ['web_search'], skills: [{ id: 'policy', name: '政策研究', description: '整理政策资料' }],
  transport: 'provider', usage_mode: 'internal', model_provider: 'fixture', model_name: 'fixture-model' }
function Preview() {
  const [mode, setMode] = useState<CreationMode | 'review' | null>(null)
  const [calls, setCalls] = useState(0)
  const [saved, setSaved] = useState(false)
  const open = (next: CreationMode) => { setSaved(false); setMode(next) }
  Object.assign(api, { createAgent: async () => { setSaved(true); return {} } })
  if (query.has('integration')) {
    Object.assign(api, {
      dashboard: async () => ({}), agents: async () => [], providers: async () => providers,
      policy: async () => ({}), traces: async () => [], probes: async () => [],
      generateAgentDraft: async () => { setCalls(value => value + 1); return {
        draft, request_id: 'fixture-only', application_quota_exempt: true,
        usage: { llm_calls: 1, prompt_tokens: 100, completion_tokens: 200 },
      } },
    })
    return <><div style={{ position: 'fixed', right: 14, bottom: 10, zIndex: 2000,
      padding: '5px 10px', background: 'var(--paper)', color: 'var(--muted)', fontSize: 11,
      border: '1px solid var(--soft-line)', borderRadius: 8 }}>隔离预览 · 无线上请求 · 生成 {calls} 次</div><App/></>
  }
  return <main className="design-next" style={{ width: '100%', minHeight: '100dvh', padding: 24, background: 'var(--paper)', color: 'var(--ink)' }}>
    <h2>管理面板创建 · 隔离预览</h2><p>仅样例数据，不连接线上服务。生成调用：{calls}{saved ? ' · 已确认创建' : ''}</p>
    <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'start' }}>
      <div style={{ width: 230 }}><NewAgentMenu variant="sidebar" onCreate={open}/></div>
      <NewAgentMenu onCreate={open}/>
    </div>
    {mode === 'ai' && <AgentDesigner providers={providers} onClose={() => setMode(null)}
      onDraft={() => setMode('review')} client={{ generateAgentDraft: async () => {
        setCalls(value => value + 1)
        if (query.has('failure')) throw new Error('示例：模型服务不可用，未创建智能体')
        return { draft, request_id: 'fixture-only', application_quota_exempt: true,
          usage: { llm_calls: 1, prompt_tokens: 100, completion_tokens: 200 } }
      } }}/>}
    {(mode === 'manual' || mode === 'review') && <AgentBuilder agent={null}
      initialDraft={mode === 'review' ? draft : undefined} providers={providers}
      onClose={() => setMode(null)} onSaved={async () => setMode(null)}/>}
  </main>
}
const nested = new URL(location.href)
nested.searchParams.delete('viewport')
function ViewportPreview() {
  const [width, setWidth] = useState(query.get('viewport') === 'narrow' ? 390 : 1024)
  return <div style={{ height: '100dvh', background: 'var(--cecece8)' }}>
    <div style={{ height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      {[390, 760, 820, 821, 1024].map(value => <button key={value} type="button" aria-pressed={width === value}
        onClick={() => setWidth(value)}>{value}px</button>)}
    </div>
    <iframe title="响应式测试视口" src={nested.href} style={{ display: 'block', width, maxWidth: '100%',
      height: 'calc(100dvh - 40px)', border: 0, margin: 'auto' }}/>
  </div>
}
createRoot(document.getElementById('root')!).render(query.has('viewport') ? <ViewportPreview/> : <Preview/> )
