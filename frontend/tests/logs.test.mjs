import assert from 'node:assert/strict'
import test from 'node:test'
import { initialLogFilter, logQuery } from '../src/logs.ts'

test('log filters encode identifiers and use a precise UTC window', () => {
  const now = Date.parse('2026-09-28T10:00:00Z')
  const params = new URLSearchParams(logQuery({ ...initialLogFilter, q: 'task&kind=secret', related_id: '  task-1  ', aic: 'aic/+A' }, '', now))
  assert.equal(params.get('q'), 'task&kind=secret')
  assert.equal(params.get('kind'), 'activity')
  assert.equal(params.get('related_id'), 'task-1')
  assert.equal(params.get('aic'), 'aic/+A')
  assert.equal(params.get('since'), '2026-09-21T10:00:00.000Z')
})

test('admin audit clears the AMP type and all-time scope has no implicit time filter', () => {
  const params = new URLSearchParams(logQuery({ ...initialLogFilter, origin: 'admin', period: 'all' }, 'cursor+/='))
  assert.equal(params.get('kind'), '')
  assert.equal(params.get('cursor'), 'cursor+/=')
  assert.equal(params.has('since'), false)
})

test('custom time rejects invalid and reversed ranges', () => {
  assert.throws(() => logQuery({ ...initialLogFilter, period: 'custom', since: 'not-a-date' }), /有效时间/)
  assert.throws(() => logQuery({ ...initialLogFilter, period: 'custom', since: '2026-09-29T10:00:00Z', until: '2026-09-28T10:00:00Z' }), /不能晚于/)
  const query = new URLSearchParams(logQuery({ ...initialLogFilter, period: 'custom', since: '2026-09-28T18:00:00+08:00' }))
  assert.equal(query.get('since'), '2026-09-28T10:00:00.000Z')
})
