import { useId, useState } from 'react'
import { Braces, Check, Copy, Download } from 'lucide-react'
import type { Agent, JsonSchema } from './types'
import { fieldType, taskSchemas } from './structuredIOModel'
import './StructuredIO.css'

const example = JSON.stringify({ type: 'object', properties: { topic: { type: 'string', title: '主题' } }, required: ['topic'], additionalProperties: false }, null, 2)

export function SchemaEditors({ input, output, onInput, onOutput, inherited = false }: {
  input: string; output: string; onInput: (value: string) => void; onOutput: (value: string) => void; inherited?: boolean
}) {
  return <div className="structured-schema-editors">
    <label>输入 Schema<textarea spellCheck={false} rows={7} value={input} onChange={event => onInput(event.target.value)} placeholder={inherited ? '留空沿用智能体配置' : example}/></label>
    <label>输出 Schema<textarea spellCheck={false} rows={7} value={output} onChange={event => onOutput(event.target.value)} placeholder={inherited ? '留空沿用智能体配置' : example}/></label>
  </div>
}

function InputField({ name, schema, required, value, onChange }: {
  name: string; schema: JsonSchema; required: boolean; value: string; onChange: (value: string) => void
}) {
  const id = useId()
  const type = fieldType(schema)
  return <label htmlFor={id} className="structured-input-field">
    <span>{schema.title || name}{required && <span aria-label="必填"> *</span>}</span>
    {schema.enum ? <select id={id} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">请选择</option>{schema.enum.map((item, i) => <option key={i} value={JSON.stringify(item)}>{String(item)}</option>)}
    </select> : type === 'boolean' ? <select id={id} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">请选择</option><option value="true">是</option><option value="false">否</option>
    </select> : ['object', 'array'].includes(type) ? <textarea id={id} rows={3} spellCheck={false} value={value} onChange={event => onChange(event.target.value)} placeholder={type === 'array' ? '[…]' : '{…}'}/>
      : <input id={id} type={['number', 'integer'].includes(type) ? 'number' : 'text'} step={type === 'integer' ? 1 : 'any'} value={value} onChange={event => onChange(event.target.value)} placeholder={schema.default !== undefined ? String(schema.default) : undefined}/>}
    {schema.description && <small>{schema.description}</small>}
  </label>
}

export function StructuredTaskControls({ agent, enabled, skillId, values, disabled, onEnabled, onSkill, onValues }: {
  agent: Agent; enabled: boolean; skillId: string; values: Record<string, string>; disabled?: boolean
  onEnabled: (enabled: boolean) => void; onSkill: (skill: string) => void; onValues: (values: Record<string, string>) => void
}) {
  const { input, output } = taskSchemas(agent, skillId)
  return <section className="structured-task-controls">
    <label className="structured-task-toggle"><input type="checkbox" checked={enabled} disabled={disabled} onChange={event => onEnabled(event.target.checked)}/><Braces size={15}/><span>本次使用结构化输入输出</span></label>
    {enabled && <fieldset disabled={disabled}>
      {agent.skills.length > 0 && <label className="structured-input-field">技能<select value={skillId} onChange={event => onSkill(event.target.value)}><option value="">智能体默认</option>{agent.skills.map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></label>}
      {Object.entries(input?.properties || {}).map(([name, schema]) => <InputField key={name} name={name} schema={schema} required={Boolean(input?.required?.includes(name))} value={Object.hasOwn(values, name) ? values[name] : ''} onChange={value => onValues({ ...values, [name]: value })}/>)}
      {output && <details className="structured-output-schema"><summary>输出字段</summary><pre>{JSON.stringify(output, null, 2)}</pre></details>}
      {!input && !output && <p role="alert">所选技能尚未配置结构化字段</p>}
    </fieldset>}
  </section>
}

export function StructuredResult({ value }: { value: Record<string, unknown> }) {
  const [notice, setNotice] = useState('')
  const text = JSON.stringify(value, null, 2)
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setNotice('已复制') }
    catch { setNotice('复制失败，请手动选择内容') }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = 'aegismesh-result.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="structured-result"><div className="structured-result-heading"><span><Check size={14}/>JSON · 校验通过</span><div><button type="button" onClick={() => void copy()} aria-label="复制 JSON"><Copy size={14}/></button><button type="button" onClick={download} aria-label="下载 JSON"><Download size={14}/></button></div></div><pre>{text}</pre>{notice && <small role="status">{notice}</small>}</div>
}
