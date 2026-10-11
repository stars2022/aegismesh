import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStructuredTask, fieldType, inputValues, parseSchemaText, schemaText, taskSchemas } from '../src/structuredIOModel.ts'

const input = { type: 'object', properties: { topic: {type: 'string'}, count: {type: 'integer', default: 2}, enabled: {type: 'boolean'}, items: {type: 'array'}, kind: {type: 'string', enum: ['a', 'b']} }, required: ['topic'], additionalProperties: false }
const output = { type: 'object', properties: {summary: {type: 'string'}}, required: ['summary'] }
const agent = { id: 'agent', structured_io_enabled: true, input_schema: input, output_schema: output, skills: [{id: 'one', input_schema: {type: 'object', properties: {number: {type: 'integer'}}, required: ['number']}}] }

test('feature stays off even when configured; no hidden fields in normal tasks', () => {
  assert.equal(buildStructuredTask(agent, false, '', {}), undefined)
  assert.throws(() => buildStructuredTask({...agent, structured_io_enabled: false}, true, '', {}))
  assert.deepEqual(taskSchemas({...agent, structured_io_enabled: false}), {input: null, output: null})
})
test('form serializes typed inputs without coercing booleans or enums to strings', () => {
  const result = buildStructuredTask(agent, true, '', {topic: '科学', count: '3', enabled: 'false', items: '[1,2]', kind: '"a"'})
  assert.equal(result.structured_io, true)
  assert.deepEqual({...result.input_data}, {topic: '科学', count: 3, enabled: false, items: [1,2], kind: 'a'})
  assert.equal(buildStructuredTask(agent, true, '', {topic: 'a'}).input_data.count, 2)
})
test('missing required fields and invalid JSON keep the draft for correction', () => {
  assert.throws(() => buildStructuredTask(agent, true, '', {}), /topic/)
  assert.throws(() => buildStructuredTask(agent, true, '', {topic:'a', items:'bad'}), /items/)
  assert.throws(() => buildStructuredTask(agent, true, 'missing', {topic:'a'}), /技能/)
})
test('skill overrides inherit the other half and do not leak unrelated fields', () => {
  assert.deepEqual(taskSchemas(agent, 'one'), {input: agent.skills[0].input_schema, output})
  assert.deepEqual({...buildStructuredTask(agent, true, 'one', {number:'1', topic:'old'}).input_data}, {number:1})
})
test('output-only works and schema text round trips', () => {
  assert.deepEqual(buildStructuredTask({...agent, input_schema: null}, true, '', {}), {structured_io:true})
  assert.equal(parseSchemaText(''), null)
  assert.deepEqual(parseSchemaText(schemaText(output)), output)
  assert.throws(() => parseSchemaText('[]'))
  assert.throws(() => parseSchemaText('oops'))
  assert.equal(fieldType({type:['null','number']}), 'number')
})
test('queued typed input restores safely including prototype-like field names', () => {
  assert.deepEqual(inputValues({topic:'a', enabled:false, items:[1], count:0}), {topic:'a', enabled:'false', items:'[1]', count:'0'})
  const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}')
  const result = buildStructuredTask({...agent, input_schema:schema}, true, '', JSON.parse('{"__proto__":"safe"}'))
  assert.equal(result.input_data.__proto__, 'safe')
  assert.equal(Object.getPrototypeOf(result.input_data), null)
  const restored = inputValues({topic:'a',kind:'a'}, input)
  assert.equal(restored.kind, '"a"')
  assert.equal(buildStructuredTask(agent, true, '', restored).input_data.kind, 'a')
})
