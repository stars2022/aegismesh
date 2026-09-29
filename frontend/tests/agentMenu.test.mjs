import test from 'node:test'
import assert from 'node:assert/strict'
import { agentChoiceLabel, agentMenuLevels, defaultCoordinatorId } from '../src/agentMenu.ts'

const agents = [
  { id: 'travel_coordinator', name: '旅行规划', role: 'leader' },
  { id: 'heritage_guide', name: '古迹导览', role: 'partner' },
  { id: 'research_leader', name: '科研协作', role: 'leader' },
  { id: 'news_verification', name: '事实核验', role: 'partner' },
  { id: 'docs_overview', name: '文献检索', role: 'partner' },
]
test('selector partitions only by role, with all executors in one second level', () => {
  const levels = agentMenuLevels(agents)
  assert.deepEqual(Object.keys(levels), ['coordinators', 'executors'])
  assert.deepEqual(levels.coordinators.map(a => a.id), ['travel_coordinator', 'research_leader'])
  assert.deepEqual(levels.executors.map(a => a.id), ['heritage_guide', 'news_verification', 'docs_overview'])
})
test('partition preserves caller ordering and does not mutate discovery results', () => {
  const before = structuredClone(agents)
  agentMenuLevels(Object.freeze(agents))
  assert.deepEqual(agents, before)
})
test('selected executor and empty/leader-only menus have correct labels and levels', () => {
  assert.equal(agentChoiceLabel(agents[1]), '古迹导览 · 执行型')
  assert.equal(agentChoiceLabel(agents[0]), '旅行规划 · 协调型')
  assert.deepEqual(agentMenuLevels([]), { coordinators: [], executors: [] })
  assert.equal(agentMenuLevels([agents[0]]).executors.length, 0)
})

test('new specialized coordinators do not displace the default discovery entry', () => {
  const expanded = [{id:'news_coordinator',name:'新闻',role:'leader'}, ...agents,
    {id:'agent_discovery',name:'智能体发现助手',role:'leader'}]
  assert.equal(defaultCoordinatorId(expanded), 'agent_discovery')
  assert.equal(defaultCoordinatorId(expanded,true), 'research_leader')
  assert.equal(defaultCoordinatorId(agents), 'research_leader')
  assert.equal(defaultCoordinatorId([]), '')
  assert.equal(defaultCoordinatorId([agents[1]]), agents[1].id)
})
