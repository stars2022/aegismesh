import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { groupMessageText } from '../src/chat/groupMessageText.ts'

test('group deliverables use compact references without changing source history', () => {
  const text = '请专家复核。\n```blackboard:研究综述\n完整材料\n```\n下一位请接力。'
  assert.equal(groupMessageText(text), '请专家复核。\n\n\n交付物「研究综述」已汇入黑板。\n\n\n下一位请接力。')
  assert.match(text, /完整材料/)
  assert.doesNotMatch(groupMessageText(text), /完整材料/)
})
test('ordinary code, incomplete streaming blocks and empty blocks are preserved', () => {
  for (const text of ['```js\nconst a = 1\n```', '```blackboard:标题\n未完成', '```blackboard\n\n```']) assert.equal(groupMessageText(text), text)
  assert.match(groupMessageText('```BLACKBOARD\r\n材料\r\n```'), /工作交付物/)
})
test('markdown code surfaces use dedicated non-inverting theme tokens', async () => {
  const base = await readFile(new URL('../src/styles/00-foundation.css', import.meta.url), 'utf8')
  const dark = await readFile(new URL('../src/styles/12-dark-overrides.css', import.meta.url), 'utf8')
  assert.match(base, /\.message-markdown pre \{[^}]*background: var\(--code-surface\)/)
  assert.match(base, /\.message-markdown pre code \{[^}]*color: inherit/)
  assert.match(dark, /--code-surface: #18181b/)
})
