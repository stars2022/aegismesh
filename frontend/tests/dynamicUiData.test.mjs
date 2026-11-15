import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDynamicUiBlocks } from '../src/dynamicUiData.ts'

test('candidate tabs preserve content aliases instead of showing blank panels', () => {
  const [block] = normalizeDynamicUiBlocks([{type:'tabs',tabs:[{label:'候选项目',content:'项目甲详细方案'},{title:'项目乙',description:'乙方案限制',points:['预算待确认']}]}])
  assert.equal(block.items[0].summary,'项目甲详细方案')
  assert.deepEqual(block.items[1],{label:'项目乙',summary:'乙方案限制',bullets:['预算待确认']})
})
test('legacy tabs become one comparison with every candidate directly available', () => {
  const [block] = normalizeDynamicUiBlocks([{type:'tabs',tabs:[{label:'甲',summary:'甲内容'},{label:'乙',summary:'乙内容'}]}])
  assert.equal(block.type,'comparison')
  assert.equal(block.items.length,2)
})
test('object table rows use column keys and preserve zero/false values', () => {
  const [table]=normalizeDynamicUiBlocks([{type:'table',columns:[{label:'人数',key:'count'},{label:'完成',key:'done'}],rows:[{count:0,done:false}]}])
  assert.deepEqual(table.rows,[['0','false']])
})
test('custom blocks retain returned prose and malformed model values do not become React objects', () => {
  const blocks=normalizeDynamicUiBlocks([null,{type:'candidate_list',title:'候选项目',content:{甲:'实际方案'}},{type:'cards',items:[null,{title:{name:'甲'},description:'实际说明'}]}])
  assert.equal(blocks[0].text,'甲：实际方案')
  assert.equal(blocks[1].items[0].body,'实际说明')
  assert.equal(typeof blocks[1].items[0].title,'string')
})
test('missing candidate detail remains empty so the UI can report it without inventing content', () => {
  assert.equal(normalizeDynamicUiBlocks([{type:'tabs',tabs:[{label:'项目甲'}]}])[0].items[0].summary,'')
  assert.deepEqual(normalizeDynamicUiBlocks({type:'tabs'}),[])
})
