import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { RECORDING_PLAN, isRecordOnly, RECORD_ONLY_KEY } from '../dist/demo/recording-plan.mjs'

test('all twelve modules have a readable title page and paired narration', () => {
  assert.equal(RECORDING_PLAN.length, 12)
  assert.equal(new Set(RECORDING_PLAN.map(row => row.key)).size, 12)
  for (const row of RECORDING_PLAN) {
    assert.ok(row.seconds >= 6)
    assert.ok(row.title && row.intro && row.narration)
    assert.ok(row.intro.length <= 24, row.key)
  }
})
test('module pages contain only the brand and title, with no counters or decoration', async () => {
  const source = await readFile(new URL('../dist/demo/recording-plan.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /recording-chapter-number|recording-chapter-line|padStart|indexOf\(item\)/)
})
test('record-only controller isolation survives production route navigation', () => {
  const map = new Map(), storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) }
  assert.equal(isRecordOnly(new URLSearchParams(''), storage), false)
  assert.equal(isRecordOnly(new URLSearchParams('record=1'), storage), true)
  assert.equal(map.get(RECORD_ONLY_KEY), '1')
  assert.equal(isRecordOnly(new URLSearchParams('tab=studio'), storage), true)
})
test('capture mode cannot render or reopen the remote on F8 or errors', async () => {
  const source = await readFile(new URL('../dist/demo/director.mjs', import.meta.url), 'utf8')
  assert.match(source, /recordOnly \? 'aegismesh-recording-status'/)
  assert.match(source, /shadow.innerHTML = recordOnly \? '<span id="status" hidden><\/span>'/)
  assert.match(source, /if \(!recordOnly\) host.toggleAttribute\('open'\)/)
  assert.match(source, /if \(!recordOnly\) host.setAttribute\('open'/)
})
