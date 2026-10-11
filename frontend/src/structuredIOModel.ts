import type { Agent, JsonSchema, StructuredTaskOptions } from './types'

export function schemaText(schema?: JsonSchema | null): string {
  return schema ? JSON.stringify(schema, null, 2) : ''
}

export function parseSchemaText(text: string): JsonSchema | null {
  if (!text.trim()) return null
  let schema: JsonSchema
  try { schema = JSON.parse(text) }
  catch { throw new Error('Schema 不是有效 JSON') }
  if (!schema || Array.isArray(schema) || schema.type !== 'object') throw new Error('Schema 根类型必须为 object')
  if (new TextEncoder().encode(text).length > 16384) throw new Error('Schema 不能超过 16 KB')
  return schema
}

export function taskSchemas(agent: Agent | undefined, skillId = '') {
  if (!agent?.structured_io_enabled) return { input: null, output: null }
  const skill = skillId ? agent.skills.find(item => item.id === skillId) : undefined
  return { input: skill?.input_schema || agent.input_schema || null, output: skill?.output_schema || agent.output_schema || null }
}

export function fieldType(schema: JsonSchema): string {
  return (Array.isArray(schema.type) ? schema.type.find(type => type !== 'null') : schema.type) || 'string'
}

export function inputValues(data?: Record<string, unknown>, schema?: JsonSchema | null): Record<string, string> {
  return Object.fromEntries(Object.entries(data || {}).map(([key, value]) => [key, typeof value === 'string' && !schema?.properties?.[key]?.enum ? value : JSON.stringify(value)]))
}

export function buildStructuredTask(agent: Agent | undefined, enabled: boolean, skillId: string, values: Record<string, string>): StructuredTaskOptions | undefined {
  if (!enabled) return undefined
  if (!agent?.structured_io_enabled) throw new Error('当前智能体未开放结构化输入输出')
  if (skillId && !agent.skills.some(skill => skill.id === skillId)) throw new Error('所选技能已变更，请重新选择')
  const { input, output } = taskSchemas(agent, skillId)
  if (!input && !output) throw new Error('尚未配置输入或输出字段')
  const data: Record<string, unknown> = Object.create(null)
  if (input) for (const [key, schema] of Object.entries(input.properties || {})) {
    const raw = Object.hasOwn(values, key) ? values[key] : ''
    if (!raw.trim()) {
      if (schema.default !== undefined) data[key] = schema.default
      else if (input.required?.includes(key)) throw new Error(`请填写${schema.title || key}`)
      continue
    }
    if (fieldType(schema) === 'string' && !schema.enum) data[key] = raw
    else {
      try { data[key] = JSON.parse(raw) }
      catch { throw new Error(`${schema.title || key}格式不正确`) }
    }
  }
  return { structured_io: true, ...(input ? { input_data: data } : {}), ...(skillId ? { requested_skill: skillId } : {}) }
}
