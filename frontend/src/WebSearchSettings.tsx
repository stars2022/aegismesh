import { useEffect, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { api } from './api'
import { Dropdown, Switch } from './components'
import type { Provider } from './types'
import './WebSearchSettings.css'

export type SearchSettings = {
  backend: 'legacy' | 'disabled' | 'exa' | 'deepseek'
  deepseek_provider_id: string
  timeout_seconds: number
  max_results: number
  max_queries: number
  exa_key_configured: boolean
}
export type SearchSettingsUpdate = Omit<SearchSettings, 'exa_key_configured'> & {
  exa_api_key?: string
  clear_exa_api_key?: boolean
}
export type SearchTestResult = {
  ok: boolean
  latency_ms: number
  backend: string
  sources: { url: string; title?: string }[]
  usage: { llm_calls: number; prompt_tokens: number; completion_tokens: number }
}

const options = [
  { value: 'legacy', label: '沿用旧配置' },
  { value: 'exa', label: 'Exa' },
  { value: 'deepseek', label: 'DeepSeek（独立供应商）' },
  { value: 'disabled', label: '关闭搜索' },
]

export function WebSearchSettings({ providers, client = api }: {
  providers: Provider[]
  client?: Pick<typeof api, 'searchSettings' | 'updateSearchSettings' | 'testSearchSettings'>
}) {
  const [draft, setDraft] = useState<SearchSettings | null>(null)
  const [savedBackend, setSavedBackend] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [result, setResult] = useState<SearchTestResult | null>(null)

  const load = async () => {
    setError('')
    try {
      const settings = await client.searchSettings()
      setDraft(settings)
      setSavedBackend(settings.backend)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取搜索配置失败')
    }
  }
  useEffect(() => { void load() }, [])

  const update = (changes: Partial<SearchSettings>) => {
    if (busy) return
    setDraft(current => current && { ...current, ...changes })
    setError('')
    setNotice('')
    setResult(null)
  }
  const submit = async (test: boolean) => {
    if (!draft || busy) return
    setBusy(test ? 'test' : 'save')
    setError('')
    setNotice('')
    setResult(null)
    const payload: SearchSettingsUpdate = {
      backend: draft.backend, deepseek_provider_id: draft.deepseek_provider_id,
      timeout_seconds: draft.timeout_seconds, max_results: draft.max_results, max_queries: draft.max_queries,
      exa_api_key: apiKey.trim() || undefined, clear_exa_api_key: clearKey,
    }
    try {
      if (test) {
        setResult(await client.testSearchSettings(payload))
        setNotice('真实检索测试成功；尚未保存本次设置。')
      } else {
        const settings = await client.updateSearchSettings(payload)
        setDraft(settings)
        setSavedBackend(settings.backend)
        setApiKey('')
        setClearKey(false)
        setNotice('已保存，对新任务生效。智能体仍需启用 web_search 工具。')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '搜索配置操作失败')
    } finally {
      setBusy('')
    }
  }
  const available = providers.filter(provider => {
    try { return provider.active && provider.key_configured && new URL(provider.base_url).origin === 'https://api.deepseek.com' }
    catch { return false }
  })

  return <section className="panel web-search-settings">
    <details>
      <summary><Search size={18} /><strong>联网搜索</strong><span>{options.find(option => option.value === savedBackend)?.label || '读取中'}</span><ChevronDown size={16} /></summary>
      <div className="web-search-settings-body">
        <p>与推理模型分开配置，不改变智能体绑定或 AIC。测试会发起一次真实搜索，并产生对应服务用量。</p>
        {error && <div className="builder-error" role="alert">{error}</div>}
        {!draft && <button className="secondary-button" onClick={() => void load()}>重新读取</button>}
        {draft && <>
          <fieldset disabled={Boolean(busy)} className="form-stack">
            <label>搜索服务<Dropdown value={draft.backend} options={options} onChange={backend => update({ backend: backend as SearchSettings['backend'] })} title="搜索服务" /></label>
            {draft.backend === 'legacy' && <p>兼容升级前的行为：仅推理供应商为 DeepSeek 官方地址时启用搜索。选择 Exa 或独立 DeepSeek 后，切换推理模型不再影响搜索。</p>}
            {draft.backend === 'disabled' && <p>关闭所有智能体的联网搜索，不影响智能体发现和子任务派发。</p>}
            {draft.backend === 'exa' && <>
              <label>Exa API Key（可选）<input type="password" autoComplete="off" value={apiKey} placeholder={draft.exa_key_configured ? '留空保留已保存密钥' : '留空使用免密限流额度'} onChange={event => { setApiKey(event.target.value); setClearKey(false); setResult(null) }} /></label>
              <p>免密模式适合试用，有速率限制；持续运行建议使用独立密钥。密钥加密保存，不会复用模型供应商的密钥。</p>
              {draft.exa_key_configured && <Switch label="清除 Exa 密钥，恢复免密模式" checked={clearKey} disabled={Boolean(busy)} onChange={value => { setClearKey(value); setApiKey(''); setResult(null) }} />}
            </>}
            {draft.backend === 'deepseek' && <>
              <label>DeepSeek 搜索供应商<Dropdown value={draft.deepseek_provider_id} options={available.map(provider => ({ value: provider.id, label: provider.name }))} placeholder="选择独立 DeepSeek 供应商" title="DeepSeek 搜索供应商" onChange={deepseek_provider_id => update({ deepseek_provider_id })} /></label>
              <p>在本页添加一条地址为 https://api.deepseek.com、配置独立密钥并启用的供应商，再在此选择。搜索走 Anthropic 兼容接口，会产生 DeepSeek 模型用量；无需改动现有智能体绑定。</p>
              {!available.some(provider => provider.id === draft.deepseek_provider_id) && <p role="status">尚未选择可用的 DeepSeek 搜索供应商。</p>}
            </>}
            {(draft.backend === 'exa' || draft.backend === 'deepseek') && <div className="web-search-limits">
              <label>超时（秒）<input type="number" min={5} max={120} value={draft.timeout_seconds} onChange={event => update({ timeout_seconds: Number(event.target.value) })} /></label>
              <label>每次最多来源<input type="number" min={1} max={10} value={draft.max_results} onChange={event => update({ max_results: Number(event.target.value) })} /></label>
              <label>每个智能体的联网搜索上限<input type="number" min={1} max={20} value={draft.max_queries} onChange={event => update({ max_queries: Number(event.target.value) })} /></label>
            </div>}
          </fieldset>
          <div className="web-search-actions">
            <button className="secondary-button" disabled={Boolean(busy) || !['exa', 'deepseek'].includes(draft.backend)} onClick={() => void submit(true)}>{busy === 'test' ? '正在检索…' : '测试搜索'}</button>
            <button className="primary-button" disabled={Boolean(busy)} onClick={() => void submit(false)}>{busy === 'save' ? '保存中…' : '保存搜索设置'}</button>
          </div>
          {notice && <p role="status">{notice}</p>}
          {result && <div className="web-search-test-result"><p>{result.sources.length} 个来源 · {result.latency_ms} ms{result.usage.llm_calls > 0 ? ` · ${result.usage.prompt_tokens + result.usage.completion_tokens} tokens` : ''}</p><ul>{result.sources.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a></li>)}</ul></div>}
        </>}
      </div>
    </details>
  </section>
}
