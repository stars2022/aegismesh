import test from 'node:test'
import assert from 'node:assert/strict'
import { requestedSettings, workbenchAfterSettings } from '../src/accountNavigation.ts'

test('account and quota links open settings, not standalone management pages', () => {
  for (const section of ['account', 'quota']) {
    const location = { pathname: '/' + section, search: '', hash: '' }
    assert.equal(requestedSettings(location), section)
    assert.equal(workbenchAfterSettings(location), '/')
    assert.equal(requestedSettings({ pathname: '/', search: '?settings=' + section }), section)
  }
})

test('login stays independent and only known settings sections are accepted', () => {
  assert.equal(requestedSettings({ pathname: '/login', search: '' }), null)
  assert.equal(requestedSettings({ pathname: '/', search: '?settings=https://example.org' }), null)
  assert.equal(workbenchAfterSettings({ pathname: '/', search: '?settings=account&mode=canvas', hash: '#existing' }), '/?mode=canvas#existing')
})
