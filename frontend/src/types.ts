export type Skill = {
  id: string
  name: string
  description: string
  version?: string
  tags: string[]
  examples: string[]
  input_modes?: string[]
  output_modes?: string[]
  system_prompt?: string
}

export type Provider = {
  id: string
  name: string
  kind: 'openai-chat' | 'openai-responses' | 'anthropic'
  base_url: string
  api_key_env: string
  default_model: string
  active: boolean
  key_configured: boolean
  updated_at: string
}

export type Agent = {
  id: string
  aic: string
  name: string
  role: 'leader' | 'partner'
  description: string
  system_prompt: string
  endpoint_url: string
  transport: string
  usage_mode: 'both' | 'internal' | 'external'
  streaming_enabled: boolean
  notification_enabled?: boolean
  group_enabled?: boolean
  active: boolean
  health: string
  input_modes: string[]
  output_modes: string[]
  security_schemes: string[]
  skills: Skill[]
  tools: string[]
  model_provider: string
  model_name: string
  estimated_cost_per_1k: number
  avg_latency_ms: number
  success_count: number
  failure_count: number
  feedback_positive_count: number
  feedback_negative_count: number
  request_count: number
  active_tasks: number
  queued_tasks: number
  circuit_state: string
  consecutive_failures: number
  circuit_open_until: string | null
  registration_status: string
  registration_agent_id: string
  registration_message: string
  registration_synced_at: string | null
  eab_key_id: string
  eab_expires_at: string | null
  certificate_issued_at: string | null
  updated_at: string
}

export type DashboardData = {
  agents: number
  online_agents: number
  requests: number
  success_rate: number | null
  avg_latency_ms: number
  failovers: number
  active_tasks: number
  probe_health: { healthy: number; degraded: number }
  roles: { leaders: number; partners: number }
  agent_usage: { id: string; name: string; count: number }[]
  recent_activity: {
    id: string
    status: string
    latency_ms: number
    attempts: number
    created_at: string
  }[]
}

export type ProbeResult = {
  id: number
  agent_id: string
  status: string
  latency_ms: number | null
  acs_valid: boolean
  aip_reachable: boolean | null
  compatibility_score: number
  findings: { level: string; code: string; message: string }[]
  snapshot: Record<string, unknown>
  created_at: string
}

export type Candidate = {
  agent_id: string
  agent_name: string
  eligible: boolean
  score: number
  rank: number | null
  breakdown: Record<string, number>
  reasons: string[]
  weights?: Record<string, number>
}

export type ToolActivity = {
  id?: string
  name: string
  arguments?: Record<string, unknown>
  status?: string
  output_preview?: string
}

export type SubagentCollaboration = {
  task_id?: string
  session_id?: string
  invocation_id?: string
  agent_id: string
  agent_name: string
  caller_id?: string
  call_chain?: string[]
  depth?: number
  task: string
  status: 'completed' | 'failed' | 'running'
  current_tool?: string
  tool_preview?: string
  latency_ms?: number
  tools?: ToolActivity[]
  messages?: {
    role: string
    content?: string
    sender?: string
    tool_name?: string
    arguments?: Record<string, unknown>;
    output_preview?: string
  }[]
  result?: string
  error?: string
  phase?: string
  phase_name?: string
  elapsed_seconds?: number
  last_progress_at?: number
  token_count?: number
  tokens_per_second?: number
  tokens_per_second_approximate?: boolean
  eta_seconds?: number
  started_at?: number
  completed_at?: number
}

export type Attachment = {
  file_id: string
  filename: string
  content_type: string
  size: number
  url: string
  is_image: boolean
  extracted_text?: string | null
  extracted_text_preview?: string | null
  text_length?: number
}

export type UploadResponse = {
  ok: boolean
  file_id: string
  filename: string
  content_type: string
  size: number
  url: string
  is_image: boolean
  extracted_text_preview?: string | null
  extracted_text?: string | null
  text_length: number
}

export type BlackboardMessage = {
  id: string
  sender_id: string
  sender_name: string
  nickname: string
  role: 'leader' | 'expert' | string
  type: 'dispatch' | 'report' | 'error' | 'broadcast' | 'chat' | string
  content: string
  timestamp: number
  reply_to?: string | null
  metadata?: Record<string, unknown>
}

export type SharedCollaborationContextData = {
  root_invocation_id?: string
  session_id?: string
  overall_objective?: string
  delegation_path?: string[]
  subtasks?: SubagentCollaboration[]
  completed_reports?: Array<{
    task_id: string
    agent_id: string
    agent_name: string
    task: string
    summary: string
    result: string
    completed_at: number
  }>
  lineage?: Array<Record<string, unknown>>
  blackboard_messages?: BlackboardMessage[]
}

export type ChatResult = {
  invocation_id: string
  session_id: string
  status: string
  answer: string
  selected_agent: Agent | null
  candidates: Candidate[]
  failover_count: number
  latency_ms: number
  usage: { llm_calls: number; prompt_tokens: number; completion_tokens: number }
  result_data: {
    mode?: string
    bounty?: BountyBoardData
    runtime_tools?: ToolActivity[]
    tool_executions?: { name: string; arguments: Record<string, unknown>; output: unknown }[]
    contributions?: { agent_id: string; agent_name: string; text: string; data: Record<string, unknown> }[]
    collaborations?: SubagentCollaboration[]
    context?: { history_turns: number; history_messages: number; compressed_turns: number }
    shared_context?: SharedCollaborationContextData
    lineage?: Array<Record<string, unknown>>
    canvas?: {
      id: string
      title: string
      content: string
      version: number
      revisions: { version: number; editor_name: string; summary: string; created_at: string }[]
    }
  } | null
}

export type Policy = {
  name: string
  interop_compatibility: boolean
  external_delegation_enabled: boolean
  bounty_enabled?: boolean
  bounty_max_workers?: number
  bounty_max_items?: number
  bounty_lease_seconds?: number
  weights: Record<string, number>
  failure_threshold: number
  circuit_cooldown_seconds: number
  max_attempts: number
  request_timeout_seconds: number
}

export type BountyBoardData = {
  invocation_id: string
  closed: boolean
  partial?: boolean
  max_items: number
  items: Array<{
    id: string; title: string; task: string; acceptance: string; priority: number
    status: string; proposed_by: string; claimed_by: string; reviewed_by: string
    result: string; evidence: string[]; review_note: string
  }>
}

export type Trace = {
  id: string
  session_id: string
  query: string
  status: string
  selected_agent_id: string | null
  result_text: string | null
  result_data: {
    mode?: string
    tool_executions?: { name: string; arguments: Record<string, unknown>; output: unknown }[]
    contributions?: { agent_id: string; agent_name: string; text: string; data: Record<string, unknown> }[]
    context?: Record<string, unknown>
    shared_context?: { blackboard_messages?: Record<string, unknown>[] }
    canvas?: {
      id: string
      title: string
      content: string
      version: number
      revisions: { version: number; editor_name: string; summary: string; created_at: string }[]
    }
  } | null
  total_latency_ms: number
  attempt_count: number
  llm_calls: number
  prompt_tokens: number
  completion_tokens: number
  created_at: string
  finished_at: string | null
  attempts: {
    agent_id: string
    rank: number
    score: number
    state: string
    latency_ms: number | null
    error: string | null
    breakdown: Record<string, number>
  }[]
  events: { type: string; detail: Record<string, unknown>; created_at: string }[]
}
