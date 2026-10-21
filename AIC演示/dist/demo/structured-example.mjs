// A pre-existing API result for the walkthrough, not a new chat composer mode.
// The real backend still requires explicit structured_io in an API request.
export async function seedStructuredExample(runtime) {
  const session = 'demo-structured-result'
  if ((await runtime.fetch(`/api/account/history/${session}`)).status === 200) return
  const message = '围绕大模型多智能体协作，按约定字段整理研究摘要、主要发现与资料来源。'
  const result = await (await runtime.fetch('/api/demo/chat', { method: 'POST', body: JSON.stringify({
    session_id: session, agent_id: 'research_leader', message, structured_io: true,
  }) })).json()
  const conversation = { id: 'structured-result-example', session, title: '结构化结果示例', agentId: 'research_leader',
    messages: [{ role: 'user', text: message, createdAt: Date.now() },
      { role: 'assistant', text: result.answer, result, createdAt: Date.now() }], queue: [], updatedAt: Date.now() }
  const saved = await runtime.fetch(`/api/account/history/${session}`, { method: 'PUT', body: JSON.stringify({ revision: 0, conversation }) })
  if (!saved.ok) throw new Error('预置结构化结果未能保存')
}
