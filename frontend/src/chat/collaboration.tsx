import { useMemo, useState } from "react";
import { createId } from "../randomId.mjs";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Copy,
  Flower2,
  GitBranch,
  Hash,
  Hourglass,
  Layers,
  Lock,
  Shield,
  Sparkles,
  Sun,
  Users,
} from "lucide-react";
import { FlowMark } from "../LoadingFlow";
import type { ChatMessage } from "../historyDocument";
import { BountyBoardView } from "../BountyBoard";
import { collaborationKey, mergeCollaborations, mergeSessionResults, mergeTools } from "../collaborationActivity";
import type { BlackboardMessage, ChatResult, SubagentCollaboration, ToolActivity } from "../types";
import { dispatchView, toolNames } from "../conciseGrouping";
import { formatRunDuration } from "./conciseTurn";
import { MarkdownText } from "./markdown";
import { formatMs } from "../format";

export function latestResult(messages: ChatMessage[]): ChatResult | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].result) return messages[index].result || null;
  }
  return null;
}

export type LiveSubagentState = {
  task_id?: string;
  agent_id: string;
  agent_name: string;
  caller_id?: string;
  call_chain?: string[];
  depth?: number;
  task: string;
  current_tool?: string;
  tool_preview?: string;
  status: "running" | "completed" | "error";
  error?: string;
  started_at?: number;
  completed_at?: number;
  latency_ms?: number;
  tools?: ToolActivity[];
  result?: string;
  phase_name?: string;
  tokens_per_second?: number;
  token_count?: number;
};

const SUBAGENT_PALETTES = [
  { icon: Flower2, color: "#ec4899", bg: "#fdf2f8" },
  { icon: Hourglass, color: "#0d9488", bg: "#f0fdfa" },
  { icon: Hash, color: "#8b5cf6", bg: "#f5f3ff" },
  { icon: Sparkles, color: "#f43f5e", bg: "#fff1f2" },
  { icon: Shield, color: "#6366f1", bg: "#eef2ff" },
  { icon: Layers, color: "#a855f7", bg: "#faf5ff" },
  { icon: Sun, color: "#eab308", bg: "#fefce8" },
  { icon: Bot, color: "#0ea5e9", bg: "#f0f9ff" },
];

function getSubagentPalette(index: number, name?: string) {
  if (name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash << 5) - hash + name.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % SUBAGENT_PALETTES.length;
    return SUBAGENT_PALETTES[idx];
  }
  return SUBAGENT_PALETTES[index % SUBAGENT_PALETTES.length];
}

function formatSubagentTime(startedAt?: number, completedAt?: number, latencyMs?: number): string {
  const ts = completedAt || startedAt;
  if (ts && ts > 0) {
    const timeMs = ts < 1e11 ? ts * 1000 : ts;
    const diffSec = Math.max(0, Math.floor((Date.now() - timeMs) / 1000));
    if (diffSec < 60) return "刚刚";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
    return `${Math.floor(diffSec / 86400)} 天前`;
  }
  if (latencyMs && latencyMs > 0) {
    return formatRunDuration(latencyMs);
  }
  return "完成";
}

export function handleSubagentEvent(
  event: any,
  setLiveSubagents: React.Dispatch<React.SetStateAction<Record<string, LiveSubagentState>>>,
  onNewRunning?: () => void,
  setLiveBlackboardMessages?: React.Dispatch<React.SetStateAction<BlackboardMessage[]>>,
) {
  if (event.type === "blackboard_message" && event.data && setLiveBlackboardMessages) {
    setLiveBlackboardMessages((prev) => [...prev, event.data]);
  }
  if (event.type === "subagent_start" && event.data) {
    const key =
      event.data.task_id ||
      (event.data.agent_id
        ? `${event.data.agent_id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        : createId());
    setLiveSubagents((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        task_id: event.data.task_id,
        agent_id: event.data.agent_id,
        agent_name: event.data.agent_name,
        caller_id: event.data.caller_id,
        call_chain: event.data.call_chain,
        depth: event.data.call_chain ? event.data.call_chain.length - 1 : undefined,
        task: event.data.task,
        status: prev[key]?.status && prev[key].status !== "running" ? prev[key].status : "running",
        started_at: prev[key]?.started_at || Date.now(),
        tools: prev[key]?.tools || [],
      },
    }));
    onNewRunning?.();
  } else if (event.type === "subagent_tool" && event.data) {
    setLiveSubagents((prev) => {
      const key =
        (event.data.task_id && prev[event.data.task_id] ? event.data.task_id : null) ||
        Object.keys(prev).find(
          (k) =>
            (event.data.task_id && prev[k].task_id === event.data.task_id) ||
            (prev[k].agent_id === event.data.agent_id && prev[k].status === "running"),
        ) ||
        event.data.task_id ||
        event.data.agent_id;
      if (!key || !prev[key]) return prev;
      const current = prev[key];
      const preview =
        typeof event.data.arguments === "object"
          ? JSON.stringify(event.data.arguments)
          : String(event.data.arguments || "");
      const tools = mergeTools(current.tools, [
        { id: event.data.tool_call_id, name: event.data.tool, arguments: event.data.arguments, status: "running", output_preview: "" },
      ]);
      return {
        ...prev,
        [key]: {
          ...current,
          current_tool: current.status === "running" ? tools.find(t => t.status === "running")?.name : undefined,
          tool_preview: preview,
          tools,
        },
      };
    });
  } else if (event.type === "subagent_tool_done" && event.data) {
    setLiveSubagents((prev) => {
      const key =
        (event.data.task_id && prev[event.data.task_id] ? event.data.task_id : null) ||
        Object.keys(prev).find(
          (k) =>
            (event.data.task_id && prev[k].task_id === event.data.task_id) ||
            (prev[k].agent_id === event.data.agent_id && prev[k].status === "running"),
        ) ||
        event.data.task_id ||
        event.data.agent_id;
      if (!key || !prev[key]) return prev;
      const current = prev[key];
      const tools = current.tools ? [...current.tools] : [];
      const index = tools.findIndex(t => event.data.tool_call_id ? t.id === event.data.tool_call_id :
        t.name === event.data.tool && t.status === "running");
      const done = { id: event.data.tool_call_id, name: event.data.tool, arguments: event.data.arguments,
        status: event.data.status || "completed", output_preview: event.data.output_preview };
      if (index < 0) tools.push(done);
      else tools[index] = { ...tools[index], ...done };
      return {
        ...prev,
        [key]: {
          ...current,
          current_tool: tools.find(t => t.status === "running")?.name,
          tool_preview: event.data.output_preview,
          tools,
        },
      };
    });
  } else if (event.type === "subagent_complete" && event.data) {
    setLiveSubagents((prev) => {
      const key =
        (event.data.task_id && prev[event.data.task_id] ? event.data.task_id : null) ||
        Object.keys(prev).find(
          (k) =>
            (event.data.task_id && prev[k].task_id === event.data.task_id) ||
            (prev[k].agent_id === event.data.agent_id && prev[k].status === "running"),
        ) ||
        event.data.task_id ||
        event.data.agent_id;
      if (!key || !prev[key]) return prev;
      const current = prev[key];
      return {
        ...prev,
        [key]: {
          ...current,
          status: "completed",
          caller_id: event.data.caller_id || current.caller_id,
          call_chain: event.data.call_chain || current.call_chain,
          depth: event.data.call_chain ? event.data.call_chain.length - 1 : current.depth,
          completed_at: event.data.completed_at
            ? (event.data.completed_at < 1e11 ? event.data.completed_at * 1000 : event.data.completed_at)
            : Date.now(),
          latency_ms: event.data.latency_ms || (current.started_at ? Date.now() - current.started_at : undefined),
          result: event.data.result || current.result,
        },
      };
    });
  } else if (event.type === "subagent_error" && event.data) {
    setLiveSubagents((prev) => {
      const key =
        (event.data.task_id && prev[event.data.task_id] ? event.data.task_id : null) ||
        Object.keys(prev).find(
          (k) =>
            (event.data.task_id && prev[k].task_id === event.data.task_id) ||
            (prev[k].agent_id === event.data.agent_id && prev[k].status === "running"),
        ) ||
        event.data.task_id ||
        event.data.agent_id;
      if (!key || !prev[key]) return prev;
      const current = prev[key];
      return {
        ...prev,
        [key]: {
          ...current,
          status: "error",
          completed_at: event.data.completed_at
            ? (event.data.completed_at < 1e11 ? event.data.completed_at * 1000 : event.data.completed_at)
            : Date.now(),
          error: event.data.error,
        },
      };
    });
  }
}

function ToolActivityList({ tools, toolNames = {} }: { tools: ToolActivity[]; toolNames?: Record<string, string> }) {
  return <div className="collab-tools-list">{tools.map((tool, index) => (
    <details className="collab-tool-item" key={tool.id || `${tool.name}-${index}`}>
      <summary className="collab-tool-head">
        <ChevronRight size={14} className="tool-trace-chevron" />
        <span className="tool-chip">{toolNames[tool.name] || tool.name}</span>
        <code>{tool.name}</code>
        <span className="collab-tool-status">{tool.status === "running" ? "进行中" : tool.status === "failed" ? "失败" : tool.status === "cancelled" ? "已中断" : "已完成"}</span>
      </summary>
      {tool.arguments && <pre className="collab-tool-args">{JSON.stringify(tool.arguments, null, 2)}</pre>}
      {tool.output_preview && <div className="collab-tool-preview"><span>输出摘要</span><p>{tool.output_preview}</p></div>}
    </details>
  ))}</div>;
}

function SubagentConversationView({
  collab,
  onBack,
  toolNames = {},
}: {
  collab: SubagentCollaboration;
  onBack: () => void;
  toolNames?: Record<string, string>;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!collab.result) return;
    navigator.clipboard.writeText(collab.result);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="subagent-dialogue-pane">
      <div className="subagent-dialogue-header">
        <button type="button" className="subagent-back-btn" onClick={onBack}>
          <ArrowLeft size={13} />
          <span>返回子智能体列表</span>
        </button>
        <div className="subagent-header-identity">
          <div className="collab-bot-avatar">
            <Bot size={15} />
          </div>
          <div className="collab-name-box">
            <strong>{collab.agent_name}</strong>
            <code>{collab.agent_id}</code>
          </div>
          <div className="subagent-header-status">
            <span className={`status-pill ${collab.status}`}>
              <span className={`pill-dot ${collab.status}`} />
              {collab.status === "completed"
                ? "已完成"
                : collab.status === "running"
                  ? "执行中"
                  : "执行异常"}
            </span>
            {collab.phase_name && (
              <span className="collab-phase-pill">{collab.phase_name}</span>
            )}
            {collab.tokens_per_second != null && (
              <span className="collab-speed-pill">
                {collab.tokens_per_second} tok/s{collab.tokens_per_second_approximate ? " (约)" : ""}
              </span>
            )}
            {collab.eta_seconds != null && (
              <span className="collab-eta-pill">
                预估剩余 {collab.eta_seconds}s
              </span>
            )}
            {collab.elapsed_seconds != null && (
              <span className="collab-elapsed-pill">
                耗时 {collab.elapsed_seconds}s
              </span>
            )}
            {collab.latency_ms != null && (
              <span className="collab-latency">{formatMs(collab.latency_ms)}</span>
            )}
          </div>
        </div>
      </div>

      <div className="subagent-dialogue-messages">
        {/* 协调器下发指令 */}
        <div className="subagent-msg-bubble user-task">
          <div className="subagent-msg-role" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
            <span>{collab.caller_id ? `派发来源 [${collab.caller_id}] · 任务指令` : "协调主智能体 · 任务派发"}</span>
            {collab.call_chain && collab.call_chain.length > 1 && (
              <span style={{ fontSize: "11px", fontWeight: 500, opacity: 0.85, background: "rgb(var(--accent-rgb) / 0.1)", padding: "1px 6px", borderRadius: 4 }}>
                调用链: {collab.call_chain.join(" → ")}
              </span>
            )}
          </div>
          <div className="subagent-task-content">
            <p>{collab.task}</p>
          </div>
        </div>

        {/* 实时工具调用状态 */}
        {collab.current_tool && (
          <div className="subagent-msg-bubble current-tool-live" style={{ padding: "8px 12px", background: "rgb(var(--accent-rgb) / 0.06)", border: "1px dashed rgb(var(--accent-rgb) / 0.25)", borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
              <FlowMark className="flow-mark-compact" />
              <span>正在调用工具：</span>
              <code style={{ fontSize: 11, background: "rgb(var(--accent-rgb) / 0.12)", padding: "2px 6px", borderRadius: 4 }}>
                {toolNames[collab.current_tool] || collab.current_tool}
              </code>
            </div>
            {collab.tool_preview && (
              <pre style={{ margin: "6px 0 0 0", fontSize: 11, color: "var(--muted)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {collab.tool_preview}
              </pre>
            )}
          </div>
        )}

        {/* 工具调用轨迹 */}
        {collab.tools && collab.tools.length > 0 && (
          <div className="subagent-tools-trajectory">
            <div className="subagent-tools-heading">
              <Sparkles size={12} />
              <span>工具调用轨迹 ({collab.tools.length})</span>
            </div>
            <ToolActivityList tools={collab.tools} toolNames={toolNames} />
          </div>
        )}

        {/* 子智能体回答 / 回传 */}
        <div className="subagent-msg-bubble assistant-response">
          <div className="subagent-msg-role">
            <div className="subagent-role-avatar">
              <Bot size={13} />
            </div>
            <span>{collab.agent_name}</span>
            {collab.result && (
              <button
                type="button"
                className="subagent-copy-btn"
                onClick={handleCopy}
                title="复制此回答"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                <span>{copied ? "已复制" : "复制"}</span>
              </button>
            )}
          </div>

          {collab.status === "running" ? (
            <div className="subagent-running-state">
              <span className="pulse" />
              <span>子智能体正在协同执行中，回传后将在此实时展示...</span>
            </div>
          ) : collab.result ? (
            <div className="subagent-response-markdown">
              <MarkdownText text={collab.result} />
            </div>
          ) : collab.error ? (
            <div className="collab-error-box">
              <p>{collab.error}</p>
            </div>
          ) : (
            <div className="inspector-empty">未产生回答内容</div>
          )}
        </div>
      </div>

      <div className="subagent-readonly-bar">
        <Lock size={12} className="lock-icon" />
        <span>协同智能体对话为只读视图，由主智能体调度管理，不可直接发言</span>
      </div>
    </div>
  );
}

function WorkflowGroupView({
  entry,
  onBack,
}: {
  entry: { title: string; steps: WorkflowStep[] };
  onBack: () => void;
}) {
  return (
    <div className="subagent-dialogue-pane">
      <div className="subagent-dialogue-header">
        <button type="button" className="subagent-back-btn" onClick={onBack}>
          <ArrowLeft size={13} />
          <span>返回会话列表</span>
        </button>
        <div className="subagent-header-identity">
          <div className="collab-bot-avatar" style={{ background: "rgb(var(--accent-rgb) / 0.12)", color: "var(--accent)" }}>
            <GitBranch size={15} />
          </div>
          <div className="collab-name-box">
            <strong>{entry.title}</strong>
            <code>串行工作流 · 共 {entry.steps.length} 棒</code>
          </div>
        </div>
      </div>
      <div className="subagent-dialogue-messages">
        {entry.steps.map((step, idx) => (
          <div key={idx} className="subagent-msg-bubble user-task" style={{ background: "var(--paper)" }}>
            <div className="subagent-msg-role" style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
              <span>第 {step.step || idx + 1} 棒 · {step.step_title || `阶段 ${idx + 1}`}</span>
              <span style={{ fontSize: 11, opacity: 0.8 }}>{step.agent || ""}</span>
            </div>
            <div className="subagent-task-content">
              <p>{step.result || "（未回传内容）"}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SwarmGroupView({
  entry,
  onBack,
}: {
  entry: { messages: BlackboardMessage[] };
  onBack: () => void;
}) {
  const members = new Map<string, string>();
  for (const msg of entry.messages) {
    if (!members.has(msg.sender_id)) {
      members.set(msg.sender_id, msg.nickname || `@${(msg.sender_name || msg.sender_id).replace("智能体", "").trim()}专家`);
    }
  }
  return (
    <div className="subagent-dialogue-pane">
      <div className="subagent-dialogue-header">
        <button type="button" className="subagent-back-btn" onClick={onBack}>
          <ArrowLeft size={13} />
          <span>返回会话列表</span>
        </button>
        <div className="subagent-header-identity">
          <div className="collab-bot-avatar" style={{ background: "rgb(var(--accent-rgb) / 0.12)", color: "var(--accent)" }}>
            <Users size={15} />
          </div>
          <div className="collab-name-box">
            <strong>集群群聊黑板</strong>
            <code>{entry.messages.length} 条发言 · {members.size} 位成员</code>
          </div>
        </div>
        <div className="collab-swarm-members">
          {[...members.entries()].map(([id, nickname]) => (
            <div key={id} className="collab-swarm-member-chip">
              <span>{nickname}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="subagent-dialogue-messages">
        {entry.messages.map((msg, idx) => {
          const isLeader = msg.role === "leader" || msg.sender_id === "leader";
          const palette = getSubagentPalette(idx, msg.sender_id || msg.sender_name);
          const Icon = isLeader ? Bot : palette.icon;
          const timeStr = msg.timestamp
            ? new Date(msg.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
            : "";
          return (
            <div key={msg.id || `msg-${idx}`} className="collab-chat-msg">
              <div
                className="collab-chat-avatar"
                style={{
                  backgroundColor: isLeader ? "rgb(var(--accent-rgb) / 0.12)" : palette.bg,
                  color: isLeader ? "var(--accent)" : palette.color,
                }}
              >
                <Icon size={14} />
              </div>
              <div className="collab-chat-main">
                <div className="collab-chat-header">
                  <span className="collab-chat-nickname">{msg.nickname}</span>
                  <span className={`collab-chat-role-badge ${isLeader ? "leader" : ""}`}>
                    {isLeader ? "主控协调" : "领域专家"}
                  </span>
                  <span className={`collab-chat-type-badge ${msg.type || "chat"}`}>
                    {msg.type === "dispatch"
                      ? "任务派发"
                      : msg.type === "report"
                        ? "成果汇报"
                        : msg.type === "error"
                          ? "异常警报"
                          : "集群广播"}
                  </span>
                  {timeStr && <span className="collab-chat-time">{timeStr}</span>}
                </div>
                <div className="collab-chat-bubble">{msg.content}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function dedupeCollabList(list: SubagentCollaboration[]): SubagentCollaboration[] {
  return mergeCollaborations(list);
}

function extractResultCollabs(res: ChatResult | null | undefined): SubagentCollaboration[] {
  if (!res) return [];
  const items: SubagentCollaboration[] = [];
  const seenTaskIds = new Set<string>();
  const seenAgentKeys = new Set<string>();

  const rawCollabs = res.result_data?.collaborations || [];
  for (const c of rawCollabs) {
    const key = c.task_id || `${c.agent_id || c.agent_name}-${c.task}`;
    if (!seenTaskIds.has(key)) {
      seenTaskIds.add(key);
      if (c.task_id) seenTaskIds.add(c.task_id);
      if (c.agent_id) seenAgentKeys.add(c.agent_id);
      if (c.agent_name) seenAgentKeys.add(c.agent_name);
      if (c.task) {
        if (c.agent_id) seenAgentKeys.add(`${c.agent_id}-${c.task}`);
        if (c.agent_name) seenAgentKeys.add(`${c.agent_name}-${c.task}`);
      }
      items.push({ ...c, invocation_id: c.invocation_id || res.invocation_id,
        session_id: c.session_id || res.session_id });
    }
  }

  // 仅当 collaborations 未覆盖某次 dispatch_task 时才作为后备补充
  const dispatches = (res.result_data?.tool_executions || []).filter(
    (item) => item.name === "dispatch_task",
  );
  for (const d of dispatches) {
    const view = dispatchView(d.output);
    const task = (d.arguments?.task as string) || "子任务";
    const agent = (d.arguments?.agent as string) || (d.arguments?.agent_id as string) || (d.arguments?.agent_name as string) || view.agent;
    const rawOut = (typeof d.output === "string"
      ? (() => { try { return JSON.parse(d.output as string); } catch { return {}; } })()
      : (d.output || {})) as Record<string, any>;
    const taskId =
      rawOut?.task_id ||
      rawOut?.result?.task_id ||
      (typeof rawOut?.result === "string" && (rawOut.result.startsWith("subtask_") || rawOut.result.startsWith("task-"))
        ? rawOut.result
        : undefined);

    if (taskId && seenTaskIds.has(taskId)) continue;
    if (!taskId && (seenAgentKeys.has(`${agent}-${task}`) || seenAgentKeys.has(`${view.agent}-${task}`))) {
      continue;
    }

    const alreadyHandled = items.some((it) => {
      if (taskId && it.task_id && it.task_id === taskId) return true;
      if (taskId && it.task_id) return false;
      const itAgent = it.agent_id || it.agent_name || "";
      const dAgent = agent || view.agent || "";
      if (itAgent && dAgent && itAgent !== "执行智能体" && dAgent !== "执行智能体") {
        if (itAgent === dAgent) {
          if (it.task === task) {
            return true;
          }
        }
      }
      return false;
    });
    if (alreadyHandled) continue;

    const key = taskId || `${agent}-${task}`;
    if (!seenTaskIds.has(key)) {
      seenTaskIds.add(key);
      if (agent) seenAgentKeys.add(agent);
      if (view.agent) seenAgentKeys.add(view.agent);
      seenAgentKeys.add(`${agent}-${task}`);
      const isErr = Boolean(rawOut?.error || rawOut?.result?.error);
      items.push({
        task_id: taskId,
        invocation_id: res.invocation_id,
        session_id: res.session_id,
        agent_id: agent,
        agent_name: view.agent,
        task,
        status: isErr ? "failed" : "completed",
        result: isErr ? undefined : view.text,
        error: isErr ? view.text : undefined,
      });
    }
  }

  // 仅当此前仍未覆盖时，再从 contributions 补充分散的智能体
  const contributions = res.result_data?.contributions || [];
  for (const c of contributions) {
    if (c.agent_id && seenAgentKeys.has(c.agent_id)) continue;
    if (c.agent_name && seenAgentKeys.has(c.agent_name)) continue;
    const key = `${c.agent_id}-${c.text?.slice(0, 30)}`;
    if (!seenTaskIds.has(key)) {
      seenTaskIds.add(key);
      items.push({
        invocation_id: res.invocation_id,
        session_id: res.session_id,
        agent_id: c.agent_id,
        agent_name: c.agent_name,
        task: "协同任务",
        status: "completed",
        result: c.text,
      });
    }
  }
  return dedupeCollabList(items);
}

type WorkflowStep = { step?: number; step_title?: string; agent?: string; result?: string };

type ListEntry =
  | { kind: "contact"; key: string; collab: SubagentCollaboration; timeText: string }
  | { kind: "workflow"; key: string; title: string; steps: WorkflowStep[] }
  | { kind: "swarm"; key: string; messages: BlackboardMessage[]; live?: boolean };

export function CollaborationPanel({
  inspector, messages = [], sessionResults = [], liveSubagents = [], toolNames = {},
}: {
  inspector: ChatResult | null;
  messages?: ChatMessage[];
  sessionResults?: ChatResult[];
  liveSubagents?: LiveSubagentState[];
  liveBlackboardMessages?: BlackboardMessage[];
  toolNames?: Record<string, string>;
}) {
  const [scope, setScope] = useState<"turn" | "all">("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const results = useMemo(() => {
    const sessionId = inspector?.session_id || sessionResults[0]?.session_id || latestResult(messages)?.session_id || "";
    return mergeSessionResults(sessionId, messages.flatMap(m => m.result ? [m.result] : []),
      inspector ? [inspector] : [], sessionResults);
  }, [messages, inspector, sessionResults]);
  const all = useMemo(() => mergeCollaborations([
    ...results.flatMap(extractResultCollabs),
    ...liveSubagents.map(s => ({ ...s, status: s.status === "error" ? "failed" : s.status } as SubagentCollaboration)),
  ]), [results, liveSubagents]);
  const currentIds = new Set([
    ...extractResultCollabs(inspector).map(collaborationKey),
    ...liveSubagents.map(s => collaborationKey(s as SubagentCollaboration)),
  ]);
  const shown = scope === "turn" ? all.filter(c => currentIds.has(collaborationKey(c))) : all;
  const selected = all.find(c => collaborationKey(c) === selectedKey);
  const rootTools = results.filter(r => scope === "all" || r.invocation_id === inspector?.invocation_id)
    .flatMap(r => r.result_data?.runtime_tools?.length ? r.result_data.runtime_tools :
      (r.result_data?.tool_executions || []).map((t, i) => ({
        id: `${r.invocation_id}:tool:${i}`, name: t.name, arguments: t.arguments, status: "completed",
        output_preview: typeof t.output === "string" ? t.output : JSON.stringify(t.output),
      })));
  if (selected) {
    return <SubagentConversationView collab={selected} onBack={() => setSelectedKey(null)} toolNames={toolNames} />;
  }
  return (
    <div className="collab-concise-panel">
      <div className="collab-overview-bar">
        <span>本会话协作 · {all.length} 个子任务</span>
        {results.length > 1 && <div className="collab-scope-switch">
          <button type="button" className={scope === "all" ? "collab-scope-btn active" : "collab-scope-btn"} onClick={() => setScope("all")}>本会话</button>
          <button type="button" className={scope === "turn" ? "collab-scope-btn active" : "collab-scope-btn"} onClick={() => setScope("turn")}>本轮</button>
        </div>}
      </div>
      {results.flatMap(r => {
        const board = r.result_data?.bounty;
        return board && (scope === "all" || r.invocation_id === inspector?.invocation_id)
          ? [<BountyBoardView key={r.invocation_id} board={board} />] : [];
      })}
      {shown.length === 0 && <div className="collab-empty">
        <Bot size={28} className="empty-icon" />
        <p>{scope === "turn" ? "本轮没有子任务" : "本会话暂无子智能体协作记录"}</p>
        <span>协作与工具记录按会话保存，完成或中断后仍可查看。</span>
      </div>}
      <div className="collab-workflow-container">
        {shown.map((c, index) => {
          const palette = getSubagentPalette(index, c.agent_id);
          const Icon = palette.icon;
          return <button key={collaborationKey(c)} type="button" className="collab-entry-row"
            onClick={() => setSelectedKey(collaborationKey(c))}>
            <div className="collab-concise-icon" style={{ color: palette.color, backgroundColor: palette.bg }}><Icon size={16} /></div>
            <div className="collab-entry-main">
              <div className="collab-entry-top"><strong>{c.agent_name || c.agent_id}</strong>
                <span className={c.status === "running" ? "collab-live-tag" : "collab-entry-time"}>
                  {c.status === "running" ? "执行中" : c.status === "completed" ? "已完成" : "未完成"}
                </span>
              </div>
              <span className="collab-entry-preview">{c.task}</span>
            </div>
            <ChevronRight size={15} />
          </button>;
        })}
      </div>
      {rootTools.length > 0 && <details className="session-tool-history">
        <summary><ChevronRight size={14} className="tool-trace-chevron" /><span>主智能体工具记录</span><span className="session-tool-count">{rootTools.length}</span></summary>
        <ToolActivityList tools={rootTools} toolNames={toolNames} />
      </details>}
    </div>
  );
}
