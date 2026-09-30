import test from 'node:test'
import assert from 'node:assert/strict'
import { directoryQuery, policyChanges, roleDefaults, userChanges, withOptionalLimit, withProviderLimit } from '../src/accountAdminModel.ts'

const policy = { accounts_enabled:true, email_enabled:true, quota_mode:'enforce', daily_tasks:20, concurrent_tasks:2, daily_upload_bytes:104857600, member_monthly_units:1600000, public_monthly_units:160000000, guest_turns:3, model_output_tokens:4096, roles:{}, provider_budgets:{} }

test('account and quota pages never overwrite each other’s switches', () => {
  assert.deepEqual(policyChanges(policy, 'accounts'), {accounts_enabled:true,email_enabled:true})
  const changes = policyChanges(policy, 'quotas')
  assert.equal(changes.accounts_enabled, undefined)
  assert.equal(changes.email_enabled, undefined)
  assert.equal(changes.guest_turns, 3)
})

test('displayed inherited role limits agree with server multipliers', () => {
  assert.equal(roleDefaults(policy, 'trusted').daily_upload_bytes, 3 * policy.daily_upload_bytes)
  assert.equal(roleDefaults(policy, 'trusted').monthly_units, 4800000)
  assert.equal(roleDefaults(policy, 'guest').concurrent_tasks, 1)
  assert.equal(roleDefaults({...policy,member_monthly_units:10000}, 'guest').monthly_units, 10000)
  assert.equal(roleDefaults(policy, 'admin').exempt, true)
})

test('zero is an explicit deny; blank restores inheritance and preserves other fields', () => {
  let limits = withOptionalLimit({monthly_units:4000}, 'daily_tasks', 0)
  assert.equal(limits.daily_tasks, 0)
  limits = withOptionalLimit(limits, 'daily_tasks', undefined)
  assert.deepEqual(limits, {monthly_units:4000})
  limits = withProviderLimit(limits, 'deepseek', 0)
  assert.equal(limits.provider_monthly_units.deepseek, 0)
  limits = withProviderLimit(limits, 'deepseek', undefined)
  assert.deepEqual(limits, {monthly_units:4000})
})

test('user save stages actual differences and clearing limits never touches accounting records', () => {
  const account = {id:'one',role:'member',active:true,display_name:'A'}
  const before = {account,limits:{daily_tasks:5}}
  assert.deepEqual(userChanges(before, account, before.limits), {})
  assert.deepEqual(userChanges(before, {...account,role:'trusted'}, {}), {role:'trusted',limits:null})
})

test('directory searches safely encode literal name, email, and pagination', () => {
  const parsed = new URLSearchParams(directoryQuery({q:' a+b@例子.com&role=admin ',page:2,role:'all'}))
  assert.equal(parsed.get('q'), 'a+b@例子.com&role=admin')
  assert.equal(parsed.get('role'), 'all')
  assert.equal(parsed.get('page'), '2')
})
