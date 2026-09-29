export type AgentChoice = { id: string; name: string; role: 'leader' | 'partner' }

// Only roles affect navigation. Capabilities and discovery scores belong to routing.
export function agentMenuLevels(agents: readonly AgentChoice[]) {
  return {
    coordinators: agents.filter((agent) => agent.role === 'leader'),
    executors: agents.filter((agent) => agent.role === 'partner'),
  }
}

export function agentChoiceLabel(agent: AgentChoice) {
  return `${agent.name} · ${agent.role === 'leader' ? '协调型' : '执行型'}`
}

export function defaultCoordinatorId(agents: readonly AgentChoice[], canvas = false) {
  const preferred = canvas ? ['research_leader', 'agent_discovery'] : ['agent_discovery', 'research_leader']
  for (const id of preferred) {
    if (agents.some(agent => agent.id === id && agent.role === 'leader')) return id
  }
  return agents.find(agent => agent.role === 'leader')?.id || agents[0]?.id || ''
}
