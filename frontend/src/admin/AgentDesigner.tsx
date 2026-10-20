import { useEffect, useRef, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { api } from '../api'
import { Dropdown } from '../components'
import type { Agent, Provider } from '../types'
import './AgentDesigner.css'

export type AgentDraft = Partial<Agent> & { id: string; name: string; aic: string }
export type DesignerResult = {
  draft: AgentDraft
  request_id: string
  application_quota_exempt: boolean
  usage: { llm_calls: number; prompt_tokens: number; completion_tokens: number }
}

export function AgentDesigner({ providers, onClose, onDraft, client = api }: {
  providers: Provider[]
  onClose: () => void
  onDraft: (draft: AgentDraft) => void
  client?: Pick<typeof api, 'generateAgentDraft'>
}) {
  const available = providers.filter(item => item.active && item.key_configured)
  const [providerId, setProviderId] = useState(available[0]?.id || '')
  const [requirements, setRequirements] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const requirementField = useRef<HTMLTextAreaElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const previousFocus = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    requirementField.current?.focus()
    return () => { controller.current?.abort(); previousFocus.current?.focus() }
  }, [])
  const generate = async () => {
    if (busy) return
    setError('')
    if (!available.some(item => item.id === providerId)) { setError('请先配置可用的模型供应商'); return }
    if (requirements.trim().length < 5) { setError('请描述要创建的智能体，至少 5 个字符'); return }
    const pending = new AbortController()
    controller.current = pending
    setBusy(true)
    try {
      const result = await client.generateAgentDraft({ provider_id: providerId, requirements: requirements.trim() }, pending.signal)
      if (!pending.signal.aborted) onDraft(result.draft)
    } catch (reason) {
      if (!pending.signal.aborted) setError(reason instanceof Error ? reason.message : '生成失败，请稍后重试')
    } finally { if (!pending.signal.aborted) setBusy(false) }
  }
  return <div className="drawer-layer agent-designer-layer" onKeyDown={event => {
    if (event.key === 'Escape') onClose()
    if (event.key === 'Tab') {
      const items = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),[tabindex="0"]'))
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <button type="button" className="drawer-backdrop" aria-label="关闭 AI 生成" onClick={onClose}/>
    <section ref={dialog} className="agent-designer-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-designer-title">
      <header><h2 id="agent-designer-title"><Sparkles size={20}/>AI 生成智能体</h2>
        <button type="button" className="icon-button" aria-label="关闭 AI 生成" onClick={onClose}><X size={18}/></button></header>
      <form onSubmit={event => { event.preventDefault(); void generate() }}>
        <label>需求<textarea ref={requirementField} value={requirements} maxLength={6000} disabled={busy}
          onChange={event => setRequirements(event.target.value)} rows={7}
          placeholder="例如：创建一个新能源政策研究智能体，检索官方政策，区分事实与推断，并附上来源。"/></label>
        <label>生成模型<Dropdown value={providerId} options={available.map(item => ({ value: item.id, label: `${item.name} · ${item.default_model}` }))}
          placeholder="选择模型供应商" title="生成模型" disabled={busy} onChange={setProviderId}/></label>
        {error && <div className="builder-error" role="alert">{error}</div>}
        <footer><button type="submit" className="primary-button" disabled={busy || !available.length}>
          <Sparkles size={16}/>{busy ? '正在生成…' : '生成草稿'}</button></footer>
      </form>
    </section>
  </div>
}
