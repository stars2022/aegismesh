import {
  Children,
  cloneElement,
  createElement,
  FormEvent,
  isValidElement,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  BookOpen,
  Braces,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CirclePlus,
  Clock,
  Copy,
  Database,
  Eye,
  Flower2,
  Gauge,
  GitBranch,
  GripVertical,
  Hash,
  Hourglass,
  Layers,
  FileText,
  ListPlus,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Maximize2,
  MessageSquare,
  MessageSquareText,
  Network,
  Pencil,
  Play,
  Pin,
  Plus,
  Minus,
  Minimize2,
  Radio,
  Download,
  Globe,
  RefreshCw,
  ScanSearch,
  Route,
  Search,
  Send,
  ServerCog,
  Settings2,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  TerminalSquare,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Users,
  Wrench,
  X,
  Paperclip,
} from "lucide-react";
import { api, type CanvasDocument } from "./api";
import { FlowMark, LoadingFlow } from "./LoadingFlow";
import { DispatchCard } from "./DispatchCard";
const CanvasWorkspace = lazy(() => import("./CanvasWorkspace").then((module) => ({ default: module.CanvasWorkspace })));
import { hasCompletedTaskMessage, upsertRecoveredAssistant } from "./chatRecovery";
import { equalizeWeights, normalizeWeights, rebalanceWeights } from "./routingWeights";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Dropdown,
  EmptyState,
  MetricCard,
  ScoreBar,
  StatusDot,
  Switch,
} from "./components";
import { AgentPicker } from "./AgentPicker";
import { SchemaEditors, StructuredCapability, StructuredTaskControls, StructuredResult } from "./StructuredIO";
import { buildStructuredTask, inputValues, parseSchemaText, schemaText, taskSchemas } from "./structuredIOModel";
import type { StructuredTaskOptions } from "./types";
import { SidebarToggle, useCompactSidebar } from "./SidebarToggle";
import { WebSearchSettings } from "./WebSearchSettings";
import { AccountAdministration, QuotaAdministration } from "./AccountAdministration";
import { SidebarAccount } from "./SidebarAccount";
import { SettingsDialog, type SettingsSection } from "./SettingsDialog";
import { requestedSettings, workbenchAfterSettings } from "./accountNavigation";
import { conversationStorage, conversationStorageForOwner, getConversationOwner } from "./conversationStorage";
import { mergeConversationMeta, type ConversationMeta } from "./conversationHistory";
import { ConversationSync } from "./conversationSync";
import { mergeHistory, type Conversation, type ChatMessage, type QueuedTask, type GroupConfig } from "./historyDocument";
import { BountyBoardView } from "./BountyBoard";
import { defaultCoordinatorId } from "./agentMenu";
import { collaborationKey, mergeCollaborations, mergeSessionResults, mergeTools } from "./collaborationActivity";
import {
  applyTheme,
  estimateTokens,
  loadSettings,
  saveSettings,
  type UserSettings,
} from "./settings";
import type {
  Agent,
  Attachment,
  BlackboardMessage,
  ChatResult,
  DashboardData,
  Policy,
  ProbeResult,
  Provider,
  SharedCollaborationContextData,
  Skill,
  SubagentCollaboration,
  ToolActivity,
  Trace,
} from "./types";
import {
  buildTurnActions,
  dispatchView,
  getToolSubtitle,
  partitionTurnActions,
  toolNames,
  type TurnAction,
  type TurnActionBlock,
} from "./conciseGrouping";
import { LogCenter } from "./LogCenter";

type View =
  | "overview"
  | "studio"
  | "providers"
  | "routing"
  | "probes"
  | "traces"
  | "logs"
  | "accounts"
  | "quotas"
  | "access";

const navigation: { id: View; label: string; icon: typeof LayoutDashboard }[] =
  [
    { id: "overview", label: "概览", icon: LayoutDashboard },
    { id: "studio", label: "智能体管理", icon: Bot },
    { id: "providers", label: "模型供应商", icon: ServerCog },
    { id: "routing", label: "路由策略", icon: Route },
    { id: "probes", label: "智能体探针", icon: ScanSearch },
    { id: "traces", label: "运行记录", icon: Activity },
    { id: "logs", label: "日志与审计", icon: FileText },
    { id: "accounts", label: "账号管理", icon: Users },
    { id: "quotas", label: "配额管理", icon: Gauge },
    { id: "access", label: "访问与数据", icon: ShieldCheck },
  ];

const titles: Record<View, string> = {
  overview: "运行概览",
  studio: "智能体管理",
  providers: "模型供应商",
  routing: "路由策略",
  probes: "智能体探针",
  traces: "运行记录",
  logs: "日志与审计",
  accounts: "账号管理",
  quotas: "配额管理",
  access: "访问与数据",
};

const stateNames: Record<string, string> = {
  online: "在线",
  offline: "离线",
  unknown: "未知",
  degraded: "受限",
  healthy: "健康",
  completed: "已完成",
  failed: "失败",
  working: "运行中",
  closed: "正常",
  open: "暂停编排",
  "half-open": "正在测试模型稳定程度",
};
const ATTEMPT_STATE_LABELS: Record<string, string> = {
  selected: "已选中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timeout: "超时",
};
const transportNames: Record<string, string> = {
  provider: "模型服务",
  "aip-rpc": "AIP 直连",
  "openai-compatible": "兼容接口",
  "openai-responses": "Responses 接口",
  "anthropic-messages": "Messages 接口",
};
const metricLabels: Record<string, string> = {
  skill: "匹配程度",
  reliability: "历史可靠性",
  feedback: "用户反馈",
  latency: "响应延迟",
  load: "实时负载",
  health: "健康状态",
  cost: "成本",
};

function formatDetailValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const traceDetailLabels: Record<string, string> = {
  agent_id: "智能体",
  agent_name: "智能体",
  candidate_count: "候选数",
  attempt: "第几次尝试",
  latency_ms: "耗时",
  task_id: "任务",
  tool_name: "工具",
  mode: "模式",
  reason: "原因",
  error: "错误",
};

function formatTraceTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function summarizeTraceDetail(detail: Record<string, unknown>): string {
  const hiddenKeys = new Set([
    "prompt",
    "query",
    "result",
    "result_text",
    "response",
    "output",
    "arguments",
    "context",
  ]);
  const parts = Object.entries(detail)
    .filter(([key, value]) => !hiddenKeys.has(key) && value != null && typeof value !== "object")
    .slice(0, 3)
    .map(([key, value]) => {
      const formatted = key === "latency_ms" && typeof value === "number"
        ? formatMs(value)
        : formatDetailValue(value);
      return `${traceDetailLabels[key] || key}：${formatted}`;
    });
  return parts.join(" · ") || "阶段已完成";
}

const eventNames: Record<string, string> = {
  REQUEST_ACCEPTED: "收到任务",
  CONTEXT_LOADED: "载入上下文",
  CANDIDATES_SCORED: "完成评分",
  AGENT_SELECTED: "选择智能体",
  PARTNER_FAILED: "执行失败",
  FAILOVER_STARTED: "开始迁移",
  TASK_COMPLETED: "任务完成",
  TASK_FAILED: "任务失败",
  NO_ELIGIBLE_AGENT: "无可用智能体",
  COLLABORATION_STARTED: "开始协作",
  COLLABORATION_COMPLETED: "协作完成",
  COORDINATION_STARTED: "开始协调",
  DISPATCH_STARTED: "派发子任务",
  SUBAGENT_TASK_RECEIVED: "子智能体接收任务",
  SUBAGENT_TOOL_CALLED: "子智能体调用工具",
  SUBAGENT_TOOL_COMPLETED: "子智能体工具完成",
  SUBAGENT_COMPLETED: "子智能体执行完成",
  SUBAGENT_FAILED: "子智能体执行失败",
  DISPATCH_COMPLETED: "子任务完成",
  COORDINATION_FALLBACK: "协调转广播",
};

function formatMs(value: number) {
  return value >= 1000
    ? `${(value / 1000).toFixed(1)} s`
    : `${Math.round(value)} ms`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(timestamp?: number): string {
  if (!timestamp) return "刚刚";
  const ms = timestamp > 1e11 ? timestamp : timestamp * 1000;
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return new Date(ms).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function App({ onLogout }: { onLogout?: () => void }) {
  const [view, setView] = useState<View>(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    return navigation.find(item => item.id === tab)?.id || "overview";
  });
  const [logsRefresh, setLogsRefresh] = useState(0);
  const [accountsRefresh, setAccountsRefresh] = useState(0);
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", view);
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [view]);
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const adminNav = useRef<HTMLElement>(null);
  useEffect(() => {
    adminNav.current?.querySelector("button.active")?.scrollIntoView({ block: "nearest" });
  }, [view, mobileNav, sidebarCollapsed]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [probes, setProbes] = useState<ProbeResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [
        nextDashboard,
        nextAgents,
        nextProviders,
        nextPolicy,
        nextTraces,
        nextProbes,
      ] = await Promise.all([
        api.dashboard(),
        api.agents(),
        api.providers(),
        api.policy(),
        api.traces(),
        api.probes(),
      ]);
      setDashboard(nextDashboard);
      setAgents(nextAgents);
      setProviders(nextProviders);
      setPolicy(nextPolicy);
      setTraces(nextTraces);
      setProbes(nextProbes);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "连接失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className={`app-shell design-next ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <Network size={18} />
          </div>
          <div className="brand-copy">
            <strong>AegisMesh</strong>
          </div>
          <SidebarToggle
            className="sidebar-collapse"
            side="left"
            expanded={!sidebarCollapsed}
            label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
            onClick={() => setSidebarCollapsed((value) => !value)}
          />
        </div>
        <button
          className="new-agent-button"
          onClick={() => {
            setView("studio");
            setMobileNav(false);
          }}
        >
          <CirclePlus size={17} /> 新建智能体 <span>⌘ N</span>
        </button>
        <nav ref={adminNav}>
          <div className="nav-label">工作区</div>
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={view === item.id ? "active" : ""}
                onClick={() => {
                  setView(item.id);
                  setMobileNav(false);
                }}
              >
                <Icon size={17} />
                {item.label}
                {item.id === "traces" && traces.length > 0 && (
                  <b>{traces.length}</b>
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="system-card">
          <div>
            <StatusDot status={error ? "offline" : "online"} />
            {error ? "API 未连接" : "系统运行中"}
          </div>
          <span>
            {agents.filter((agent) => agent.health === "online").length}{" "}
            个智能体在线
          </span>
        </div>
        <div className="profile-row">
          <div className="avatar">AM</div>
          <div>
            <strong>工作区</strong>
            <span>管理空间</span>
          </div>
          {onLogout ? (
            <button onClick={onLogout} title="退出登录">
              <LogOut size={15} />
            </button>
          ) : (
            <Settings2 size={16} />
          )}
        </div>
      </aside>
      {mobileNav && (
        <button className="nav-backdrop" onClick={() => setMobileNav(false)} />
      )}

      <main className="main-panel">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => { setSidebarCollapsed(false); setMobileNav(true); }}>
            <Menu size={20} />
          </button>
          <div>
            <h1>{titles[view]}</h1>
          </div>
          <div className="topbar-actions">
            <button
              className="icon-button"
              onClick={() => view === "logs" ? setLogsRefresh(value => value + 1) : ["accounts", "quotas"].includes(view) ? setAccountsRefresh(value => value + 1) : void load()}
              title="刷新"
            >
              {loading ? <FlowMark className="flow-mark-compact" /> : <RefreshCw size={17} />}
            </button>
            <a className="primary-small" href="/" aria-label="打开聊天" title="打开聊天">
              <Play size={15} fill="currentColor" />
              <span>打开聊天</span>
            </a>
          </div>
        </header>
        {error && (
          <div className="connection-banner">
            <span>{error}</span>
            <button onClick={() => void load()}>重新连接</button>
          </div>
        )}
        <div className="page-content">
          {view === "overview" && (
            <Overview
              dashboard={dashboard}
              agents={agents}
              traces={traces}
              loading={loading}
              onNavigate={(tab) => setView(tab)}
            />
          )}
          {view === "studio" && (
            <Studio agents={agents} providers={providers} onChanged={load} />
          )}
          {view === "providers" && (
            <Providers providers={providers} agents={agents} onChanged={load} />
          )}
          {view === "routing" && policy && (
            <Routing policy={policy} agents={agents} onSaved={load} />
          )}
          {view === "probes" && (
            <Probes agents={agents} probes={probes} onRun={load} />
          )}
          {view === "traces" && <Traces traces={traces} />}
          {view === "logs" && <LogCenter refreshKey={logsRefresh} />}
          {view === "accounts" && <AccountAdministration refreshKey={accountsRefresh} />}
          {view === "quotas" && <QuotaAdministration refreshKey={accountsRefresh} />}
          {view === "access" && <AccessControl />}
        </div>
      </main>
    </div>
  );
}

function Overview({
  dashboard,
  agents,
  traces,
  loading,
  onNavigate,
}: {
  dashboard: DashboardData | null;
  agents: Agent[];
  traces: Trace[];
  loading: boolean;
  onNavigate?: (tab: View) => void;
}) {
  if (!dashboard && loading) return <PageSkeleton />;
  if (!dashboard) return <EmptyState>暂无统计数据</EmptyState>;
  const activity = dashboard.recent_activity;
  const maxLatency = Math.max(...activity.map((item) => item.latency_ms), 1);
  return (
    <div className="overview-grid">
      <section className="metric-grid">
        <MetricCard
          label="在线智能体"
          value={`${dashboard.online_agents}/${dashboard.agents}`}
          note={`${dashboard.roles.leaders} 个协调型 · ${dashboard.roles.partners} 个执行型`}
        />
        <MetricCard
          label="任务成功率"
          value={
            dashboard.success_rate === null ? "—" : `${dashboard.success_rate}%`
          }
          note={`${dashboard.requests} 次运行`}
        />
        <MetricCard
          label="平均延迟"
          value={dashboard.requests ? formatMs(dashboard.avg_latency_ms) : "—"}
          note="端到端"
        />
        <MetricCard
          label="自动迁移"
          value={dashboard.failovers}
          note="任务连续性"
        />
      </section>

      <section className="panel activity-panel">
        <div className="panel-heading">
          <h2>协作活动</h2>
          <span className="period-chip">实时</span>
        </div>
        <div className="latency-chart">
          <div className="chart-grid-lines">
            <span />
            <span />
            <span />
          </div>
          {activity.map((item) => (
            <div
              className="latency-column"
              key={item.id}
              title={`${formatMs(item.latency_ms)} · ${item.attempts} 次尝试`}
            >
              <span
                className={item.attempts > 1 ? "failover" : ""}
                style={{ height: `${(item.latency_ms / maxLatency) * 90}%` }}
              />
            </div>
          ))}
          {activity.length === 0 && (
            <EmptyState>完成任务后显示延迟数据</EmptyState>
          )}
        </div>
        <div className="chart-legend">
          <span>
            <i />
            直接完成
          </span>
          <span>
            <i className="amber" />
            发生迁移
          </span>
        </div>
      </section>

      <section className="panel distribution-panel">
        <div className="panel-heading">
          <h2>智能体使用</h2>
          <ChartNoAxesCombined size={18} />
        </div>
        <div className="usage-list">
          {dashboard.agent_usage.map((item, index) => (
            <div className="usage-row" key={item.id}>
              <span className="usage-index">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <strong>{item.name}</strong>
                <ScoreBar
                  value={item.count}
                  max={Math.max(
                    ...dashboard.agent_usage.map((entry) => entry.count),
                    1,
                  )}
                />
              </div>
              <b>{item.count}</b>
            </div>
          ))}
          {dashboard.agent_usage.length === 0 && (
            <EmptyState>暂无智能体使用数据</EmptyState>
          )}
        </div>
      </section>

      <section className="panel fleet-panel">
        <div className="panel-heading">
          <h2>智能体集群</h2>
          <button
            type="button"
            className="text-button"
            onClick={() => onNavigate?.("studio")}
            title="进入智能体管理工作台"
          >
            查看全部 <ArrowRight size={14} />
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>角色</th>
                <th>状态</th>
                <th>模型 / 运行底座</th>
                <th>成功率</th>
                <th>延迟</th>
                <th>并发负载</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr
                  key={agent.id}
                  onClick={() => onNavigate?.("studio")}
                  style={{ cursor: "pointer" }}
                  title="点击查看智能体详情与配置"
                >
                  <td>
                    <div className="agent-cell">
                      <span className="agent-glyph">
                        {agent.name.slice(0, 1)}
                      </span>
                      <div>
                        <strong>{agent.name}</strong>
                        <span>{agent.skills[0]?.name || "通用技能"}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="role-pill">
                      {agent.role === "leader" ? "协调型" : "执行型"}
                    </span>
                  </td>
                  <td>
                    <span className="inline-status">
                      <StatusDot status={agent.health} />
                      {stateNames[agent.health] || agent.health}
                    </span>
                  </td>
                  <td>
                    {agent.transport === "aip-rpc" ? (
                      <span
                        className="role-pill"
                        style={{
                          fontSize: "11px",
                          background: "rgba(2, 132, 199, 0.08)",
                          color: "#0284c7",
                          border: "1px solid rgba(2, 132, 199, 0.2)",
                        }}
                      >
                        AIP 远端服务
                      </span>
                    ) : agent.model_name ? (
                      <span style={{ fontSize: "12px", fontFamily: "var(--font-mono, monospace)" }}>
                        {agent.model_provider ? `${agent.model_provider} · ` : ""}
                        {agent.model_name}
                      </span>
                    ) : agent.model_provider ? (
                      <span style={{ fontSize: "12px" }}>{agent.model_provider}</span>
                    ) : (
                      <span style={{ color: "var(--c85857f)" }}>—</span>
                    )}
                  </td>
                  <td>
                    {agent.request_count
                      ? `${Math.round((agent.success_count / agent.request_count) * 100)}%`
                      : "待调用"}
                  </td>
                  <td>
                    {agent.avg_latency_ms
                      ? formatMs(agent.avg_latency_ms)
                      : "待探测"}
                  </td>
                  <td>
                    {agent.active_tasks > 0 ? (
                      <span style={{ color: "#d97706", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "4px" }}>
                        ⚡ {agent.active_tasks} 运行中
                      </span>
                    ) : (
                      <span style={{ color: "var(--c85857f)", fontSize: "12px" }}>
                        待命 (0 活跃)
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {agents.length === 0 && (
            <EmptyState>创建或接入智能体后显示</EmptyState>
          )}
        </div>
      </section>

      <section className="panel recent-panel">
        <div className="panel-heading">
          <h2>最近运行</h2>
          <Activity size={18} />
        </div>
        <div className="recent-list">
          {traces.slice(0, 5).map((trace) => (
            <div className="recent-row" key={trace.id}>
              <StatusDot status={trace.status} />
              <div>
                <strong>{trace.query}</strong>
                <span>
                  {trace.selected_agent_id || "等待路由"} ·{" "}
                  {formatMs(trace.total_latency_ms)}
                </span>
              </div>
              <span>
                {new Date(trace.created_at).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          ))}
          {traces.length === 0 && (
            <EmptyState>运行一次任务后显示记录</EmptyState>
          )}
        </div>
      </section>
    </div>
  );
}

function declaredGroup(source: {
  group?: boolean;
  capabilities?: { messageQueue?: unknown[] };
  raw_acs?: { capabilities?: { messageQueue?: unknown[] }; endPoints?: { url?: string }[] };
  endPoints?: { url?: string }[];
}): boolean {
  const queue = source.capabilities?.messageQueue || source.raw_acs?.capabilities?.messageQueue || [];
  const endpoints = source.endPoints || source.raw_acs?.endPoints || [];
  return Boolean(source.group) || queue.length > 0 || endpoints.some((item) => String(item?.url || "").startsWith("amqps://"));
}

function channelFacts(agent: {
  registration_status?: string;
  transport?: string;
  streaming_enabled?: boolean;
  notification_enabled?: boolean;
  group_enabled?: boolean;
}): { label: string; value: string }[] {
  const remote = agent.registration_status === "imported" || agent.transport === "aip-rpc";
  return [
    {
      label: "流式",
      value: agent.streaming_enabled
        ? remote ? "对方已声明，调用走 SSE" : "本平台已开启"
        : remote ? "对方未声明，调用走轮询" : "本平台已关闭",
    },
    {
      label: "通知",
      value: agent.notification_enabled
        ? remote ? "对方已声明；未配公网回调时仍轮询" : "本平台在身份绑定与 mTLS 入口开启后可接收"
        : remote ? "对方未声明" : "本平台在身份绑定与 mTLS 入口开启后可接收",
    },
    {
      label: "群组",
      value: agent.group_enabled ? "对方已声明 AMQP，本平台未接入" : "未接入",
    },
  ];
}

const regNames: Record<string, string> = {
  local: "本地",
  imported: "已固定",
  draft: "草稿",
  pending: "待审核",
  approved: "已注册",
  rejected: "已驳回",
};

function Studio({
  agents,
  providers,
  onChanged,
}: {
  agents: Agent[];
  providers: Provider[];
  onChanged: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<"all" | "leader" | "partner" | "adp">("all");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [showAdpFeed, setShowAdpFeed] = useState(false);
  const [adpAgents, setAdpAgents] = useState<any[]>([]);
  const [adpLoading, setAdpLoading] = useState(false);
  const [adpError, setAdpError] = useState("");
  const [pinningAic, setPinningAic] = useState("");
  const [selectedExternal, setSelectedExternal] = useState<any | null>(null);
  const discoveryRequest = useRef(0);

  const loadAdpFeed = async (refresh = false, searchQuery = query) => {
    const requestId = ++discoveryRequest.current;
    setAdpLoading(true);
    setAdpError("");
    try {
      const items = await api.discoveryFeed(refresh, searchQuery);
      if (requestId !== discoveryRequest.current) return;
      setAdpAgents(items || []);
    } catch (err) {
      if (requestId !== discoveryRequest.current) return;
      setAdpError(err instanceof Error ? err.message : "获取全网智能体失败");
      setAdpAgents([]);
    } finally {
      if (requestId === discoveryRequest.current) setAdpLoading(false);
    }
  };

  const handleToggleFeed = (checked: boolean) => {
    setShowAdpFeed(checked);
    if (!checked && role === "adp") setRole("all");
  };

  useEffect(() => {
    ++discoveryRequest.current;
    if (!showAdpFeed && role !== "adp") return;
    setAdpLoading(true);
    setAdpAgents([]);
    const timer = window.setTimeout(() => { void loadAdpFeed(false, query); }, 300);
    return () => { window.clearTimeout(timer); ++discoveryRequest.current; };
  }, [showAdpFeed, role, query]);

  const handleQuickPin = async (ext: any) => {
    setPinningAic(ext.aic);
    try {
      const endpoint =
        ext.endPoints?.find((ep: any) => ep.url?.startsWith("https://"))?.url ||
        ext.endPoints?.[0]?.url ||
        ext.endpoint_url ||
        "";
      await api.importDiscoveredAgent({
        aic: ext.aic,
        name: ext.name,
        description: ext.description,
        endpoint,
        transport: ext.transport || "aip-rpc",
        skills: ext.skills || [],
        streaming: Boolean(ext.streaming ?? ext.capabilities?.streaming ?? ext.raw_acs?.capabilities?.streaming),
        notification: Boolean(ext.notification ?? ext.capabilities?.notification ?? ext.raw_acs?.capabilities?.notification),
        alive: typeof ext.alive === "boolean" ? ext.alive : undefined,
        group: declaredGroup(ext),
      });
      await onChanged();
      setRegNotice(`已成功将外部智能体「${ext.name}」固定到本地协作网`);
    } catch (err) {
      setRegNotice(err instanceof Error ? err.message : "固定到本地失败");
    } finally {
      setPinningAic("");
    }
  };

  const [regBusy, setRegBusy] = useState("");
  const [regNotice, setRegNotice] = useState("");
  const [previewAgent, setPreviewAgent] = useState<Agent | null>(null);
  const [previewData, setPreviewData] = useState<{
    acs: Record<string, unknown>;
    target_registry: string;
    registry_username: string;
    public_rpc_url: string;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const openRegisterPreview = async (agent: Agent) => {
    setRegNotice("");
    setPreviewAgent(agent);
    setPreviewLoading(true);
    setPreviewData(null);
    try {
      const data = await api.agentAcsPreview(agent.id);
      setPreviewData(data);
    } catch (reason) {
      setRegNotice(reason instanceof Error ? reason.message : "获取提审概览失败");
      setPreviewAgent(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const confirmRegister = async () => {
    if (!previewAgent) return;
    const target = previewAgent;
    if (await register(target)) {
      setPreviewAgent(null);
      setPreviewData(null);
    }
  };

  const register = async (agent: Agent) => {
    setRegBusy(agent.id);
    setRegNotice("");
    try {
      await api.registerAgent(agent.id);
      await onChanged();
      setRegNotice(`${agent.name} 已提交注册审核`);
      return true;
    } catch (reason) {
      setRegNotice(reason instanceof Error ? reason.message : "提交注册失败");
      return false;
    } finally {
      setRegBusy("");
    }
  };
  const syncRegistration = async (agent: Agent) => {
    setRegBusy(agent.id);
    setRegNotice("");
    try {
      const next = await api.syncRegistration(agent.id);
      await onChanged();
      setRegNotice(
        `${agent.name} 审核状态：${regNames[next.registration_status] || next.registration_status}`,
      );
    } catch (reason) {
      setRegNotice(reason instanceof Error ? reason.message : "同步失败");
    } finally {
      setRegBusy("");
    }
  };
  const issueCertificate = async (agent: Agent) => {
    setRegBusy(agent.id);
    setRegNotice("");
    try {
      await api.issueCertificate(agent.id);
      await onChanged();
      setRegNotice(`${agent.name} 证书已签发`);
    } catch (reason) {
      setRegNotice(reason instanceof Error ? reason.message : "证书签发失败");
    } finally {
      setRegBusy("");
    }
  };
  const handleDeleteAgent = async (agent: Agent) => {
    if (agent.role === "leader" && agents.filter((a) => a.role === "leader").length <= 1) {
      alert("系统必须至少保留一个协调型主智能体 (Leader)，无法删除。");
      return;
    }
    const confirmMsg = agent.role === "partner"
      ? `确定要删除智能体「${agent.name}」吗？`
      : `确定要删除智能体「${agent.name}」吗？该操作将解除相关协同配置。`;
    if (!window.confirm(confirmMsg)) {
      return;
    }
    setRegBusy(agent.id);
    setRegNotice("");
    try {
      await api.deleteAgent(agent.id);
      await onChanged();
      setRegNotice(`已删除智能体「${agent.name}」`);
    } catch (reason) {
      setRegNotice(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setRegBusy("");
    }
  };
  const localFiltered = agents.filter(
    (agent) =>
      !showAdpFeed &&
      role !== "adp" &&
      (role === "all" || agent.role === role) &&
      `${agent.name} ${agent.description} ${agent.skills.map((skill) => skill.name).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );

  const adpFiltered = (showAdpFeed || role === "adp")
    ? adpAgents.filter((ext) => {
        if (role === "leader" || role === "partner") return ext.score?.role === role;
        return true;
      })
    : [];

  return (
    <div className="tab-panel">
      <div className="studio-toolbar">
        <div className="studio-toolbar-primary">
          <div className="segmented studio-role-tabs">
            <button
              className={role === "all" ? "active" : ""}
              onClick={() => setRole("all")}
            >
              全部
            </button>
            <button
              className={role === "leader" ? "active" : ""}
              onClick={() => setRole("leader")}
            >
              主智能体
            </button>
            <button
              className={role === "partner" ? "active" : ""}
              onClick={() => setRole("partner")}
            >
              协同智能体
            </button>
            <button
              className={role === "adp" ? "active" : ""}
              onClick={() => {
                setRole("adp");
                if (!showAdpFeed) void handleToggleFeed(true);
              }}
            >
              全网发现
            </button>
          </div>
          <div className="studio-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setDiscoveryOpen(true)}
              title="通过官方 ADP 发现服务检索并接入智能体"
            >
              <Radio size={14} />
              发现智能体
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                const target = agents.find((a) => a.role === "leader") || agents[0];
                if (target) void openRegisterPreview(target);
              }}
              title="查看并提交智能体注册信息"
            >
              <ShieldCheck size={14} />
              注册提审
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setSelected(null);
                setBuilderOpen(true);
              }}
            >
              <CirclePlus size={16} />
              创建智能体
            </button>
          </div>
        </div>
        <div className="studio-toolbar-secondary">
          <label className="search-field">
            <Search size={15} />
            <input
              aria-label="搜索智能体"
              placeholder="搜索名称、能力或工具"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className={`adp-feed-control ${showAdpFeed ? "active" : ""}`}>
            <Switch
              checked={showAdpFeed}
              onChange={(val) => handleToggleFeed(val)}
            />
            <button
              type="button"
              className="adp-feed-label"
              onClick={() => handleToggleFeed(!showAdpFeed)}
            >
              <Globe size={14} />
              <span>全网发现池</span>
              {showAdpFeed && adpAgents.length > 0 && (
                <b>{adpAgents.length}</b>
              )}
            </button>
            {showAdpFeed && (
              <button
                type="button"
                className="adp-refresh"
                onClick={() => void loadAdpFeed(true)}
                disabled={adpLoading}
                title="刷新发现池"
                aria-label="刷新发现池"
              >
                {adpLoading ? <FlowMark className="flow-mark-compact" /> : <RefreshCw size={13} />}
              </button>
            )}
          </div>
        </div>
      </div>
      {regNotice && <div className="studio-notice">{regNotice}</div>}
      {(showAdpFeed || role === "adp") && (
        <div className="studio-notice" role="status">
          {adpError || (adpLoading ? "正在查询官方发现服务…" : "候选来自官方发现服务 · 按 AIC 关联本地历史评分排序 · 缓存仅用于展示")}
        </div>
      )}
      <div className="agent-grid">
        {localFiltered.map((agent) => (
          <article
            className="agent-card"
            key={agent.id}
            onClick={() => {
              setSelected(agent);
              setBuilderOpen(true);
            }}
          >
            <div className="agent-card-top">
              <span className="agent-glyph large">
                {agent.name.slice(0, 1)}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto" }}>
                <span className="inline-status">
                  <StatusDot status={agent.health} />
                  {agent.health}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  title="删除智能体"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDeleteAgent(agent);
                  }}
                  style={{
                    color: "var(--c777771)",
                    padding: "3px",
                    borderRadius: "4px",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  disabled={regBusy === agent.id}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            <div>
              <span className="eyebrow">{agent.role}</span>
              <h3>{agent.name}</h3>
              <p>{agent.description}</p>
            </div>
            <div className="tag-row">
              {channelFacts(agent).map((fact) => (
                <span key={fact.label} title={fact.value}>{fact.label}：{fact.value}</span>
              ))}
              {agent.skills.slice(0, 2).map((skill) => (
                <span key={skill.id}>{skill.name}</span>
              ))}
              {agent.tools.slice(0, 1).map((tool) => (
                <span key={tool}>{tool}</span>
              ))}
            </div>
            <div className="agent-card-stats">
              <div>
                <span>可靠性</span>
                <strong>
                  {agent.request_count
                    ? `${Math.round((agent.success_count / agent.request_count) * 100)}%`
                    : "—"}
                </strong>
              </div>
              <div>
                <span>平均延迟</span>
                <strong>
                  {agent.avg_latency_ms ? formatMs(agent.avg_latency_ms) : "—"}
                </strong>
              </div>
              <div>
                <span>模型</span>
                <strong>{agent.model_provider || "—"}</strong>
              </div>
            </div>
            <div className="agent-card-reg">
              <span className={`reg-pill ${agent.registration_status}`}>
                {regNames[agent.registration_status] ||
                  agent.registration_status}
              </span>
              {agent.transport === "aip-rpc" && agent.usage_mode === "external" ? (
                <span className="reg-pill imported">仅手动调用</span>
              ) : null}
              <div className="reg-actions">
                {agent.registration_agent_id ? (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void syncRegistration(agent);
                    }}
                    disabled={regBusy === agent.id}
                  >
                    {regBusy === agent.id ? <FlowMark className="flow-mark-compact" /> : <RefreshCw size={11} />}
                    同步审核
                  </button>
                ) : null}
                {["local", "draft", "rejected"].includes(
                  agent.registration_status,
                ) ? (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void openRegisterPreview(agent);
                    }}
                    disabled={regBusy === agent.id}
                  >
                    <ScanSearch size={11} />
                    提交验证
                  </button>
                ) : null}
                {["approved", "imported"].includes(agent.registration_status) &&
                !agent.certificate_issued_at ? (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void issueCertificate(agent);
                    }}
                    disabled={regBusy === agent.id}
                  >
                    <ShieldCheck size={11} />
                    签发证书
                  </button>
                ) : null}
                {agent.certificate_issued_at ? (
                  <span className="certificate-ready">
                    <Check size={11} />
                    证书有效
                  </span>
                ) : null}
              </div>
            </div>
          </article>
        ))}

        {adpFiltered.map((ext) => (
          <article
            className="agent-card external-adp-card"
            key={ext.aic}
            onClick={() => setSelectedExternal(ext)}
          >
            <div className="agent-card-top">
              <span className="agent-glyph large">
                <Globe size={22} />
              </span>
              <span className="inline-status">
                {ext.alive === false ? "发现记录为离线" : ext.alive === true ? "发现记录为存活" : "存活状态未知"}
              </span>
            </div>
            <div>
              <span className="eyebrow">
                {ext.organization || "全网外部节点"} · {ext.transport}
              </span>
              <h3>{ext.name}</h3>
              <p style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {ext.description || "暂无描述"}
              </p>
            </div>
            <div className="tag-row">
              {(ext.skills || []).slice(0, 3).map((skill: any) => (
                <span key={skill.id || skill.name}>
                  {skill.name || skill.id}
                </span>
              ))}
            </div>
            <div className="agent-card-stats">
              <div>
                <span>本地综合评分</span>
                <strong title={ext.score?.score_note}>
                  {ext.score?.eligible ? `${ext.score.match_score} 分` : "不可调用"}
                </strong>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <span>{ext.score?.history?.calls ? `基于 ${ext.score.history.calls} 次本地调用` : "暂无本地调用记录 · 使用中性先验"}</span>
                <strong style={{ fontSize: "12px" }}>{ext.score?.rank ? `第 ${ext.score.rank} 名 · ` : ""}{ext.transport}</strong>
              </div>
            </div>
            <div className="agent-card-reg">
              <span className="reg-pill">
                全网发现
              </span>
              <div className="reg-actions">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedExternal(ext);
                  }}
                  title="查看详细 ACS 标准能力声明"
                >
                  <Eye size={11} />
                  查看 ACS
                </button>
                {agents.some((a) => a.aic === ext.aic) ? (
                  <span className="certificate-ready" style={{ color: "#16a34a" }}>
                    <Check size={11} />
                    已在本地
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleQuickPin(ext);
                    }}
                    disabled={pinningAic === ext.aic}
                    title="将该外部智能体固定到本地协作网"
                  >
                    <Pin size={11} />
                    {pinningAic === ext.aic ? "固定中..." : "固定到本地"}
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>

      {(role === "adp" || showAdpFeed) && adpFiltered.length === 0 && (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--muted)" }}>
          {adpLoading ? (
            <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <LoadingFlow label="正在从官方 ADP 发现服务拉取全网智能体..." />
            </div>
          ) : adpError ? (
            <div>{adpError}</div>
          ) : (
            <div>未找到匹配的全网智能体，可尝试其他搜索词或点击刷新</div>
          )}
        </div>
      )}

      {builderOpen && (
        <AgentBuilder
          agent={selected}
          providers={providers}
          onClose={() => setBuilderOpen(false)}
          onSaved={async () => {
            setBuilderOpen(false);
            await onChanged();
          }}
        />
      )}
      {previewAgent && (
        <RegistrationPreviewModal
          agent={previewAgent}
          previewData={previewData}
          loading={previewLoading}
          submitting={regBusy === previewAgent.id}
          error={regNotice}
          onClose={() => {
            setPreviewAgent(null);
            setPreviewData(null);
          }}
          onConfirm={() => void confirmRegister()}
        />
      )}
      {discoveryOpen && (
        <DiscoveryModal
          existingAgents={agents}
          onClose={() => setDiscoveryOpen(false)}
          onImported={async () => {
            await onChanged();
          }}
        />
      )}
      {selectedExternal && (
        <ExternalAcsDrawer
          agent={selectedExternal}
          existingAgents={agents}
          onClose={() => setSelectedExternal(null)}
          onImport={async (ext) => {
            await handleQuickPin(ext);
          }}
          importing={pinningAic === selectedExternal.aic}
        />
      )}
    </div>
  );
}

function ExternalAcsDrawer({
  agent,
  existingAgents,
  onClose,
  onImport,
  importing,
}: {
  agent: any;
  existingAgents: Agent[];
  onClose: () => void;
  onImport: (agent: any) => Promise<void>;
  importing: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const isImported = existingAgents.some((a) => a.aic === agent.aic);

  const copyJson = () => {
    void navigator.clipboard.writeText(JSON.stringify(agent.raw_acs || agent, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="drawer-layer">
      <button className="drawer-backdrop" onClick={onClose} aria-label="关闭侧边栏" />
      <aside className="builder-drawer" style={{ width: "min(680px, 92vw)" }}>
        <div className="drawer-header">
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "22px" }}>🌐</span>
            <div>
              <h2 style={{ margin: 0, fontSize: "16px" }}>{agent.name}</h2>
              <span style={{ fontSize: "12px", color: "var(--c85857f)" }}>
                {agent.organization || "外部节点"} · 全网发现 (ADP)
              </span>
            </div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="drawer-body" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div>
            <label style={{ fontSize: "12px", fontWeight: 600, color: "var(--c85857f)", display: "block", marginBottom: "4px" }}>
              AIC 标识码
            </label>
            <div style={{ fontFamily: "monospace", fontSize: "12px", background: "var(--ce2e2dd)", padding: "8px 12px", borderRadius: "8px", wordBreak: "break-all" }}>
              {agent.aic}
            </div>
          </div>

          <div>
            <label style={{ fontSize: "12px", fontWeight: 600, color: "var(--c85857f)", display: "block", marginBottom: "4px" }}>
              能力描述
            </label>
            <p style={{ margin: 0, fontSize: "13px", lineHeight: "1.6", color: "var(--ink)" }}>
              {agent.description || "暂无详细描述"}
            </p>
          </div>

          <div>
            <label style={{ fontSize: "12px", fontWeight: 600, color: "var(--c85857f)", display: "block", marginBottom: "6px" }}>
              技能列表 (Skills · {(agent.skills || []).length})
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {(agent.skills || []).map((skill: any) => (
                <div key={skill.id || skill.name} style={{ background: "var(--cf7f7f4)", padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--cd5d5cf)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <strong style={{ fontSize: "13px" }}>{skill.name || skill.id}</strong>
                    <span style={{ fontSize: "11px", color: "var(--c85857f)" }}>v{skill.version || "1.0.0"}</span>
                  </div>
                  {skill.description && (
                    <div style={{ fontSize: "12px", color: "var(--c555550)", marginTop: "4px", lineHeight: "1.4" }}>
                      {skill.description}
                    </div>
                  )}
                  {skill.tags && skill.tags.length > 0 && (
                    <div style={{ display: "flex", gap: "5px", flexWrap: "wrap", marginTop: "6px" }}>
                      {skill.tags.map((tag: string) => (
                        <span key={tag} style={{ fontSize: "11px", background: "var(--ce2e2dd)", padding: "2px 6px", borderRadius: "4px" }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div>
            <label style={{ fontSize: "12px", fontWeight: 600, color: "var(--c85857f)", display: "block", marginBottom: "4px" }}>
              公开调用端点与传输协议
            </label>
            <div style={{ fontFamily: "monospace", fontSize: "12px", background: "var(--ce2e2dd)", padding: "8px 12px", borderRadius: "8px" }}>
              <strong style={{ color: "#0284c7" }}>{agent.transport}</strong>: {agent.endpoint_url || "未公开直连 URL (群组或代理路由)"}
            </div>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
              <label style={{ fontSize: "12px", fontWeight: 600, color: "var(--c85857f)" }}>
                原始 ACS 规范 JSON
              </label>
              <button type="button" className="text-button" style={{ fontSize: "11px" }} onClick={copyJson}>
                {copied ? "已复制" : "复制 JSON"}
              </button>
            </div>
            <pre style={{ margin: 0, padding: "12px", background: "var(--cf7f7f4)", border: "1px solid var(--cd5d5cf)", borderRadius: "8px", fontSize: "11px", maxHeight: "180px", overflow: "auto", lineHeight: "1.4" }}>
              {JSON.stringify(agent.raw_acs || agent, null, 2)}
            </pre>
          </div>
        </div>

        <div className="drawer-footer" style={{ justifyContent: "space-between" }}>
          <div style={{ fontSize: "12px", color: "var(--c85857f)" }}>
            {isImported ? "✓ 已固定到本地协作网" : "在全网发现中直接查看，或固定到本地参与协同"}
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" className="secondary-button" onClick={onClose}>
              关闭
            </button>
            {!isImported && (
              <button
                type="button"
                className="primary-button"
                onClick={() => void onImport(agent)}
                disabled={importing}
              >
                {importing ? "固定中..." : "一键固定到本地"}
              </button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function DiscoveryModal({
  existingAgents,
  onClose,
  onImported,
}: {
  existingAgents: Agent[];
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [query, setQuery] = useState("文献检索");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [importingAic, setImportingAic] = useState("");

  const search = async (q: string) => {
    setLoading(true);
    setError("");
    setSuccess("");
    try {
      const res = await api.discoverySearch(q, 10);
      const acsMap = res.acsMap || res.result?.acsMap || {};
      const aliveMap = res.aliveMap || res.result?.aliveMap || {};
      const scored = new Map((res.candidates || []).map((item: any) => [item.aic, item]));
      const list = Object.entries(acsMap).map(([aic, acs]) => {
        const record = acs && typeof acs === "object" ? acs as Record<string, unknown> : {};
        const alive = aliveMap[aic] && typeof aliveMap[aic] === "object" ? (aliveMap[aic] as { alive?: boolean }).alive : undefined;
        return { ...record, aic, alive, score: scored.get(aic) };
      });
      list.sort((a, b) => (a.score?.rank || 9999) - (b.score?.rank || 9999));
      setResults(list);
      if (list.length === 0) {
        setError("未发现匹配的外部智能体，可尝试其他关键词");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "发现服务请求失败");
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void search("文献检索");
  }, []);

  const handleImport = async (target: any) => {
    setImportingAic(target.aic);
    setError("");
    try {
      const endpoint =
        target.endPoints?.find((ep: any) => ep.url?.startsWith("https://"))?.url ||
        target.endPoints?.[0]?.url ||
        "";
      const payload = {
        aic: target.aic,
        name: target.name,
        description: target.description || "",
        endpoint,
        transport: "aip-rpc",
        skills: target.skills || [],
        streaming: Boolean(target.streaming ?? target.capabilities?.streaming ?? target.raw_acs?.capabilities?.streaming),
        notification: Boolean(target.notification ?? target.capabilities?.notification ?? target.raw_acs?.capabilities?.notification),
        alive: typeof target.alive === "boolean" ? target.alive : undefined,
        group: declaredGroup(target),
      };
      await api.importDiscoveredAgent(payload);
      setSuccess(`已成功导入智能体「${target.name}」到本平台调度池！`);
      await onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setImportingAic("");
    }
  };

  return (
    <div className="drawer-layer" style={{ zIndex: 1100 }}>
      <button className="drawer-backdrop" onClick={onClose} />
      <div
        className="preview-modal-dialog"
        style={{ maxWidth: "780px", maxHeight: "88vh", overflow: "hidden", display: "flex", flexDirection: "column" }}
      >
        <div className="preview-modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <Radio size={20} style={{ color: "var(--primary, #3b82f6)" }} />
            <div>
              <h3>发现外部智能体</h3>
              <p className="preview-modal-sub">
                候选由官方发现服务提供，关联本地调用历史评分后排序
              </p>
            </div>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: "16px 24px", overflowY: "auto", flex: 1 }}>
          <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
            <div className="search-box" style={{ flex: 1 }}>
              <Search size={16} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void search(query);
                  }
                }}
                placeholder="输入任务场景、能力关键词或精确 AIC 身份码（如：1.2.156.3088...）"
              />
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={() => void search(query)}
              disabled={loading || !query.trim()}
            >
              {loading ? <FlowMark className="flow-mark-compact" /> : <Search size={13} />}
              <span>{loading ? "检索中..." : "在线发现"}</span>
            </button>
          </div>

          <div style={{ display: "flex", gap: "6px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: "11px", color: "var(--c777771)" }}>热门检索:</span>
            {["文献检索", "求职规划", "演示", "问答", "全部"].map((tag) => (
              <button
                key={tag}
                type="button"
                className="chip-button"
                onClick={() => {
                  const q = tag === "全部" ? "智能体" : tag;
                  setQuery(q);
                  void search(q);
                }}
                style={{
                  fontSize: "11px",
                  padding: "3px 9px",
                  borderRadius: "12px",
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--foreground)",
                  cursor: "pointer",
                }}
              >
                {tag}
              </button>
            ))}
          </div>

          {error && (
            <div className="connection-banner" style={{ background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.3)", color: "var(--red)", marginBottom: "12px" }}>
              <span>{error}</span>
            </div>
          )}
          {success && (
            <div className="connection-banner" style={{ background: "rgba(34, 197, 94, 0.1)", borderColor: "rgba(34, 197, 94, 0.3)", color: "#16a34a", marginBottom: "12px" }}>
              <span>{success}</span>
            </div>
          )}

          {loading ? (
            <div className="preview-modal-loading" style={{ padding: "40px 0" }}>
              <LoadingFlow label="正在向官方发现服务查询候选智能体..." />
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {results.map((target: any) => {
                const isImported = existingAgents.some((a) => a.aic === target.aic);
                const httpsEp = target.endPoints?.find((ep: any) => ep.url?.startsWith("https://"))?.url;
                const mqEp = target.endPoints?.find((ep: any) => ep.url?.startsWith("amqps://"))?.url;
                return (
                  <div
                    key={target.aic}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: "10px",
                      padding: "14px",
                      background: "var(--card-bg, rgba(255,255,255,0.02))",
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px" }}>
                      <div>
                        <h4 style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: 600 }}>{target.name}</h4>
                        {target.score && <span className="reg-pill" title={target.score.score_note}>
                          {target.score.eligible ? `本地评分 ${target.score.match_score} · 第 ${target.score.rank} 名` : "当前不可调用"}
                          {target.score.history.calls ? ` · ${target.score.history.calls} 次记录` : " · 中性先验"}
                        </span>}
                        <span style={{ fontSize: "11px", fontFamily: "monospace", color: "var(--c777771)" }}>
                          AIC: {target.aic}
                        </span>
                      </div>
                      {isImported ? (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            fontSize: "11px",
                            color: "#16a34a",
                            padding: "4px 8px",
                            borderRadius: "6px",
                            background: "rgba(34, 197, 94, 0.1)",
                          }}
                        >
                          <Check size={12} />
                          已接入本平台
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="primary-button"
                          style={{ padding: "5px 12px", fontSize: "12px" }}
                          onClick={() => void handleImport(target)}
                          disabled={importingAic === target.aic}
                        >
                          <Download size={12} />
                          <span>{importingAic === target.aic ? "导入中..." : "一键导入"}</span>
                        </button>
                      )}
                    </div>

                    <p style={{ margin: 0, fontSize: "12px", color: "var(--muted)", lineHeight: 1.5 }}>
                      {target.description || "暂无详细描述"}
                    </p>

                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                      {httpsEp && (
                        <span style={{ fontSize: "10px", color: "var(--c777771)", background: "var(--hover-bg, rgba(15, 23, 42, 0.06))", padding: "2px 8px", borderRadius: "4px" }}>
                          mTLS
                        </span>
                      )}
                      {(target.streaming || target.capabilities?.streaming) && (
                        <span style={{ fontSize: "10px", color: "var(--c777771)", background: "var(--hover-bg, rgba(15, 23, 42, 0.06))", padding: "2px 8px", borderRadius: "4px" }}>
                          流式
                        </span>
                      )}
                      {(target.notification || target.capabilities?.notification) && (
                        <span style={{ fontSize: "10px", color: "var(--c777771)", background: "var(--hover-bg, rgba(15, 23, 42, 0.06))", padding: "2px 8px", borderRadius: "4px" }}>
                          通知
                        </span>
                      )}
                      {(mqEp || declaredGroup(target)) && (
                        <span style={{ fontSize: "10px", color: "var(--c777771)", background: "var(--hover-bg, rgba(15, 23, 42, 0.06))", padding: "2px 8px", borderRadius: "4px" }}>
                          群组通道
                        </span>
                      )}
                      {target.skills?.map((s: any) => (
                        <span key={s.id || s.name} style={{ fontSize: "10px", color: "var(--c777771)", border: "1px solid var(--border)", padding: "2px 8px", borderRadius: "4px" }}>
                          {s.name || s.id}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RegistrationPreviewModal({
  agent,
  previewData,
  loading,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  agent: Agent;
  previewData: {
    acs: Record<string, unknown>;
    target_registry: string;
    registry_username: string;
    public_rpc_url: string;
  } | null;
  loading: boolean;
  submitting: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const copyJson = () => {
    if (!previewData?.acs) return;
    void navigator.clipboard.writeText(
      JSON.stringify(previewData.acs, null, 2),
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleConfirm = () => {
    onConfirm();
  };

  const skills = agent.skills || [];
  const publicRpc =
    previewData?.public_rpc_url ||
    agent.endpoint_url ||
    `https://demmo.cc.cd/aip/${agent.id}/rpc`;

  return (
    <div className="drawer-layer" style={{ zIndex: 1100 }}>
      <button className="drawer-backdrop" onClick={onClose} />
      <div className="preview-modal-dialog">
        <div className="preview-modal-header">
          <div>
            <h3>智能体提审概览与合规核验</h3>
            <p className="preview-modal-sub">
              核验基础信息、技能声明与通信端点后提交。审核账号由服务端统一配置。
            </p>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="preview-modal-loading">
            <LoadingFlow label="正在实时组装与校验 ACS 标准能力规范..." />
          </div>
        ) : (
          <div className="preview-modal-body">
            {/* 注册凭据仅由服务端安全配置提供。 */}
            <div className="registry-card-box">
              <div className="registry-card-header">
                <div className="registry-card-title">
                  <Shield size={16} />
                  <strong>梧桐审核平台账号凭据</strong>
                </div>
                <span className="registry-card-note">
                  凭据仅保存在服务端安全配置中，浏览器不会读取或保存密码
                </span>
              </div>
            </div>

            <div className="preview-grid">
              <div className="preview-item">
                <span className="preview-label">智能体名称</span>
                <strong className="preview-value">{agent.name}</strong>
              </div>
              <div className="preview-item">
                <span className="preview-label">角色定位</span>
                <span className="preview-value role-tag">
                  {agent.role === "leader"
                    ? "协调型 (Leader)"
                    : "执行型 (Partner)"}
                </span>
              </div>
              <div className="preview-item">
                <span className="preview-label">目标注册服务</span>
                <span className="preview-value mono">
                  {previewData?.target_registry ||
                    "https://wt.ioa.pub/registry-server/api/v1"}
                </span>
              </div>
              <div className="preview-item">
                <span className="preview-label">当前生效账号</span>
                <strong className="preview-value">
                  {previewData?.registry_username || "未配置"}
                </strong>
              </div>
              <div className="preview-item full">
                <span className="preview-label">对外公开 AIP RPC 端点</span>
                <code className="preview-code">{publicRpc}</code>
              </div>
              <div className="preview-item full">
                <span className="preview-label">
                  已声明技能规范 (Skills - {skills.length})
                </span>
                <div className="preview-skills-list">
                  {skills.length > 0 ? (
                    skills.map((skill) => (
                      <div key={skill.id} className="preview-skill-box">
                        <div className="skill-head">
                          <div className="skill-name-row">
                            <strong>{skill.name}</strong>
                            <span className="skill-badge version">
                              v{skill.version || "1.0.0"}
                            </span>
                          </div>
                          <span className="skill-id mono">ID: {skill.id}</span>
                        </div>
                        {skill.description ? (
                          <div className="skill-desc">{skill.description}</div>
                        ) : (
                          <div className="skill-desc empty">
                            （未提供详细描述，提审将使用智能体基础描述）
                          </div>
                        )}
                        <div className="skill-tag-row">
                          {(skill.tags || []).map((tag) => (
                            <span key={tag} className="tag-pill">
                              #{tag}
                            </span>
                          ))}
                        </div>
                        {(skill.examples || []).length > 0 && (
                          <div className="skill-examples-preview">
                            <span className="example-label">
                              交互指令与提问示例：
                            </span>
                            <ul>
                              {skill.examples.map((ex, i) => (
                                <li key={i}>{ex}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <span className="empty-hint">
                      未声明特定技能（将使用系统默认通用能力）
                    </span>
                  )}
                </div>
              </div>
              {channelFacts(agent).map((fact) => (
                <div className="preview-item" key={fact.label}>
                  <span className="preview-label">{fact.label}</span>
                  <span className="preview-value">{fact.value}</span>
                </div>
              ))}
              <div className="preview-item">
                <span className="preview-label">安全方案 (Security)</span>
                <span className="preview-value">
                  {Object.values((previewData?.acs.securitySchemes || {}) as Record<string, { type?: string }>).some((scheme) => scheme.type === "mutualTLS")
                    ? "🔒 mTLS 双向证书"
                    : "标准认证"}
                </span>
              </div>
            </div>

            <div className="acs-code-section">
              <div className="acs-code-header">
                <button
                  type="button"
                  className="preview-toggle-btn"
                  onClick={() => setShowJson(!showJson)}
                >
                  <Braces size={13} />
                  {showJson
                    ? "收起完整 ACS JSON 规范"
                    : "展开查看即将提交的完整 ACS JSON 规范"}
                </button>
                {showJson && (
                  <button
                    type="button"
                    className="preview-copy-btn"
                    onClick={copyJson}
                  >
                    {copied ? (
                      <Check size={13} color="#10b981" />
                    ) : (
                      <Copy size={13} />
                    )}
                    <span>{copied ? "已复制" : "复制 JSON"}</span>
                  </button>
                )}
              </div>
              {showJson && previewData?.acs && (
                <pre className="json-code-block">
                  {JSON.stringify(previewData.acs, null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}

        <div className="preview-modal-footer">
          {error && <p className="registration-error" role="alert">{error}</p>}
          <button
            className="secondary-button"
            onClick={onClose}
            disabled={submitting}
          >
            返回修改
          </button>
          <button
            className="primary-button"
            onClick={handleConfirm}
            disabled={loading || submitting || !previewData}
          >
            {submitting ? (
              <>
                <FlowMark className="flow-mark-compact" />
                正在提交注册审核...
              </>
            ) : (
              <>
                <ScanSearch size={13} />
                确认提交审核
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillSubModal({
  skill,
  onSave,
  onClose,
}: {
  skill: Skill;
  onSave: (skill: Skill) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(skill.name || "");
  const [id, setId] = useState(skill.id || "");
  const [version, setVersion] = useState(skill.version || "1.0.0");
  const [description, setDescription] = useState(skill.description || "");
  const [tagsStr, setTagsStr] = useState((skill.tags || []).join(", "));
  const [examplesStr, setExamplesStr] = useState(
    (skill.examples || []).join("\n"),
  );
  const [inputModesStr, setInputModesStr] = useState(
    (skill.input_modes || ["text/plain", "application/json"]).join(", "),
  );
  const [outputModesStr, setOutputModesStr] = useState(
    (skill.output_modes || ["application/json", "text/markdown"]).join(", "),
  );
  const [inputSchema, setInputSchema] = useState(schemaText(skill.input_schema));
  const [outputSchema, setOutputSchema] = useState(schemaText(skill.output_schema));
  const [error, setError] = useState("");

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("请填写技能名称");
      return;
    }
    const cleanId = id.trim() || name.trim().toLowerCase().replace(/\s+/g, "-");
    const tags = tagsStr
      .split(/[,，]/)
      .map((t: string) => t.trim())
      .filter(Boolean);
    const examples = examplesStr
      .split("\n")
      .map((ex: string) => ex.trim())
      .filter(Boolean);
    const input_modes = inputModesStr
      .split(/[,，]/)
      .map((m: string) => m.trim())
      .filter(Boolean);
    const output_modes = outputModesStr
      .split(/[,，]/)
      .map((m: string) => m.trim())
      .filter(Boolean);

    let parsedInput, parsedOutput;
    try { parsedInput = parseSchemaText(inputSchema); parsedOutput = parseSchemaText(outputSchema); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Schema 格式不正确"); return; }
    onSave({
      ...skill,
      id: cleanId,
      name: name.trim(),
      version: version.trim() || "1.0.0",
      description: description.trim(),
      tags,
      examples,
      input_modes: input_modes.length > 0 ? input_modes : ["text/plain"],
      output_modes:
        output_modes.length > 0 ? output_modes : ["application/json"],
      input_schema: parsedInput,
      output_schema: parsedOutput,
    });
  };

  return (
    <div className="drawer-layer" style={{ zIndex: 1200 }}>
      <button className="drawer-backdrop" onClick={onClose} aria-label="关闭" />
      <div className="preview-modal-dialog skill-sub-dialog">
        <div className="preview-modal-header">
          <div>
            <h3>
              {skill.id ? "编辑技能配置 (二级菜单)" : "添加新技能规范 (二级菜单)"}
            </h3>
            <p className="preview-modal-sub">
              配置官方标准 ACS 所需的技能版本、描述、标签、提问示例与支持的输入输出模式。
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSave} className="skill-modal-form">
          <div className="preview-modal-body">
            {error && <div className="builder-error">{error}</div>}
            <div className="two-column">
              <label>
                <RequiredLabel>技能名称</RequiredLabel>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!id) {
                      setId(e.target.value.toLowerCase().replace(/\s+/g, "-"));
                    }
                  }}
                  placeholder="例如：行业研究、代码编写、财务审计"
                />
              </label>
              <label>
                <RequiredLabel>技能标识 (ID)</RequiredLabel>
                <input
                  type="text"
                  required
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="例如：industry-research"
                />
              </label>
            </div>

            <div className="two-column">
              <label>
                <RequiredLabel>规范版本 (Version)</RequiredLabel>
                <input
                  type="text"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="1.0.0"
                />
              </label>
              <label>
                <span>业务标签 (Tags，逗号分隔)</span>
                <input
                  type="text"
                  value={tagsStr}
                  onChange={(e) => setTagsStr(e.target.value)}
                  placeholder="研报, 投顾, 深度分析"
                />
              </label>
            </div>

            <label>
              <span>技能详细描述 (Description)</span>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="详细说明该技能的具体职责、输入约束与执行逻辑..."
              />
            </label>

            <label>
              <span>用户示例指令 / 提问示例 (Examples，每行一条)</span>
              <textarea
                rows={3}
                value={examplesStr}
                onChange={(e) => setExamplesStr(e.target.value)}
                placeholder="每行一个示例，例如：&#10;分析 2026 年新能源汽车出海格局&#10;出具光伏逆变器行业研报"
              />
            </label>

            <div className="two-column">
              <label>
                <span>支持输入格式 (Input Modes)</span>
                <input
                  type="text"
                  value={inputModesStr}
                  onChange={(e) => setInputModesStr(e.target.value)}
                  placeholder="text/plain, application/json"
                />
              </label>
              <label>
                <span>支持输出格式 (Output Modes)</span>
                <input
                  type="text"
                  value={outputModesStr}
                  onChange={(e) => setOutputModesStr(e.target.value)}
                  placeholder="application/json, text/markdown"
                />
              </label>
            </div>
            <details className="structured-skill-editors">
              <summary>结构化字段（可选）</summary>
              <SchemaEditors input={inputSchema} output={outputSchema} onInput={setInputSchema} onOutput={setOutputSchema} inherited/>
            </details>
          </div>
          <div className="preview-modal-footer">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
            >
              取消
            </button>
            <button type="submit" className="primary-button">
              保存技能配置
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const SYSTEM_AVAILABLE_TOOLS = [
  {
    id: "web_search",
    name: "联网检索 (Web Search)",
    category: "检索与信息",
    description: "实时检索互联网最新公开信息与引用资料，避免大模型知识盲区与幻觉（支持 DeepSeek 等主流模型联网能力）。",
  },
  {
    id: "calculator",
    name: "基础算术计算器 (Calculator)",
    category: "计算与逻辑",
    description: "高精度执行加减乘除、乘方与数学算术表达式求值，保障关键指标计算无偏差。",
  },
  {
    id: "current_time",
    name: "系统与时区时钟 (Current Time)",
    category: "系统辅助",
    description: "获取指定 IANA 时区或系统当前的精确标准时间与日期，支持时间敏感型任务。",
  },
];

function AgentBuilder({
  agent,
  providers,
  onClose,
  onSaved,
}: {
  agent: Agent | null;
  providers: Provider[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [structuredEnabled, setStructuredEnabled] = useState(agent?.structured_io_enabled ?? false);
  const [structuredDetailsOpen, setStructuredDetailsOpen] = useState(false);
  const [inputSchema, setInputSchema] = useState(schemaText(agent?.input_schema));
  const [outputSchema, setOutputSchema] = useState(schemaText(agent?.output_schema));
  const [toolsSubmenuOpen, setToolsSubmenuOpen] = useState(true);
  const [customToolInput, setCustomToolInput] = useState("");
  const [skills, setSkills] = useState<Skill[]>(() => {
    if (agent?.skills && agent.skills.length > 0) {
      return agent.skills.map((s) => ({
        ...s,
        id: s.id || "",
        name: s.name || "",
        version: s.version || "1.0.0",
        description: s.description || "",
        tags: s.tags || [],
        examples: s.examples || [],
        input_modes: s.input_modes || ["text/plain", "application/json"],
        output_modes: s.output_modes || ["application/json", "text/markdown"],
      }));
    }
    return [
      {
        id: "industry-research",
        name: "行业研究",
        version: "1.0.0",
        description: "提供专业深入的行业研究、数据整理与综合分析研报。",
        tags: ["行业研究", "数据分析", "研报生成"],
        examples: ["分析 2026 年新能源汽车出海格局", "出具光伏逆变器行业研报"],
        input_modes: ["text/plain", "application/json"],
        output_modes: ["application/json", "text/markdown"],
      },
    ];
  });
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [editingSkillIndex, setEditingSkillIndex] = useState<number | null>(null);

  const [form, setForm] = useState({
    id: agent?.id || "",
    name: agent?.name || "",
    role: agent?.role || "partner",
    description: agent?.description || "",
    system_prompt: agent?.system_prompt || "",
    aic: agent?.aic || "",
    transport: agent?.transport || "provider",
    endpoint_url: agent?.endpoint_url || "",
    identity_mode: agent?.aic ? "trusted" : "local",
    usage_mode: agent?.usage_mode || "internal",
    streaming_enabled: agent?.streaming_enabled ?? true,
    model_provider: agent?.model_provider || "",
    model_name: agent?.model_name || "",
    tools: agent?.tools.join(", ") || "",
  });
  const update = (key: string, value: string) => {
    setSaveError("");
    setForm((current) => ({ ...current, [key]: value }));
  };

  const activeTools = useMemo(() => {
    return form.tools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }, [form.tools]);

  const toggleTool = (toolId: string, enabled: boolean) => {
    let next: string[];
    if (enabled) {
      next = activeTools.includes(toolId) ? activeTools : [...activeTools, toolId];
    } else {
      next = activeTools.filter((t) => t !== toolId);
    }
    update("tools", next.join(", "));
  };

  const handleAddCustomTool = () => {
    const trimmed = customToolInput.trim();
    if (!trimmed) return;
    if (!activeTools.includes(trimmed)) {
      update("tools", [...activeTools, trimmed].join(", "));
    }
    setCustomToolInput("");
  };
  const idPattern = /^[A-Za-z0-9_.-]+$/;
  const endpointPattern = /^https?:\/\/\S+$/;
  const validAic = (value: string) => {
    const parts = value.trim().toUpperCase().split(".");
    if (parts.length !== 10 || parts.slice(0, 4).join(".") !== "1.2.156.3088")
      return false;
    const limits = [
      [1, 1],
      [1, 6],
      [1, 6],
      [1, 9],
      [1, 9],
      [4, 4],
    ];
    return parts
      .slice(4)
      .every(
        (part, index) =>
          /^[0-9A-Z]+$/.test(part) &&
          part.length >= limits[index][0] &&
          part.length <= limits[index][1],
      );
  };
  const stepError = (index: number) => {
    if (index === 0) {
      if (!form.name.trim()) return "请填写名称";
      if (!form.id.trim()) return "请填写标识";
      if (!agent && !idPattern.test(form.id.trim()))
        return "标识仅支持字母、数字与 . _ -";
      if (form.identity_mode === "trusted" && !form.aic.trim())
        return "请填写可信注册签发的 AIC";
      if (form.identity_mode === "trusted" && !validAic(form.aic))
        return "AIC 格式不符合官方规范";
      return "";
    }
    if (index === 1) {
      if (skills.length === 0) return "请至少配置一个业务能力技能";
      if (skills.some((s) => !s.name.trim())) return "存在未命名技能，请完善技能配置";
      try { parseSchemaText(inputSchema); parseSchemaText(outputSchema); }
      catch (reason) { return `结构化输入输出：${reason instanceof Error ? reason.message : "Schema 格式不正确"}`; }
      if (structuredEnabled && !inputSchema.trim() && !outputSchema.trim() && !skills.some(skill => skill.input_schema || skill.output_schema)) return "结构化输入输出：请配置至少一个输入或输出 Schema";
      return "";
    }
    if (index === 2) {
      if (form.transport === "provider")
        return form.model_provider ? "" : "请选择模型供应商";
      if (!form.endpoint_url.trim()) return "请填写 AIP 端点";
      return endpointPattern.test(form.endpoint_url.trim())
        ? ""
        : "端点必须是 http(s) 地址";
    }
    return "";
  };
  const goToStep = (target: number) => {
    if (target <= step) {
      setSaveError("");
      setStep(target);
      return;
    }
    for (let index = 0; index < target; index += 1) {
      const error = stepError(index);
      if (error) {
        if (error.startsWith("结构化输入输出：")) setStructuredDetailsOpen(true);
        setStep(index);
        setSaveError(error);
        return;
      }
    }
    setSaveError("");
    setStep(target);
  };

  const handleOpenAddSkill = () => {
    setEditingSkillIndex(null);
    setSkillModalOpen(true);
  };

  const handleOpenEditSkill = (index: number) => {
    setEditingSkillIndex(index);
    setSkillModalOpen(true);
  };

  const handleSaveSkill = (savedSkill: Skill) => {
    if (editingSkillIndex !== null && editingSkillIndex >= 0) {
      setSkills((prev) => {
        const next = [...prev];
        next[editingSkillIndex] = savedSkill;
        return next;
      });
    } else {
      setSkills((prev) => [...prev, savedSkill]);
    }
    setSkillModalOpen(false);
    setEditingSkillIndex(null);
  };

  const handleDeleteSkill = (index: number) => {
    if (skills.length <= 1) {
      setSaveError("至少保留一个业务技能");
      return;
    }
    setSkills((prev) => prev.filter((_, i) => i !== index));
  };

  const save = async () => {
    for (let index = 0; index < 3; index += 1) {
      const error = stepError(index);
      if (error) {
        if (error.startsWith("结构化输入输出：")) setStructuredDetailsOpen(true);
        setStep(index);
        setSaveError(error);
        return;
      }
    }
    setSaving(true);
    setSaveError("");
    const payload = {
      id: form.id || `agent-${Date.now()}`,
      name: form.name,
      role: form.role as "leader" | "partner",
      description: form.description,
      system_prompt: form.system_prompt,
      aic:
        form.identity_mode === "trusted" ? form.aic.trim().toUpperCase() : "",
      transport: form.transport,
      usage_mode: form.identity_mode === "local" ? "internal" : form.usage_mode,
      streaming_enabled: form.streaming_enabled,
      structured_io_enabled: structuredEnabled,
      input_schema: parseSchemaText(inputSchema),
      output_schema: parseSchemaText(outputSchema),
      endpoint_url: form.endpoint_url,
      input_modes: ["text/plain", "application/json"],
      output_modes: ["application/json", "text/markdown"],
      security_schemes: ["mtls"],
      skills: skills.map((s) => ({
        ...s,
        id: s.id.trim() || s.name.trim().toLowerCase().replace(/\s+/g, "-"),
        name: s.name.trim(),
        version: s.version?.trim() || "1.0.0",
        description: s.description?.trim() || "",
        tags: s.tags || [],
        examples: s.examples || [],
        input_modes:
          s.input_modes && s.input_modes.length > 0
            ? s.input_modes
            : ["text/plain", "application/json"],
        output_modes:
          s.output_modes && s.output_modes.length > 0
            ? s.output_modes
            : ["application/json", "text/markdown"],
      })),
      tools: form.tools
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      model_provider: form.model_provider,
      model_name: form.model_name,
      active: true,
      health: "unknown",
      estimated_cost_per_1k: 0,
    };
    try {
      if (agent) await api.updateAgent(agent.id, payload);
      else await api.createAgent(payload);
      await onSaved();
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  const steps = ["身份", "能力", "运行", "确认"];
  return (
    <div className="drawer-layer">
      <button className="drawer-backdrop" onClick={onClose} />
      <aside className="builder-drawer">
        <div className="drawer-header">
          <h2>{agent ? "编辑智能体" : "创建智能体"}</h2>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="stepper">
          {steps.map((label, index) => (
            <button
              key={label}
              className={index === step ? "active" : index < step ? "done" : ""}
              onClick={() => goToStep(index)}
            >
              <span>{index < step ? <Check size={13} /> : index + 1}</span>
              {label}
            </button>
          ))}
        </div>
        <div className="drawer-body">
          {saveError && <div className="builder-error">{saveError}</div>}
          {step === 0 && (
            <div className="form-stack">
              <label>
                <RequiredLabel>角色</RequiredLabel>
                <div className="role-selector">
                  <button
                    className={form.role === "leader" ? "active" : ""}
                    onClick={() => update("role", "leader")}
                  >
                    <GitBranch size={20} />
                    <strong>协调型</strong>
                    <span>规划与协调任务</span>
                  </button>
                  <button
                    className={form.role === "partner" ? "active" : ""}
                    onClick={() => update("role", "partner")}
                  >
                    <Bot size={20} />
                    <strong>执行型</strong>
                    <span>执行专业任务</span>
                  </button>
                </div>
              </label>
              <label>
                <RequiredLabel>身份方式</RequiredLabel>
                <div className="role-selector identity-selector">
                  <button
                    className={form.identity_mode === "local" ? "active" : ""}
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        identity_mode: "local",
                        aic: "",
                        usage_mode: agent ? current.usage_mode : "internal",
                      }))
                    }
                  >
                    <Database size={20} />
                    <strong>本地创建</strong>
                    <span>创建后可提交可信审核</span>
                  </button>
                  <button
                    className={form.identity_mode === "trusted" ? "active" : ""}
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        identity_mode: "trusted",
                        usage_mode: agent ? current.usage_mode : "both",
                      }))
                    }
                  >
                    <ShieldCheck size={20} />
                    <strong>已有可信 AIC</strong>
                    <span>接入已取得的可信身份</span>
                  </button>
                </div>
              </label>
              <Field
                required
                label="名称"
                value={form.name}
                onChange={(value) => update("name", value)}
                placeholder="例如研究协调器"
              />
              <Field
                required
                label="标识"
                value={form.id}
                onChange={(value) => update("id", value)}
                placeholder="research-lead"
                hint="字母、数字、点、下划线或连字符"
                disabled={Boolean(agent)}
              />
              {form.identity_mode === "trusted" ? (
                <Field
                  required
                  label="AIC"
                  value={form.aic}
                  onChange={(value) => update("aic", value)}
                  placeholder="1.2.156.3088.…"
                  hint="填写可信注册已签发的 10 段 AIC"
                />
              ) : (
                <div className="info-block">
                  <ShieldCheck size={16} />
                  <div>
                    <strong>先在本地创建</strong>
                    <p>
                      保存后可从智能体卡片提交可信审核，审核通过后平台会同步
                      AIC。
                    </p>
                  </div>
                </div>
              )}
              <label>
                描述
                <textarea
                  rows={4}
                  value={form.description}
                  onChange={(event) =>
                    update("description", event.target.value)
                  }
                  placeholder="说明职责和边界"
                />
              </label>
            </div>
          )}
          {step === 1 && (
            <div className="form-stack">
              <StructuredCapability
                enabled={structuredEnabled} onEnabled={value => { setStructuredEnabled(value); setSaveError(""); }}
                open={structuredDetailsOpen} onOpen={setStructuredDetailsOpen}
                input={inputSchema} output={outputSchema}
                onInput={value => { setInputSchema(value); setSaveError(""); }}
                onOutput={value => { setOutputSchema(value); setSaveError(""); }}
              />
              <div className="skills-mgr-box">
                <div className="skills-mgr-header">
                  <div>
                    <label style={{ margin: 0 }}>
                      <RequiredLabel>业务能力与技能规范 (Skills)</RequiredLabel>
                    </label>
                    <p className="skills-mgr-hint">
                      遵循可信互联规范，支持配置技能版本、描述、标签、提问示例与支持的输入输出模式。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button add-skill-btn"
                    onClick={handleOpenAddSkill}
                  >
                    + 添加新技能
                  </button>
                </div>

                <div className="skills-cards-list">
                  {skills.map((skillItem, sIndex) => (
                    <div key={skillItem.id || sIndex} className="skill-mgr-card">
                      <div className="skill-mgr-card-top">
                        <div className="skill-mgr-title-group">
                          <span className="skill-mgr-title">{skillItem.name || "未命名技能"}</span>
                          <span className="skill-badge-id">{skillItem.id}</span>
                          <span className="skill-badge-ver">v{skillItem.version || "1.0.0"}</span>
                        </div>
                        <div className="skill-mgr-actions">
                          <button
                            type="button"
                            className="text-link-btn"
                            onClick={() => handleOpenEditSkill(sIndex)}
                          >
                            编辑规范
                          </button>
                          {skills.length > 1 && (
                            <button
                              type="button"
                              className="text-link-btn danger"
                              onClick={() => handleDeleteSkill(sIndex)}
                            >
                              删除
                            </button>
                          )}
                        </div>
                      </div>

                      {skillItem.description && (
                        <div className="skill-mgr-desc">{skillItem.description}</div>
                      )}

                      <div className="skill-mgr-meta-row">
                        {skillItem.tags && skillItem.tags.length > 0 && (
                          <div className="skill-mgr-tags">
                            {skillItem.tags.map((t: string) => (
                              <span key={t} className="skill-mgr-tag">
                                #{t}
                              </span>
                            ))}
                          </div>
                        )}
                        {skillItem.examples && skillItem.examples.length > 0 && (
                          <span className="skill-mgr-examples-count">
                            {skillItem.examples.length} 个提问示例
                          </span>
                        )}
                        <span className="skill-mgr-io-hint">
                          模式: [{(skillItem.input_modes || []).join(", ")}] → [{(skillItem.output_modes || []).join(", ")}]
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="tools-subgroup-panel">
                <div
                  className="tools-subgroup-header"
                  onClick={() => setToolsSubmenuOpen((prev) => !prev)}
                >
                  <div className="tools-header-info">
                    <Wrench size={16} className="tools-header-icon" />
                    <div>
                      <h4 className="tools-header-title">可用工具管理 (Tools)</h4>
                      <p className="tools-header-subtitle">
                        子菜单开关配置智能体可用工具能力，无需手动输入
                      </p>
                    </div>
                  </div>
                  <div className="tools-header-actions">
                    <span
                      className={`tools-count-pill ${activeTools.length > 0 ? "has-active" : ""}`}
                    >
                      已启用 {activeTools.length} 项
                    </span>
                    <button
                      type="button"
                      className="tools-submenu-toggle"
                      aria-label={toolsSubmenuOpen ? "收起工具子菜单" : "展开工具子菜单"}
                    >
                      {toolsSubmenuOpen ? (
                        <ChevronUp size={15} />
                      ) : (
                        <ChevronDown size={15} />
                      )}
                    </button>
                  </div>
                </div>

                {activeTools.length > 0 && (
                  <div className="tools-active-pills">
                    {activeTools.map((t) => (
                      <span key={t} className="tool-active-pill">
                        {t}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleTool(t, false);
                          }}
                          title="移出可用工具"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {toolsSubmenuOpen && (
                  <div className="tools-list">
                    {SYSTEM_AVAILABLE_TOOLS.map((item) => {
                      const isEnabled = activeTools.includes(item.id);
                      return (
                        <div
                          key={item.id}
                          className={`tool-card ${isEnabled ? "active" : ""}`}
                          onClick={() => toggleTool(item.id, !isEnabled)}
                        >
                          <div className="tool-card-main">
                            <div className="tool-card-head">
                              <span className="tool-card-name">{item.name}</span>
                              <span className="tool-card-category">
                                {item.category}
                              </span>
                              <code className="tool-card-code">{item.id}</code>
                            </div>
                            <p className="tool-card-desc">{item.description}</p>
                          </div>
                          <div
                            onClick={(e) => e.stopPropagation()}
                            style={{ display: "flex", alignItems: "center" }}
                          >
                            <Switch
                              checked={isEnabled}
                              onChange={(val) => toggleTool(item.id, val)}
                            />
                          </div>
                        </div>
                      );
                    })}

                    {activeTools
                      .filter(
                        (t) =>
                          !SYSTEM_AVAILABLE_TOOLS.some((item) => item.id === t),
                      )
                      .map((customId) => (
                        <div
                          key={customId}
                          className="tool-card active"
                          onClick={() => toggleTool(customId, false)}
                        >
                          <div className="tool-card-main">
                            <div className="tool-card-head">
                              <span className="tool-card-name">
                                自定义工具 ({customId})
                              </span>
                              <span className="tool-card-category">扩展</span>
                              <code className="tool-card-code">{customId}</code>
                            </div>
                            <p className="tool-card-desc">
                              自定义外部注册工具
                            </p>
                          </div>
                          <div
                            onClick={(e) => e.stopPropagation()}
                            style={{ display: "flex", alignItems: "center" }}
                          >
                            <Switch
                              checked={true}
                              onChange={(val) => toggleTool(customId, val)}
                            />
                          </div>
                        </div>
                      ))}

                    <div className="tools-custom-add">
                      <input
                        type="text"
                        placeholder="输入其他自定义扩展工具（如 mcp_custom_tool）"
                        value={customToolInput}
                        onChange={(e) => setCustomToolInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleAddCustomTool();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={handleAddCustomTool}
                        disabled={!customToolInput.trim()}
                      >
                        + 添加工具
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <label>
                系统提示词 (System Prompt)
                <textarea
                  rows={6}
                  value={form.system_prompt}
                  onChange={(event) =>
                    update("system_prompt", event.target.value)
                  }
                  placeholder="编写这个智能体的身份、任务边界和输出要求"
                />
              </label>
            </div>
          )}
          {step === 2 && (
            <div className="form-stack">
              <label>
                <RequiredLabel>运行方式</RequiredLabel>
                <Dropdown
                  value={form.transport}
                  onChange={(value) => update("transport", value)}
                  options={[
                    { value: "provider", label: "托管模型" },
                    { value: "aip-rpc", label: "AIP 智能体" },
                  ]}
                />
              </label>
              <label>
                <RequiredLabel>使用方式</RequiredLabel>
                {form.identity_mode === "local" ? (
                  <div className="locked-selection">
                    <ShieldCheck size={15} />
                    <span>
                      <strong>仅内部调度</strong>
                      <small>可信验证完成后可开启对外服务</small>
                    </span>
                  </div>
                ) : (
                  <>
                    <Dropdown
                      value={form.usage_mode}
                      onChange={(value) => update("usage_mode", value)}
                      options={[
                        { value: "both", label: "内部调度 + 对外提供" },
                        { value: "internal", label: "仅内部调度" },
                        { value: "external", label: "仅对外提供" },
                      ]}
                    />
                    <small>控制智能体参与内部协同或对外提供服务</small>
                  </>
                )}
              </label>
              <div className="switch-row stream-switch">
                <span>
                  <strong>实时流式输出</strong>
                  <small>逐段返回模型内容，并在 ACS 中声明流式能力</small>
                </span>
                <Switch
                  checked={form.streaming_enabled}
                  onChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      streaming_enabled: value,
                    }))
                  }
                  label="实时流式输出"
                />
              </div>
              {form.transport === "provider" ? (
                <>
                  <label>
                    <RequiredLabel>模型供应商</RequiredLabel>
                    <Dropdown
                      value={form.model_provider}
                      onChange={(value) => update("model_provider", value)}
                      placeholder="选择供应商"
                      options={[
                        { value: "", label: "选择供应商" },
                        ...providers
                          .filter((provider) => provider.active)
                          .map((provider) => ({
                            value: provider.id,
                            label: provider.name,
                          })),
                      ]}
                    />
                  </label>
                  <Field
                    label="模型"
                    value={form.model_name}
                    onChange={(value) => update("model_name", value)}
                    placeholder={
                      providers.find(
                        (provider) => provider.id === form.model_provider,
                      )?.default_model || "模型标识"
                    }
                    hint="留空使用供应商默认模型"
                  />
                </>
              ) : (
                <Field
                  required
                  label="AIP 端点"
                  value={form.endpoint_url}
                  onChange={(value) => update("endpoint_url", value)}
                  placeholder="https://agent.example.com/rpc"
                />
              )}
            </div>
          )}
          {step === 3 && (
            <div className="review-card">
              <span className="agent-glyph large">
                {form.name.slice(0, 1) || "A"}
              </span>
              <span className="role-pill">{form.role}</span>
              <h3>{form.name || "未命名智能体"}</h3>
              <p>{form.description || "暂无描述"}</p>
              <dl>
                <div>
                  <dt>能力</dt>
                  <dd>
                    {skills.map((s) => `${s.name} (v${s.version || "1.0.0"})`).join("、") || "通用能力"}
                  </dd>
                </div>
                <div>
                  <dt>模型</dt>
                  <dd>
                    {form.model_provider} · {form.model_name}
                  </dd>
                </div>
                <div>
                  <dt>传输</dt>
                  <dd>{form.transport}</dd>
                </div>
                <div>
                  <dt>工具</dt>
                  <dd>{form.tools || "—"}</dd>
                </div>
                <div>
                  <dt>内置能力</dt>
                  <dd>{structuredEnabled ? "结构化输入输出" : "—"}</dd>
                </div>
              </dl>
            </div>
          )}
        </div>
        <div className="drawer-footer">
          {agent && (
            <button
              type="button"
              className="secondary-button"
              style={{ color: "#dc2626", borderColor: "#fca5a5", marginRight: "auto", display: "inline-flex", alignItems: "center", gap: "4px" }}
              disabled={saving}
              onClick={async () => {
                if (!window.confirm(`确定要删除智能体「${agent.name}」吗？该操作不可恢复。`)) return;
                try {
                  await api.deleteAgent(agent.id);
                  onClose();
                  await onSaved();
                } catch (err) {
                  setSaveError(err instanceof Error ? err.message : "删除失败");
                }
              }}
            >
              <Trash2 size={13} />
              删除智能体
            </button>
          )}
          <span className="required-note" style={agent ? { marginLeft: "0" } : undefined}>
            <em>*</em> 必填
          </span>
          <button
            className="secondary-button"
            onClick={step === 0 ? onClose : () => goToStep(step - 1)}
          >
            {step === 0 ? "取消" : "上一步"}
          </button>
          {step < 3 ? (
            <button
              className="primary-button"
              onClick={() => goToStep(step + 1)}
            >
              继续 <ChevronRight size={16} />
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "保存中" : "保存智能体"}
            </button>
          )}
        </div>
      </aside>
      {skillModalOpen && (
        <SkillSubModal
          skill={
            editingSkillIndex !== null && skills[editingSkillIndex]
              ? skills[editingSkillIndex]
              : {
                  id: "",
                  name: "",
                  version: "1.0.0",
                  description: "",
                  tags: [],
                  examples: [],
                  input_modes: ["text/plain", "application/json"],
                  output_modes: ["application/json", "text/markdown"],
                }
          }
          onSave={handleSaveSkill}
          onClose={() => {
            setSkillModalOpen(false);
            setEditingSkillIndex(null);
          }}
        />
      )}
    </div>
  );
}

function RequiredLabel({ children }: { children: string }) {
  return (
    <span className="required-label">
      {children}
      <em>*</em>
    </span>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  disabled,
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  type?: string;
  required?: boolean;
}) {
  return (
    <label>
      {required ? <RequiredLabel>{label}</RequiredLabel> : label}
      <input
        required={required}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Providers({
  providers,
  agents,
  onChanged,
}: {
  providers: Provider[];
  agents: Agent[];
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Provider | null>(null);
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState("");
  const [notice, setNotice] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);
  const remove = async (provider: Provider) => {
    if (!window.confirm(`删除供应商“${provider.name}”？`)) return;
    try {
      await api.deleteProvider(provider.id);
      await onChanged();
    } catch (reason) {
      setNotice({
        type: "error",
        message: reason instanceof Error ? reason.message : "删除失败",
      });
    }
  };
  const test = async (provider: Provider) => {
    setTesting(provider.id);
    setNotice(null);
    try {
      const result = await api.testProvider(provider.id);
      setNotice({
        type: "success",
        message: `${provider.name} 连接正常 · ${formatMs(result.latency_ms)}`,
      });
    } catch (reason) {
      setNotice({
        type: "error",
        message: reason instanceof Error ? reason.message : "连接失败",
      });
    } finally {
      setTesting("");
    }
  };
  return (
    <>
      <div className="toolbar provider-toolbar">
        <div className="provider-summary">
          <strong>{providers.length}</strong>
          <span>个供应商配置</span>
        </div>
        <button
          className="primary-button"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <CirclePlus size={16} />
          添加供应商
        </button>
      </div>
      {notice && (
        <div className={`connection-banner ${notice.type}`}>
          <span>{notice.message}</span>
          <button onClick={() => setNotice(null)}>关闭</button>
        </div>
      )}
      <div className="provider-grid">
        {providers.map((provider) => {
          const usage = agents.filter(
            (agent) => agent.model_provider === provider.id,
          ).length;
          return (
            <article className="panel provider-card" key={provider.id}>
              <div className="provider-card-head">
                <span className="provider-mark">
                  <ServerCog size={18} />
                </span>
                <span className="inline-status">
                  <StatusDot status={provider.active ? "online" : "unknown"} />
                  {provider.active ? "启用" : "停用"}
                </span>
              </div>
              <div>
                <h2>{provider.name}</h2>
                <code>{provider.kind}</code>
              </div>
              <dl>
                <div>
                  <dt>地址</dt>
                  <dd>{provider.base_url}</dd>
                </div>
                <div>
                  <dt>默认模型</dt>
                  <dd>{provider.default_model}</dd>
                </div>
                <div>
                  <dt>密钥</dt>
                  <dd>
                    {provider.api_key_env ||
                      (provider.key_configured ? "已安全保存" : "未配置")}
                  </dd>
                </div>
                <div>
                  <dt>智能体</dt>
                  <dd>{usage}</dd>
                </div>
              </dl>
              <div className="provider-actions">
                <button
                  onClick={() => void test(provider)}
                  disabled={testing === provider.id}
                >
                  {testing === provider.id ? (
                    <FlowMark className="flow-mark-compact" />
                  ) : (
                    <Play size={14} />
                  )}
                  测试
                </button>
                <button
                  onClick={() => {
                    setEditing(provider);
                    setOpen(true);
                  }}
                >
                  <Pencil size={14} />
                  编辑
                </button>
                <button onClick={() => void remove(provider)}>
                  <Trash2 size={14} />
                  删除
                </button>
              </div>
            </article>
          );
        })}
        {providers.length === 0 && (
          <div className="panel provider-empty">
            <EmptyState>添加模型供应商后即可创建托管智能体</EmptyState>
          </div>
        )}
      </div>
      {open && (
        <ProviderEditor
          provider={editing}
          onClose={() => setOpen(false)}
          onSaved={async () => {
            setOpen(false);
            await onChanged();
          }}
        />
      )}
      <WebSearchSettings providers={providers} />
    </>
  );
}

function ProviderEditor({
  provider,
  onClose,
  onSaved,
}: {
  provider: Provider | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    id: provider?.id || "",
    name: provider?.name || "",
    kind: provider?.kind || "openai-chat",
    base_url: provider?.base_url || "",
    default_model: provider?.default_model || "",
    api_key: "",
    api_key_env: provider?.api_key_env || "",
    active: provider?.active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const update = (key: string, value: string | boolean) =>
    setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      if (provider)
        await api.updateProvider(provider.id, {
          name: form.name,
          kind: form.kind,
          base_url: form.base_url,
          default_model: form.default_model,
          api_key: form.api_key || undefined,
          api_key_env: form.api_key_env,
          active: form.active,
        });
      else
        await api.createProvider({
          id: form.id,
          name: form.name,
          kind: form.kind,
          base_url: form.base_url,
          default_model: form.default_model,
          api_key: form.api_key || undefined,
          api_key_env: form.api_key_env,
          active: form.active,
        });
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="drawer-layer">
      <button className="drawer-backdrop" onClick={onClose} />
      <aside className="builder-drawer provider-drawer">
        <div className="drawer-header">
          <h2>{provider ? "编辑供应商" : "添加供应商"}</h2>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">
          <div className="form-stack">
            {error && <div className="builder-error">{error}</div>}
            <div className="two-column">
              <Field
                label="名称"
                value={form.name}
                onChange={(value) => update("name", value)}
                placeholder="例如 DeepSeek"
              />
              <Field
                label="标识"
                value={form.id}
                onChange={(value) => update("id", value)}
                placeholder="deepseek"
                disabled={Boolean(provider)}
              />
            </div>
            <label>
              接口类型
              <Dropdown
                value={form.kind}
                onChange={(value) => update("kind", value)}
                options={[
                  { value: "openai-chat", label: "兼容聊天补全" },
                  { value: "openai-responses", label: "OpenAI Responses" },
                  { value: "anthropic", label: "Anthropic Messages" },
                ]}
              />
            </label>
            <Field
              label="接口地址"
              value={form.base_url}
              onChange={(value) => update("base_url", value)}
              placeholder="https://api.example.com/v1"
            />
            <Field
              label="默认模型"
              value={form.default_model}
              onChange={(value) => update("default_model", value)}
              placeholder="模型标识"
            />
            <Field
              type="password"
              label="API Key"
              value={form.api_key}
              onChange={(value) => update("api_key", value)}
              placeholder={
                provider?.key_configured ? "留空保留现有密钥" : "输入密钥"
              }
            />
            <Field
              label="密钥环境变量"
              value={form.api_key_env}
              onChange={(value) => update("api_key_env", value)}
              placeholder="可选，例如 DEEPSEEK_API_KEY"
              hint="填写后优先读取服务器环境变量"
            />
            <Switch label="启用" checked={form.active} disabled={saving} onChange={(value) => update("active", value)} />
          </div>
        </div>
        <div className="drawer-footer">
          <button className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            disabled={
              saving ||
              !form.id ||
              !form.name ||
              !form.base_url ||
              !form.default_model ||
              (!provider?.key_configured && !form.api_key && !form.api_key_env)
            }
            onClick={() => void save()}
          >
            {saving ? "保存中" : "保存供应商"}
          </button>
        </div>
      </aside>
    </div>
  );
}

function Routing({
  policy,
  agents,
  onSaved,
}: {
  policy: Policy;
  agents: Agent[];
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Policy>(() => ({
    ...policy,
    weights: normalizeWeights(policy.weights),
  }));
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const weightGesture = useRef<{ key: string; weights: Policy["weights"] } | null>(null);
  const labels: Record<string, string> = {
    skill: "匹配程度",
    reliability: "历史可靠性",
    feedback: "用户反馈",
    latency: "响应延迟",
    load: "实时负载",
    health: "健康状态",
    cost: "成本",
  };
  const total = Object.values(draft.weights).reduce(
    (sum, value) => sum + Math.round(value * 100),
    0,
  );
  const beginWeightGesture = (key: string) => {
    // Keep the other weights' proportions stable throughout a drag or keyboard adjustment.
    weightGesture.current = { key, weights: draft.weights };
  };
  const updateWeight = (key: string, percent: number) => {
    const gesture = weightGesture.current;
    setDraft((current) => ({
      ...current,
      weights: rebalanceWeights(
        gesture?.key === key ? gesture.weights : current.weights,
        key,
        percent,
      ),
    }));
    setSaved(false);
    setSaveError("");
  };
  const equalize = () => {
    weightGesture.current = null;
    setDraft((current) => ({ ...current, weights: equalizeWeights(current.weights) }));
    setSaved(false);
    setSaveError("");
  };
  const save = async () => {
    setSaving(true);
    setSaveError("");
    try {
      await api.updatePolicy(draft);
      setSaved(true);
      await onSaved();
    } catch (reason) {
      setSaved(false);
      setSaveError(reason instanceof Error ? reason.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="routing-layout">
      <section className="panel policy-panel">
        <div className="panel-heading">
          <h2>排序比重 · {total}%</h2>
        </div>
        <p className="weight-help" id="weight-help">
          匹配程度指智能体技能和问题所需能力的匹配程度。这里调整各项比重，占本次排序的 72%。另外 28% 按本批候选的差距自动调整。连续失败后暂时暂停编排，以确保服务稳定；暂停结束后正在测试模型稳定程度，通过后再恢复编排。每次实际使用的比重和分项见运行记录。
        </p>
        <div className="weight-list">
          {Object.entries(draft.weights).map(([key, value]) => (
            <label key={key}>
              <div>
                <span>{labels[key] || key}</span>
                <strong>{Math.round(value * 100)}%</strong>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={Math.round(value * 100)}
                aria-label={`${labels[key] || key}权重`}
                aria-valuetext={`${Math.round(value * 100)}%`}
                aria-describedby="weight-help"
                disabled={saving}
                onFocus={() => beginWeightGesture(key)}
                onPointerDown={() => beginWeightGesture(key)}
                onBlur={() => { weightGesture.current = null; }}
                onChange={(event) =>
                  updateWeight(key, Number(event.target.value))
                }
              />
            </label>
          ))}
        </div>
        {saveError && <p className="policy-error" role="alert">{saveError}</p>}
        <div className="policy-actions">
          <span className="valid-total">
            <Check size={14} /> 自动配平 · 合计 {total}%
          </span>
          <div className="policy-action-buttons">
            <button className="secondary-button" disabled={saving} onClick={equalize}>
              平均分配
            </button>
            <button
              className="primary-button"
              disabled={saving}
              onClick={() => void save()}
            >
              {saved ? <Check size={16} /> : null}
              {saving ? "保存中" : saved ? "已保存" : "保存策略"}
            </button>
          </div>
        </div>
      </section>
      <section className="panel rule-panel">
        <div className="panel-heading">
          <h2>故障策略</h2>
          <ShieldCheck size={18} />
        </div>
        <div className="setting-list">
          <Switch label="梧桐兼容模式" checked={Boolean(draft.interop_compatibility)} disabled={saving}
            onChange={(checked) => setDraft({ ...draft, interop_compatibility: checked })} />
          <p className="weight-help">开启后，智能体间派发统一走真实 AIP 调用：托管成员经认证 MQ，外部成员经 AIP。双方使用同一任务号记录 Access 日志；失败不回退内部直调。计榜以梧桐实际对账为准。随“保存策略”生效。</p>
          <Switch label="允许外部协调任务调用子智能体" checked={Boolean(draft.external_delegation_enabled)} disabled={saving}
            onChange={(checked) => setDraft({ ...draft, external_delegation_enabled: checked })} />
          <p className="weight-help">开启后，外部 AIP 请求可让协调型智能体发现并派发子任务，子调用始终走官方 AIP，不回退本地直调。关闭时仅执行自身任务；已配置的联网搜索不受影响。可能增加模型与子调用用量，最多三级调用链。保存后对新任务生效。</p>
          <Switch label="竞标模式" checked={Boolean(draft.bounty_enabled)} disabled={saving}
            onChange={checked => setDraft({ ...draft, bounty_enabled: checked })} />
          {draft.bounty_enabled && <>
            <NumberSetting label="参与成员上限" suffix="个" value={draft.bounty_max_workers ?? 3}
              onChange={value => setDraft({ ...draft, bounty_max_workers: Math.max(1, Math.min(5, value)) })} />
            <NumberSetting label="本轮任务上限" suffix="项" value={draft.bounty_max_items ?? 6}
              onChange={value => setDraft({ ...draft, bounty_max_items: Math.max(1, Math.min(12, value)) })} />
            <NumberSetting label="认领有效期" suffix="秒" value={draft.bounty_lease_seconds ?? 120}
              onChange={value => setDraft({ ...draft, bounty_lease_seconds: Math.max(10, Math.min(600, value)) })} />
          </>}
          <NumberSetting
            label="失败阈值"
            suffix="次"
            value={draft.failure_threshold}
            onChange={(value) =>
              setDraft({ ...draft, failure_threshold: value })
            }
          />
          <NumberSetting
            label="暂停时长"
            suffix="秒"
            value={draft.circuit_cooldown_seconds}
            onChange={(value) =>
              setDraft({ ...draft, circuit_cooldown_seconds: value })
            }
          />
          <NumberSetting
            label="最多尝试"
            suffix="个智能体"
            value={draft.max_attempts}
            onChange={(value) => setDraft({ ...draft, max_attempts: value })}
          />
          <NumberSetting
            label="单次超时"
            suffix="秒"
            value={draft.request_timeout_seconds}
            onChange={(value) =>
              setDraft({ ...draft, request_timeout_seconds: value })
            }
          />
        </div>
      </section>
      <section className="panel candidate-panel">
        <div className="panel-heading">
          <h2>候选池</h2>
          <Users size={18} />
        </div>
        <div className="candidate-list">
          {agents.map((agent) => (
            <div key={agent.id}>
              <span className="agent-glyph">{agent.name.slice(0, 1)}</span>
              <div>
                <strong>{agent.name}</strong>
                <span>
                  {agent.skills[0]?.name} · {agent.transport}
                </span>
              </div>
              <span className="inline-status">
                <StatusDot status={agent.circuit_state} />
                {stateNames[agent.circuit_state] || agent.circuit_state}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function NumberSetting({
  label,
  suffix,
  value,
  onChange,
}: {
  label: string;
  suffix: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <div>
        <input
          type="number"
          min="1"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <em>{suffix}</em>
      </div>
    </label>
  );
}

function Probes({
  agents,
  probes,
  onRun,
}: {
  agents: Agent[];
  probes: ProbeResult[];
  onRun: () => Promise<void>;
}) {
  const [running, setRunning] = useState(false);
  const [selectedId, setSelectedId] = useState(agents[0]?.id || "");
  useEffect(() => {
    if (!selectedId && agents[0]) setSelectedId(agents[0].id);
  }, [agents, selectedId]);
  const latest = useMemo(() => {
    const map = new Map<string, ProbeResult>();
    probes.forEach((probe) => {
      if (!map.has(probe.agent_id)) map.set(probe.agent_id, probe);
    });
    return map;
  }, [probes]);
  const selected = latest.get(selectedId);
  const selectedAgent = agents.find((agent) => agent.id === selectedId);
  const run = async () => {
    setRunning(true);
    await api.runProbes();
    await onRun();
    setRunning(false);
  };
  return (
    <div className="probe-layout">
      <section className="panel probe-overview">
        <div className="panel-heading">
          <h2>探针状态</h2>
          <button
            className="primary-small"
            onClick={() => void run()}
            disabled={running}
          >
            <ScanSearch size={15} />
            {running ? "分析中" : "立即分析"}
          </button>
        </div>
        <div className="probe-summary">
          <div>
            <span>已分析</span>
            <strong>{latest.size}</strong>
          </div>
          <div>
            <span>ACS 有效</span>
            <strong>
              {[...latest.values()].filter((item) => item.acs_valid).length}
            </strong>
          </div>
          <div>
            <span>AIP 可达</span>
            <strong>
              {[...latest.values()].filter((item) => item.aip_reachable).length}
            </strong>
          </div>
          <div>
            <span>告警</span>
            <strong>
              {
                [...latest.values()]
                  .flatMap((item) => item.findings)
                  .filter((item) => item.level === "error").length
              }
            </strong>
          </div>
        </div>
      </section>
      <section className="panel probe-agents">
        <div className="panel-heading">
          <h2>智能体</h2>
          <Network size={18} />
        </div>
        <div className="probe-agent-list">
          {agents.map((agent) => {
            const probe = latest.get(agent.id);
            return (
              <button
                className={selectedId === agent.id ? "active" : ""}
                onClick={() => setSelectedId(agent.id)}
                key={agent.id}
              >
                <span className="agent-glyph">{agent.name.slice(0, 1)}</span>
                <div>
                  <strong>{agent.name}</strong>
                  <span>
                    {transportNames[agent.transport] || agent.transport} ·{" "}
                    {probe ? stateNames[probe.status] || probe.status : "等待分析"}
                  </span>
                  <ScoreBar value={probe?.compatibility_score ?? 0} />
                </div>
                <b>{probe?.compatibility_score ?? "—"}</b>
                <ChevronRight size={15} />
              </button>
            );
          })}
          {agents.length === 0 && <EmptyState>接入智能体后开始分析</EmptyState>}
        </div>
      </section>
      <section className="panel probe-detail">
        {selected ? (
          <>
            <div className="panel-heading">
              <div>
                <span className="eyebrow">分析结果</span>
                <h2>{selectedAgent?.name || selected.agent_id}</h2>
              </div>
              <span className="inline-status">
                <StatusDot
                  status={
                    selected.status === "healthy"
                      ? "online"
                      : selected.status === "degraded"
                        ? "degraded"
                        : "offline"
                  }
                />
                {stateNames[selected.status] || selected.status}
              </span>
            </div>
            <div
              className="compatibility-ring"
              role="img"
              aria-label={`兼容评分 ${selected.compatibility_score} 分`}
            >
              <svg viewBox="0 0 120 120" aria-hidden="true">
                <circle className="compatibility-ring-track" cx="60" cy="60" r="52" />
                <circle
                  className="compatibility-ring-value"
                  cx="60"
                  cy="60"
                  r="52"
                  pathLength="100"
                  style={
                    {
                      "--score-offset": Math.max(
                        0,
                        100 - selected.compatibility_score,
                      ),
                    } as CSSProperties
                  }
                />
              </svg>
              <div>
                <strong>{selected.compatibility_score}</strong>
                <span>兼容评分</span>
              </div>
            </div>
            <div className="probe-checks">
              <div className={selected.acs_valid ? "passed" : "failed"}>
                {selected.acs_valid ? <Check size={16} /> : <X size={16} />}
                <span>ACS 结构</span>
                <b>{selected.acs_valid ? "通过" : "异常"}</b>
              </div>
              <div
                className={
                  selected.aip_reachable === null
                    ? ""
                    : selected.aip_reachable
                      ? "passed"
                      : "failed"
                }
              >
                {selected.aip_reachable ? <Check size={16} /> : <X size={16} />}
                <span>AIP 端点</span>
                <b>
                  {selected.aip_reachable === null
                    ? "未检测"
                    : selected.aip_reachable
                      ? "可达"
                      : "不可达"}
                </b>
              </div>
              <div className={selected.findings.some((finding) => finding.code === "MODE_INCOMPLETE") ? "failed" : "passed"}>
                {selected.findings.some((finding) => finding.code === "MODE_INCOMPLETE") ? <X size={16} /> : <Check size={16} />}
                <span>模式声明</span>
                <b>{selected.findings.some((finding) => finding.code === "MODE_INCOMPLETE") ? "不完整" : "完整"}</b>
              </div>
              <div className={selected.findings.some((finding) => finding.code === "SECURITY_MISSING") ? "failed" : "passed"}>
                {selected.findings.some((finding) => finding.code === "SECURITY_MISSING") ? <X size={16} /> : <Check size={16} />}
                <span>安全方案</span>
                <b>{selected.findings.some((finding) => finding.code === "SECURITY_MISSING") ? "未声明" : "已声明"}</b>
              </div>
            </div>
            <div className="finding-list">
              <h3>发现</h3>
              {selected.findings.map((finding) => (
                <div key={finding.code} className={finding.level}>
                  <span>{finding.level}</span>
                  <div>
                    <strong>{finding.code}</strong>
                    <p>{finding.message}</p>
                  </div>
                </div>
              ))}
              {selected.findings.length === 0 && (
                <p className="muted">未发现问题</p>
              )}
            </div>
          </>
        ) : (
          <EmptyState>运行探针后显示分析</EmptyState>
        )}
      </section>
    </div>
  );
}

function Traces({ traces }: { traces: Trace[] }) {
  const [selected, setSelected] = useState<Trace | null>(traces[0] || null);
  const [keyword, setKeyword] = useState("");
  const visible = traces.filter((trace) => {
    const haystack = `${trace.query} ${trace.id} ${trace.selected_agent_id || ""}`.toLowerCase();
    return haystack.includes(keyword.trim().toLowerCase());
  });
  useEffect(() => {
    if (!selected && traces[0]) setSelected(traces[0]);
  }, [traces, selected]);
  return (
    <div className="traces-layout">
      <section className="panel trace-list-panel">
        <div className="trace-search">
          <Search size={15} />
          <input
            placeholder="搜索运行记录"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </div>
        <div className="trace-list">
          {visible.map((trace) => (
            <button
              key={trace.id}
              className={selected?.id === trace.id ? "active" : ""}
              onClick={() => setSelected(trace)}
            >
              <StatusDot status={trace.status} />
              <div>
                <strong>{trace.query}</strong>
                <span title={trace.id}>
                  {stateNames[trace.status] || trace.status} · {formatTraceTime(trace.created_at)} · {formatMs(trace.total_latency_ms)}
                </span>
              </div>
              <ChevronRight size={15} />
            </button>
          ))}
          {visible.length === 0 && <EmptyState>暂无运行记录</EmptyState>}
        </div>
      </section>
      <section className="panel trace-detail">
        {selected ? (
          <>
            <div className="panel-heading">
              <div>
                <span className="eyebrow" title={selected.id}>
                  {formatTraceTime(selected.created_at)}
                </span>
                <h2>{selected.query}</h2>
              </div>
              <span className="role-pill">
                {stateNames[selected.status] || selected.status}
              </span>
            </div>
            <div className="trace-summary">
              <div>
                <span>最终智能体</span>
                <strong>{selected.selected_agent_id}</strong>
              </div>
              <div>
                <span>尝试</span>
                <strong>{selected.attempt_count}</strong>
              </div>
              <div>
                <span>延迟</span>
                <strong>{formatMs(selected.total_latency_ms)}</strong>
              </div>
              <div>
                <span>模型调用</span>
                <strong>{selected.llm_calls}</strong>
              </div>
            </div>
            {selected.result_text && (
              <section className="trace-result-summary">
                <div className="trace-section-heading">
                  <div>
                    <span className="eyebrow">最终输出</span>
                    <h3>执行结果</h3>
                  </div>
                  <span>{formatMs(selected.total_latency_ms)}</span>
                </div>
                <div className="trace-answer-box">
                  <MarkdownText text={selected.result_text} />
                </div>
              </section>
            )}
            {selected.attempts.length > 0 && (
              <details className="trace-disclosure">
                <summary>
                  <span>路由评分</span>
                  <small>{selected.attempts.length} 个候选</small>
                  <ChevronDown size={15} />
                </summary>
                <div className="finding-list">
                  {selected.attempts.map((attempt) => (
                    <div key={`${attempt.agent_id}-${attempt.rank}`}>
                      <span>{ATTEMPT_STATE_LABELS[attempt.state] || attempt.state}</span>
                      <div>
                        <strong>
                          {attempt.agent_id} · 第 {attempt.rank} 名 · {attempt.score}
                        </strong>
                        <p>
                          {Object.entries(attempt.breakdown)
                            .map(([key, value]) => `${metricLabels[key] || key} ${value}`)
                            .join(" · ") || "—"}
                          {attempt.error ? ` · ${attempt.error}` : ""}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
            <div className="trace-section-heading trace-timeline-heading">
              <div>
                <span className="eyebrow">过程</span>
                <h3>执行时间线</h3>
              </div>
              <span>{selected.events.length} 个阶段</span>
            </div>
            <div className="timeline">
              {selected.events.map((event, index) => (
                <div className="timeline-item" key={`${event.type}-${index}`}>
                  <span
                    className={
                      event.type.includes("FAILED")
                        ? "bad"
                        : event.type.includes("FAILOVER")
                          ? "warn"
                          : ""
                    }
                  >
                    {index + 1}
                  </span>
                  <div>
                    <strong>{eventNames[event.type] || event.type}</strong>
                    <p>{summarizeTraceDetail(event.detail)}</p>
                    {Object.keys(event.detail).length > 0 && (
                      <details className="trace-event-raw">
                        <summary>技术详情</summary>
                        <pre>{JSON.stringify(event.detail, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                  <time>
                    {new Date(event.created_at).toLocaleTimeString("zh-CN")}
                  </time>
                </div>
              ))}
            </div>
          </>
        ) : (
          <EmptyState>选择一条记录</EmptyState>
        )}
      </section>
    </div>
  );
}

function AccessControl() {
  const [settings, setSettings] = useState<{
    api_key_configured: boolean;
    api_key_from_environment: boolean;
    demo_password_enabled: boolean;
  } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [demoPassword, setDemoPassword] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    void api.accessSettings().then(setSettings);
  }, []);
  const save = async () => {
    const payload: { api_key?: string; demo_password?: string } = {};
    if (apiKey) payload.api_key = apiKey;
    if (demoPassword) payload.demo_password = demoPassword;
    setSettings(await api.updateAccessSettings(payload));
    setApiKey("");
    setDemoPassword("");
    setNotice("已保存");
  };
  const download = async () => {
    const url = URL.createObjectURL(await api.exportDatabase());
    const link = document.createElement("a");
    link.href = url;
    link.download = "aegismesh-database.json";
    link.click();
    URL.revokeObjectURL(url);
  };
  const upload = async (file: File) => {
    const data = JSON.parse(await file.text()) as Record<string, unknown>;
    await api.importDatabase(data, "merge");
    setNotice("已导入");
    window.setTimeout(() => window.location.reload(), 500);
  };
  return (
    <div className="access-grid">
      <section className="panel access-panel">
        <div className="panel-heading">
          <h2>访问控制</h2>
          <ShieldCheck size={18} />
        </div>
        <div className="access-form">
          <label>
            开放 API Key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                settings?.api_key_configured ? "已配置" : "输入至少 16 位"
              }
            />
          </label>
          <div className="access-status">
            <StatusDot
              status={settings?.api_key_configured ? "online" : "unknown"}
            />
            {settings?.api_key_from_environment
              ? "由环境变量管理"
              : settings?.api_key_configured
                ? "已启用"
                : "待配置"}
            {settings?.api_key_configured &&
              !settings.api_key_from_environment && (
                <button
                  onClick={async () =>
                    setSettings(
                      await api.updateAccessSettings({ clear_api_key: true }),
                    )
                  }
                >
                  清除
                </button>
              )}
          </div>
          <label>
            聊天访问密码
            <input
              type="password"
              value={demoPassword}
              onChange={(event) => setDemoPassword(event.target.value)}
              placeholder={
                settings?.demo_password_enabled ? "已启用" : "留空表示公开访问"
              }
            />
          </label>
          <div className="access-status">
            <StatusDot
              status={settings?.demo_password_enabled ? "online" : "unknown"}
            />
            {settings?.demo_password_enabled ? "已启用" : "公开访问"}
            {settings?.demo_password_enabled && (
              <button
                onClick={async () =>
                  setSettings(
                    await api.updateAccessSettings({
                      clear_demo_password: true,
                    }),
                  )
                }
              >
                关闭
              </button>
            )}
          </div>
          <button
            className="primary-button"
            disabled={
              (!apiKey && !demoPassword) ||
              Boolean(apiKey && apiKey.length < 16) ||
              Boolean(demoPassword && demoPassword.length < 8)
            }
            onClick={() => void save()}
          >
            保存
          </button>
          {notice && <span className="saved-note">{notice}</span>}
        </div>
      </section>
      <section className="panel access-panel">
        <div className="panel-heading">
          <h2>数据库</h2>
          <Database size={18} />
        </div>
        <div className="data-actions">
          <button className="secondary-button" onClick={() => void download()}>
            导出数据库
          </button>
          <label className="secondary-button">
            导入数据库
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </label>
          <p>导入采用合并模式，相同主键的记录会更新。</p>
        </div>
      </section>
    </div>
  );
}

let historySync: ConversationSync | undefined;
function currentHistorySync() {
  const owner = getConversationOwner();
  if (!owner) return undefined;
  if (historySync?.owner !== owner) historySync = new ConversationSync(owner, conversationStorageForOwner(owner), mergeHistory);
  return historySync;
}

function loadConversationIndex(): ConversationMeta[] {
  try {
    const raw = conversationStorage.getItem("aegismesh-conversations-index");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
    // Migration from old monolithic localStorage blob
    const oldBlob = conversationStorage.getItem("aegismesh-conversations");
    if (oldBlob) {
      const oldList = JSON.parse(oldBlob);
      if (Array.isArray(oldList)) {
        const index: ConversationMeta[] = [];
        for (const item of oldList) {
          if (item && item.id) {
            try {
              conversationStorage.setItem(`aegismesh-conv-${item.id}`, JSON.stringify(item));
            } catch {}
            index.push({
              id: item.id,
              title: item.title || "会话",
              session: item.session,
              agentId: item.agentId,
              messageCount: Array.isArray(item.messages) ? item.messages.length : 0,
              isGroup: item.isGroup,
              groupMemberCount: item.groupConfig?.members?.length,
              isCanvas: item.isCanvas,
            });
          }
        }
        try {
          conversationStorage.setItem("aegismesh-conversations-index", JSON.stringify(index));
        } catch {}
        return index;
      }
    }
  } catch {}
  return [];
}

function saveConversationIndex(metas: ConversationMeta[]): void {
  try {
    conversationStorage.setItem("aegismesh-conversations-index", JSON.stringify(metas));
  } catch {}
}

function loadConversationData(id: string): Conversation | null {
  try {
    const raw = conversationStorage.getItem(`aegismesh-conv-${id}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
    const oldBlob = conversationStorage.getItem("aegismesh-conversations");
    if (oldBlob) {
      const oldList = JSON.parse(oldBlob);
      if (Array.isArray(oldList)) {
        const found = oldList.find((c: any) => c && c.id === id);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

function saveConversationData(conv: Conversation): void {
  conv.session ||= `ses-${conv.id}`;
  const previous = loadConversationData(conv.id)?.messages || [];
  conv.messages = conv.messages.map((message, index) => message.historyId ? message : {
    ...message, historyId: previous[index]?.role === message.role && previous[index]?.createdAt === message.createdAt
      ? previous[index].historyId || crypto.randomUUID() : crypto.randomUUID(),
  });
  try {
    conversationStorage.setItem(`aegismesh-conv-${conv.id}`, JSON.stringify(conv));
  } catch { /* Cloud persistence below is independent of localStorage capacity. */ }
  currentHistorySync()?.enqueue(conv);
}

function formatTokensZh(num: number): string {
  if (num >= 10000) {
    const w = num / 10000;
    return `${w % 1 === 0 ? w.toFixed(0) : w.toFixed(1)}万`;
  }
  if (num >= 1000) {
    const k = num / 1000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return String(num);
}

function ContextRing({ percent }: { percent: number }) {
  const size = 16;
  const strokeWidth = 2.2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset =
    circumference - (Math.min(100, Math.max(0, percent)) / 100) * circumference;
  const isNearFull = percent >= 80;
  const strokeColor = isNearFull
    ? "var(--red)"
    : percent >= 60
      ? "var(--amber)"
      : "var(--c555550)";

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="context-ring-svg"
      aria-hidden="true"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--cd8d8d2)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 0.3s ease, stroke 0.3s ease" }}
      />
    </svg>
  );
}

function latestResult(messages: ChatMessage[]): ChatResult | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].result) return messages[index].result || null;
  }
  return null;
}

function animateStreamingText(children: ReactNode, path = "text"): ReactNode {
  return Children.map(children, (child, index) => {
    const childPath = `${path}-${index}`;
    if (typeof child === "string") {
      const characters = Array.from(child);
      const animatedFrom = Math.max(0, characters.length - 120);
      return [
        animatedFrom > 0 ? characters.slice(0, animatedFrom).join("") : null,
        ...characters.slice(animatedFrom).map((character, tailIndex) => {
          const characterIndex = animatedFrom + tailIndex;
          return (
            <span
              className="stream-character"
              key={`${childPath}-${characterIndex}`}
              style={{
                "--stream-character-delay": `${(characterIndex % 12) * 7}ms`,
              } as CSSProperties}
            >
              {character}
            </span>
          );
        }),
      ];
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) return child;
    // Nested Markdown components animate their own text exactly once.
    if (typeof child.type !== "string") return child;
    if (child.type === "pre" || child.type === "code") return child;
    if (child.props.children == null) return child;
    return cloneElement(
      child,
      undefined,
      animateStreamingText(child.props.children, childPath),
    );
  });
}

function streamingMarkdownElement(tag: string) {
  return ({ node: _node, children, ...props }: any) =>
    createElement(tag, props, animateStreamingText(children, tag));
}

const streamingMarkdownComponents = {
  p: streamingMarkdownElement("p"),
  h1: streamingMarkdownElement("h1"),
  h2: streamingMarkdownElement("h2"),
  h3: streamingMarkdownElement("h3"),
  h4: streamingMarkdownElement("h4"),
  h5: streamingMarkdownElement("h5"),
  h6: streamingMarkdownElement("h6"),
  li: streamingMarkdownElement("li"),
  blockquote: streamingMarkdownElement("blockquote"),
  td: streamingMarkdownElement("td"),
  th: streamingMarkdownElement("th"),
  table: ({ node: _node, ...props }: any) => (
    <div className="markdown-table-wrapper">
      <table {...props} />
    </div>
  ),
};

const settledMarkdownComponents = {
  table: ({ node: _node, ...props }: any) => (
    <div className="markdown-table-wrapper">
      <table {...props} />
    </div>
  ),
};

function MarkdownText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className={`message-markdown${streaming ? " streaming" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={streaming ? streamingMarkdownComponents : settledMarkdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function AgentSwitchModal({
  currentAgentName,
  targetAgentName,
  onCancel,
  onSwitchHere,
  onNewSession,
}: {
  currentAgentName: string;
  targetAgentName: string;
  onCancel: () => void;
  onSwitchHere: () => void;
  onNewSession: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-agent-switch" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-with-icon">
            <Shield className="warn-icon" size={18} />
            <strong>切换绑定智能体</strong>
          </div>
          <button className="modal-close" onClick={onCancel} title="关闭" aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-warn-text">
            ⚠️ 当前会话已绑定 <strong>{currentAgentName}</strong> 并已产生对话历史。
          </p>
          <p>
            若在当前会话切换至 <strong>{targetAgentName}</strong>，该智能体将继续沿用先前的上下文。如果这是全新的不同主题任务，建议为此智能体开启独立新会话。
          </p>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onCancel}>
            取消
          </button>
          <button className="secondary-button" onClick={onNewSession}>
            为此智能体新建会话
          </button>
          <button className="primary-button" onClick={onSwitchHere}>
            在当前会话中切换
          </button>
        </div>
      </div>
    </div>
  );
}

type LiveSubagentState = {
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

function handleSubagentEvent(
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
        : crypto.randomUUID());
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
              <span style={{ fontSize: "11px", fontWeight: 500, opacity: 0.85, background: "rgba(99, 102, 241, 0.1)", padding: "1px 6px", borderRadius: 4 }}>
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
          <div className="subagent-msg-bubble current-tool-live" style={{ padding: "8px 12px", background: "rgba(99, 102, 241, 0.06)", border: "1px dashed rgba(99, 102, 241, 0.25)", borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
              <FlowMark className="flow-mark-compact" />
              <span>正在调用工具：</span>
              <code style={{ fontSize: 11, background: "rgba(99, 102, 241, 0.12)", padding: "2px 6px", borderRadius: 4 }}>
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
          <div className="collab-bot-avatar" style={{ background: "rgba(99, 102, 241, 0.12)", color: "#4f46e5" }}>
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
          <div className="collab-bot-avatar" style={{ background: "rgba(99, 102, 241, 0.12)", color: "#4f46e5" }}>
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
                  backgroundColor: isLeader ? "rgba(99, 102, 241, 0.12)" : palette.bg,
                  color: isLeader ? "#4f46e5" : palette.color,
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

function CollaborationPanel({
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
        <summary>主智能体工具记录 · {rootTools.length}</summary>
        <ToolActivityList tools={rootTools} toolNames={toolNames} />
      </details>}
    </div>
  );
}

function BlackboardPanel({
  items,
}: {
  items: BlackboardMessage[];
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: prev[id] === false ? true : false }));
  };

  const deliverables = items.filter(
    (m) => m.type === "report" || (m.metadata?.source && String(m.metadata.source).includes("group_chat"))
  );

  if (deliverables.length === 0) {
    return (
      <div className="blackboard-empty-state">
        <div className="bb-empty-icon">
          <BookOpen size={26} />
        </div>
        <h4>暂无黑板交付物</h4>
        <p>当智能体在群聊中生成详细设计方案、数据表格或分析报告时，将严格按国家标准（GB/T 43444 / GB/T 7714）自动沉淀至此共享资产库。</p>
      </div>
    );
  }

  return (
    <div className="blackboard-panel">
      {/* 国家标准认证顶栏 */}
      <div className="blackboard-standard-banner">
        <div className="bb-std-badge-row">
          <span className="bb-std-tag">国家标准规范对齐</span>
          <span className="bb-std-code">GB/T 43444-2023</span>
          <span className="bb-std-code">GB/T 7714-2015</span>
        </div>
        <span className="bb-std-desc">
          符合多智能体协同交互规约 · 学术著录字段与可溯源 DOI 核验通过
        </span>
      </div>

      <div className="blackboard-header">
        <div className="bb-header-title">
          <Layers size={15} />
          <strong>协作黑板资产库</strong>
          <span className="bb-count-pill">{deliverables.length} 份标准案卷</span>
        </div>
      </div>

      <div className="blackboard-items-list">
        {deliverables.map((item, idx) => {
          const title: string = String(
            item.metadata?.title ||
            item.content.split("\n")[0].replace(/^#+\s*/, "").slice(0, 30) ||
            `交付物 #${idx + 1}`
          );
          const isExpanded = expandedIds[item.id] !== false;
          const artId = `GB-ART-${String(item.timestamp ? Math.floor(item.timestamp) : Date.now()).slice(-6)}-${idx + 1}`;
          const handleCopy = () => {
            navigator.clipboard.writeText(item.content);
            setCopiedId(item.id);
            setTimeout(() => setCopiedId(null), 2000);
          };

          return (
            <article key={item.id} className="blackboard-card">
              <header className="blackboard-card-header" onClick={() => toggleExpand(item.id)}>
                <div className="bb-card-meta">
                  <span className="bb-card-tag">GB 审定资产</span>
                  <strong className="bb-card-title">{title}</strong>
                  <span className="bb-card-author">{item.nickname || item.sender_name}</span>
                </div>
                <div className="bb-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="bb-action-btn"
                    onClick={handleCopy}
                    title="复制完整内容"
                  >
                    {copiedId === item.id ? <Check size={13} color="#10b981" /> : <Copy size={13} />}
                    <span>{copiedId === item.id ? "已复制" : "复制"}</span>
                  </button>
                  <button
                    type="button"
                    className="bb-action-btn"
                    onClick={() => toggleExpand(item.id)}
                    title={isExpanded ? "收起" : "展开"}
                  >
                    {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
              </header>

              {/* 国家标准审定元数据条 */}
              <div className="bb-card-audit-bar">
                <span className="bb-audit-chip">流水号: {artId}</span>
                <span className="bb-audit-chip ok">✓ GB/T 7714 格式符合</span>
                <span className="bb-audit-chip ok">✓ 版本 v1.0 审定</span>
                <span className="bb-audit-time">{formatRelative(item.timestamp)}</span>
              </div>

              {isExpanded && (
                <div className="blackboard-card-body">
                  <MarkdownText text={item.content} />
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function GroupCollaborationPanel({
  messages,
  liveBlackboardMessages,
  groupMembers,
  agents,
}: {
  messages: ChatMessage[];
  liveBlackboardMessages: BlackboardMessage[];
  groupMembers: string[];
  agents: Agent[];
}) {
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});

  const toggleThought = (id: string) => {
    setExpandedThoughts((prev) => ({ ...prev, [id]: prev[id] === false ? true : false }));
  };

  // 1. 提取所有智能体思考活动
  const thoughtItems = (liveBlackboardMessages || []).filter(
    (m) => m.metadata?.type === "thought" || m.type === "dispatch" || m.content.includes("思考与内部推理")
  );

  // 2. 提取群聊智能体接力协同轮次
  const assistantTurns = messages.filter((m) => m.role === "assistant" && m.senderName && m.senderName !== "系统");

  if (assistantTurns.length === 0 && thoughtItems.length === 0) {
    return (
      <div className="collab-empty-state">
        <div className="collab-empty-icon">
          <Activity size={26} />
        </div>
        <h4>暂无群聊协同记录</h4>
        <p>当群内智能体接力交流、委派任务或执行深度推理时，将在此实时呈现协同流转脉络与思考过程。</p>
      </div>
    );
  }

  return (
    <div className="group-collab-panel">
      {/* 协同统计概览 */}
      <div className="group-collab-header">
        <div className="collab-stat-box">
          <span className="collab-stat-val">{assistantTurns.length}</span>
          <span className="collab-stat-lbl">协同棒次</span>
        </div>
        <div className="collab-stat-box">
          <span className="collab-stat-val">{new Set(assistantTurns.map((t) => t.senderAgentId || t.senderName)).size}</span>
          <span className="collab-stat-lbl">参与专家</span>
        </div>
        <div className="collab-stat-box">
          <span className="collab-stat-val">{thoughtItems.length}</span>
          <span className="collab-stat-lbl">推理过程</span>
        </div>
      </div>

      {/* 智能体内部思考与心理推理活动 */}
      {thoughtItems.length > 0 && (
        <div className="collab-section">
          <div className="collab-section-title">
            <Sparkles size={14} color="#6366f1" />
            <span>智能体内部推理与心理活动 ({thoughtItems.length})</span>
          </div>
          <div className="collab-thought-stack">
            {thoughtItems.map((item) => {
              const isExpanded = expandedThoughts[item.id] !== false;
              const cleanContent = item.content.replace(/^💡\s*\*\*思考与内部推理\*\*：?\s*/i, "");
              return (
                <div key={item.id} className="collab-thought-card">
                  <header
                    className="collab-thought-header"
                    onClick={() => toggleThought(item.id)}
                  >
                    <div className="thought-author-row">
                      <span className="thought-avatar-chip">
                        <Bot size={13} />
                      </span>
                      <strong>{item.nickname || item.sender_name}</strong>
                      <span className="thought-role-tag">{item.role === "leader" ? "主持人" : "协同专家"}</span>
                    </div>
                    <div className="thought-toggle-row">
                      <span className="thought-time">{formatRelative(item.timestamp)}</span>
                      {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </div>
                  </header>
                  {isExpanded && (
                    <div className="collab-thought-body">
                      <MarkdownText text={cleanContent} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 多智能体接力协同流 */}
      <div className="collab-section">
        <div className="collab-section-title">
          <GitBranch size={14} color="#4f46e5" />
          <span>发言顺序</span>
        </div>
        <div className="group-collab-timeline">
          {assistantTurns.map((turn, idx) => {
            const wroteBoard = turn.text.includes("黑板");
            const mentions = [...new Set(
              (turn.text.match(/@([^\s\n，。！？、@]+)/g) || []).map((item) => item.slice(1)),
            )].slice(0, 3);
            const snippet = turn.text
              .replace(/>\s*📋[^\n]*/g, "")
              .replace(/[#>*_`]/g, "")
              .replace(/\s+/g, " ")
              .trim();
            return (
              <div key={turn.createdAt || idx} className="collab-timeline-item">
                <div className="timeline-node" />
                <div className="timeline-content">
                  <div className="timeline-meta">
                    <span className="timeline-step">{idx + 1}</span>
                    <span className="timeline-author">{turn.senderName}</span>
                    {turn.isHost && <span className="member-host-badge">主持</span>}
                  </div>
                  {(mentions.length > 0 || wroteBoard) && (
                    <p className="timeline-desc">
                      {mentions.length > 0 ? `交给 ${mentions.join("、")}` : "已写入黑板"}
                    </p>
                  )}
                  {snippet && <p className="timeline-snippet">{snippet.slice(0, 72)}</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GroupMembersPanel({
  activeConv,
  agents,
  onUpdateConfig,
  onClearChat,
  onSwitchToBlackboard,
  onMentionAgent,
}: {
  activeConv: Conversation;
  agents: Agent[];
  onUpdateConfig: (patch: Partial<GroupConfig>) => void;
  onClearChat: () => void;
  onSwitchToBlackboard: () => void;
  onMentionAgent: (name: string) => void;
}) {
  const cfg = activeConv.groupConfig || { name: activeConv.title, members: [], hostAgentId: null };
  const [name, setName] = useState(cfg.name || activeConv.title || "智能体协作讨论群");
  const [search, setSearch] = useState("");
  const [isRemoving, setIsRemoving] = useState(false);
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [addSearch, setAddSearch] = useState("");

  useEffect(() => {
    setName(activeConv.groupConfig?.name || activeConv.title || "智能体协作讨论群");
    setIsRemoving(false);
    setShowAddPicker(false);
  }, [activeConv.id, activeConv.groupConfig?.name]);

  const activeAgents = agents.filter((a) => a.active);
  const currentMemberAgents = (cfg.members || [])
    .map((id) => agents.find((a) => a.id === id))
    .filter(Boolean) as Agent[];

  const filteredMembers = currentMemberAgents.filter((a) =>
    search ? `${a.name} ${a.id} ${a.description || ""}`.toLowerCase().includes(search.toLowerCase()) : true
  );

  const availableToAdd = activeAgents.filter((a) => !(cfg.members || []).includes(a.id));
  const filteredAvailable = availableToAdd.filter((a) =>
    addSearch ? `${a.name} ${a.id} ${a.description || ""}`.toLowerCase().includes(addSearch.toLowerCase()) : true
  );

  const handleAddMember = (id: string) => {
    const nextMembers = [...(cfg.members || []), id];
    onUpdateConfig({ members: nextMembers });
  };

  const handleRemoveMember = (id: string) => {
    const nextMembers = (cfg.members || []).filter((m) => m !== id);
    const nextHost = cfg.hostAgentId === id ? null : cfg.hostAgentId;
    onUpdateConfig({ members: nextMembers, hostAgentId: nextHost });
  };

  const handleHostChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    onUpdateConfig({ hostAgentId: val ? val : null });
  };

  const handleNameBlur = () => {
    if (name.trim() && name.trim() !== cfg.name) {
      onUpdateConfig({ name: name.trim() });
    }
  };

  return (
    <div className="group-members-panel-v2">
      {/* 1. 群聊名称设置 */}
      <div className="group-panel-section">
        <label className="group-panel-label">群聊名称</label>
        <div className="group-name-input-wrap">
          <input
            type="text"
            className="group-panel-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={(e) => e.key === "Enter" && handleNameBlur()}
            placeholder="群聊名称"
          />
        </div>
      </div>

      {/* 2. 成员管理模块 */}
      <div className="group-panel-section">
        <div className="group-panel-section-header">
          <label className="group-panel-label">
            群成员 ({currentMemberAgents.length})
          </label>
          <div className="member-header-actions">
            <button
              type="button"
              className={`member-tool-btn ${showAddPicker ? "active" : ""}`}
              onClick={() => {
                setShowAddPicker((v) => !v);
                setIsRemoving(false);
              }}
            >
              <Plus size={13} />
              <span>添加</span>
            </button>
            <button
              type="button"
              className={`member-tool-btn ${isRemoving ? "danger active" : ""}`}
              onClick={() => {
                setIsRemoving((v) => !v);
                setShowAddPicker(false);
              }}
            >
              <Minus size={13} />
              <span>{isRemoving ? "完成" : "管理"}</span>
            </button>
          </div>
        </div>

        {/* 成员头像网格 - 严格对称对齐 */}
        <div className="group-matrix-grid">
          {filteredMembers.map((agent) => {
            const isHost = agent.id === cfg.hostAgentId;
            return (
              <div
                key={agent.id}
                className="group-matrix-item"
                onClick={() => onMentionAgent(agent.name)}
                title="点击在输入框 @TA"
              >
                <div className="group-matrix-avatar-wrap">
                  <div className="group-matrix-avatar">
                    <Bot size={22} />
                  </div>
                  {isHost && <span className="group-matrix-badge host">主持</span>}
                  {isRemoving && (
                    <button
                      type="button"
                      className="group-matrix-del-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveMember(agent.id);
                      }}
                      title="移出此群"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
                <span className="group-matrix-name">{agent.name}</span>
              </div>
            );
          })}
        </div>

        {/* 展开的添加成员选择器 */}
        {showAddPicker && (
          <div className="group-add-picker-panel">
            <div className="group-add-picker-header">
              <span>选择要加入群聊的智能体 ({availableToAdd.length})</span>
              <button
                type="button"
                className="quick-link-btn"
                onClick={() => setShowAddPicker(false)}
              >
                收起
              </button>
            </div>
            <input
              type="text"
              className="group-panel-input"
              placeholder="按名称或职能筛选..."
              value={addSearch}
              onChange={(e) => setAddSearch(e.target.value)}
            />
            <div className="group-add-list">
              {filteredAvailable.length === 0 ? (
                <div className="group-add-empty">暂无更多可添加的智能体</div>
              ) : (
                filteredAvailable.map((a) => (
                  <div key={a.id} className="group-add-item">
                    <div className="group-add-item-info">
                      <strong>{a.name}</strong>
                      <span className="agent-desc">{a.description || a.id}</span>
                    </div>
                    <button
                      type="button"
                      className="btn-add-agent"
                      onClick={() => handleAddMember(a.id)}
                    >
                      <Plus size={12} /> 加入
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* 3. 指定主持人 */}
      <div className="group-panel-section">
        <label className="group-panel-label">指定主持人</label>
        <select
          className="select-host-control"
          value={cfg.hostAgentId || ""}
          onChange={handleHostChange}
        >
          <option value="">群主 (用户自己主持 - 默认)</option>
          {currentMemberAgents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} (主持)
            </option>
          ))}
        </select>
        <p className="group-setting-tip">
          指定主持人时，您的发言由主持人统筹拆解并调度专家；不指定则为开放自由协作。
        </p>
      </div>

      {/* 4. 底部辅助操作 */}
      <div className="group-panel-section group-panel-actions">
        <button
          type="button"
          className="group-panel-action-btn"
          onClick={onSwitchToBlackboard}
        >
          <BookOpen size={14} />
          <span>查看协作黑板交付物</span>
          <ChevronRight size={14} />
        </button>

        <button
          type="button"
          className="btn-danger-link"
          onClick={onClearChat}
        >
          <Trash2 size={13} />
          <span>清空本群聊天记录</span>
        </button>
      </div>
    </div>
  );
}

function GroupSettingsDrawer({
  isOpen,
  mode,
  targetConv,
  agents,
  onClose,
  onSubmit,
  onClearChat,
  onViewCollaboration,
}: {
  isOpen: boolean;
  mode: "create" | "edit";
  targetConv?: Conversation | null;
  agents: Agent[];
  onClose: () => void;
  onSubmit: (config: GroupConfig) => void;
  onClearChat?: () => void;
  onViewCollaboration?: () => void;
}) {
  const [name, setName] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [isRemovingMode, setIsRemovingMode] = useState(false);
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [addSearch, setAddSearch] = useState("");

  useEffect(() => {
    if (mode === "edit" && targetConv?.groupConfig) {
      setName(targetConv.groupConfig.name || targetConv.title || "智能体协作讨论群");
      setSelectedIds(targetConv.groupConfig.members || []);
      setHostId(targetConv.groupConfig.hostAgentId ?? null);
    } else {
      setName("智能体协作讨论群");
      const defaultAgents = agents.filter((a) => a.active).slice(0, 3).map((a) => a.id);
      setSelectedIds(defaultAgents);
      // 默认用户自己主持，不强制指定为 research_leader，避免角色幻觉
      setHostId(null);
    }
    setIsRemovingMode(false);
    setShowAddPicker(false);
    setSearch("");
    setAddSearch("");
  }, [isOpen, mode, targetConv, agents]);

  if (!isOpen) return null;

  const activeAgents = agents.filter((a) => a.active);
  const currentMemberAgents = selectedIds
    .map((id) => agents.find((a) => a.id === id))
    .filter(Boolean) as Agent[];

  const filteredMembers = currentMemberAgents.filter((a) =>
    search ? `${a.name} ${a.id} ${a.description || ""}`.toLowerCase().includes(search.toLowerCase()) : true
  );

  const availableToAdd = activeAgents.filter((a) => !selectedIds.includes(a.id));
  const filteredAvailable = availableToAdd.filter((a) =>
    addSearch ? `${a.name} ${a.id} ${a.description || ""}`.toLowerCase().includes(addSearch.toLowerCase()) : true
  );

  const handleAddMember = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };

  const handleRemoveMember = (id: string) => {
    setSelectedIds((prev) => {
      const next = prev.filter((x) => x !== id);
      if (hostId === id) setHostId(null);
      return next;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (selectedIds.length === 0) return;
    onSubmit({
      name: name.trim(),
      members: selectedIds,
      hostAgentId: hostId && selectedIds.includes(hostId) ? hostId : null,
    });
    onClose();
  };

  return (
    <div className="drawer-layer group-drawer-layer">
      <button className="drawer-backdrop" onClick={onClose} aria-label="关闭侧边栏" />
      <aside className="builder-drawer group-settings-drawer">
        <div className="drawer-header group-drawer-header">
          <div className="group-drawer-title-box">
            <h2>{mode === "create" ? "新建群聊" : "群聊信息"}</h2>
            <span className="drawer-subtitle">
              {mode === "create"
                ? "选择智能体成员组建协同群组"
                : `${selectedIds.length} 位成员 · ${hostId ? `${agents.find((a) => a.id === hostId)?.name || hostId} (主持)` : "用户自己主持"}`}
            </span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="drawer-body group-drawer-body">
          {/* 搜索群成员 */}
          <div className="group-drawer-search">
            <Search size={14} />
            <input
              type="text"
              placeholder="搜索群成员..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* 成员头像网格 (微信/Grok 风格) */}
          <div className="group-matrix-container">
            <div className="group-matrix-grid">
              {filteredMembers.map((agent) => {
                const isHost = hostId === agent.id;
                return (
                  <div key={agent.id} className="group-matrix-item">
                    <div className="group-matrix-avatar-wrap">
                      <div className="group-matrix-avatar">
                        <Bot size={18} />
                      </div>
                      {isHost && <span className="group-matrix-badge host">主持</span>}
                      {isRemovingMode && (
                        <button
                          type="button"
                          className="group-matrix-del-btn"
                          onClick={() => handleRemoveMember(agent.id)}
                          title="移出此成员"
                        >
                          <Minus size={12} />
                        </button>
                      )}
                    </div>
                    <span className="group-matrix-name" title={agent.name}>
                      {agent.name}
                    </span>
                  </div>
                );
              })}

              {/* + 添加 按钮 */}
              <button
                type="button"
                className={`group-matrix-action-card ${showAddPicker ? "active" : ""}`}
                onClick={() => {
                  setShowAddPicker((v) => !v);
                  setIsRemovingMode(false);
                }}
                title="添加新成员"
              >
                <div className="group-matrix-dashed-box">
                  <Plus size={20} />
                </div>
                <span>添加</span>
              </button>

              {/* - 移出 按钮 */}
              <button
                type="button"
                className={`group-matrix-action-card ${isRemovingMode ? "active" : ""}`}
                onClick={() => {
                  setIsRemovingMode((v) => !v);
                  setShowAddPicker(false);
                }}
                title="移出成员"
              >
                <div className="group-matrix-dashed-box">
                  <Minus size={20} />
                </div>
                <span>{isRemovingMode ? "完成" : "移出"}</span>
              </button>
            </div>
          </div>

          {/* 展开的添加成员选择面板 */}
          {showAddPicker && (
            <div className="group-add-picker-panel">
              <div className="group-add-picker-header">
                <strong>添加智能体至本群</strong>
                <button
                  type="button"
                  className="quick-link-btn"
                  onClick={() => setShowAddPicker(false)}
                >
                  收起
                </button>
              </div>
              <div className="group-drawer-search inline">
                <Search size={13} />
                <input
                  type="text"
                  placeholder="筛选可添加的智能体..."
                  value={addSearch}
                  onChange={(e) => setAddSearch(e.target.value)}
                />
              </div>
              <div className="group-add-list">
                {filteredAvailable.length === 0 ? (
                  <div className="group-add-empty">无更多可添加的智能体</div>
                ) : (
                  filteredAvailable.map((ag) => (
                    <div key={ag.id} className="group-add-item">
                      <div className="group-add-item-info">
                        <strong>{ag.name}</strong>
                        <span className="agent-desc">{ag.description || "专业领域智能体"}</span>
                      </div>
                      <button
                        type="button"
                        className="btn-add-agent"
                        onClick={() => handleAddMember(ag.id)}
                      >
                        <Plus size={13} /> 加入
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* 微信风格群设置清单 */}
          <div className="group-settings-list">
            <div className="group-setting-row">
              <label>群聊名称</label>
              <input
                type="text"
                className="group-inline-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="输入群聊名称..."
                required
              />
            </div>

            <div className="group-setting-row">
              <label>指定主持人</label>
              <select
                value={hostId || ""}
                onChange={(e) => setHostId(e.target.value ? e.target.value : null)}
                className="select-host-control"
              >
                <option value="">自己主持 (用户担任群主)</option>
                {selectedIds.map((id) => {
                  const a = agents.find((ag) => ag.id === id);
                  return (
                    <option key={id} value={id}>
                      {a ? a.name : id} (主持)
                    </option>
                  );
                })}
              </select>
              <span className="group-setting-tip">
                指定主持人时，您的发言由主持人统筹拆解并调度专家；不指定则为开放自由协作。
              </span>
            </div>

            {mode === "edit" && onViewCollaboration && (
              <div className="group-setting-row clickable" onClick={onViewCollaboration}>
                <div className="group-setting-flex">
                  <div>
                    <label>查看协作黑板与协同过程</label>
                    <span className="group-setting-tip">
                      查看所有智能体沉淀的黑板成果与推理过程
                    </span>
                  </div>
                  <ChevronRight size={16} className="setting-chevron" />
                </div>
              </div>
            )}

            {mode === "edit" && onClearChat && (
              <div className="group-setting-row danger-row">
                <button
                  type="button"
                  className="btn-danger-link"
                  onClick={onClearChat}
                >
                  <Trash2 size={14} /> 清空本群聊天记录
                </button>
              </div>
            )}
          </div>

          <div className="drawer-footer group-drawer-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={selectedIds.length === 0 || !name.trim()}
            >
              {mode === "create" ? "创建群聊" : "保存并应用"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function CanvasFloatingAssistant({
  messages,
  sessionResults,
  activityControls,
  showAllMessages: _showAllMessages,
  setShowAllMessages: _setShowAllMessages,
  sending,
  input,
  setInput,
  handleSend,
  handleKeyDown,
  handleCompositionStart,
  handleCompositionEnd,
  attachments,
  uploading,
  fileInputRef,
  removeAttachment,
  agents,
  agentId,
  handleAgentSelect,
  inspector,
  activeDispatches,
  dynamicDiscoveredCandidates: _dynamicDiscoveredCandidates,
  formatMs,
  liveSubagents,
  liveBlackboardMessages,
  toolNames,
  onClearHistory,
  canvasData,
  composerTextareaRef,
  openRequest,
}: {
  messages: ChatMessage[];
  sessionResults: ChatResult[];
  activityControls: ReactNode;
  showAllMessages: boolean;
  setShowAllMessages: (val: boolean) => void;
  sending: boolean;
  sendingSince: number | null;
  input: string;
  setInput: (val: string | ((prev: string) => string)) => void;
  handleSend: (overrideInput?: string) => void;
  handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  handleCompositionStart?: () => void;
  handleCompositionEnd?: () => void;
  attachments: Attachment[];
  uploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  removeAttachment: (id: string) => void;
  agents: Agent[];
  agentId: string;
  handleAgentSelect: (id: string) => void;
  inspector: ChatResult | null;
  setInspector: (r: ChatResult | null) => void;
  activeDispatches: any[];
  dynamicDiscoveredCandidates: any[];
  metricLabels: Record<string, string>;
  formatMs: (ms: number) => string;
  liveSubagents: LiveSubagentState[];
  liveBlackboardMessages: BlackboardMessage[];
  toolNames: Record<string, string>;
  onClearHistory: () => void;
  canvasData: CanvasDocument | null;
  composerTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  openRequest: number;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"chat" | "route" | "collab" | "menu">("chat");
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openRequest > 0) {
      setTab("chat");
      setCollapsed(false);
    }
  }, [openRequest]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (!collapsed && tab === "chat" && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages, sending, collapsed, tab]);

  const selectedAgent = agents.find((a) => a.id === agentId);

  return (
    <>
    <button type="button" className={`canvas-floating-mobile-pill ${collapsed ? "" : "hidden"}`} aria-label="展开智能协同助手" tabIndex={collapsed ? 0 : -1} onClick={() => { setExpanded(false); setCollapsed(false); }}>
      <Sparkles size={16} /><span>智能协同助手</span>
    </button>
    <button type="button" className={`canvas-floating-backdrop ${collapsed ? "collapsed" : ""}`} aria-label="收起协同助手" tabIndex={collapsed ? -1 : 0} onClick={() => { setCollapsed(true); setExpanded(false); }} />
    <div className={`canvas-floating-assistant ${collapsed ? "collapsed" : ""} ${expanded ? "expanded" : ""}`}>
      <button type="button" className="canvas-floating-pill" onClick={() => setCollapsed(false)} title="展开智能协同助手" aria-label="展开智能协同助手" tabIndex={collapsed ? 0 : -1}>
        <Sparkles size={16} className="sparkle-icon" />
        <span className="pill-title">智能协同助手</span>
        {sending && <span className="pill-pulse-dot" />}
      </button>
      <header className="floating-assistant-header">
        <div className="header-brand">
          <Sparkles size={16} className="sparkle-icon" />
          <strong>协同助手</strong>
          <span className={`status-indicator ${sending ? "busy" : "ready"}`}>
            <span className="status-dot" />
            <span>{sending ? "处理中..." : "就绪"}</span>
          </span>
        </div>

        <div className="floating-tabs" role="tablist" style={{ "--pill-index": ["chat", "route", "collab", "menu"].indexOf(tab) } as CSSProperties}>
          <button
            type="button"
            className={`floating-tab ${tab === "chat" ? "active" : ""}`}
            onClick={() => setTab("chat")}
            role="tab" aria-label="对话" title="对话" aria-selected={tab === "chat"}
          >
            <MessageSquare size={13} />
            <span>对话</span>
          </button>
          <button
            type="button"
            className={`floating-tab ${tab === "route" ? "active" : ""}`}
            onClick={() => setTab("route")}
            role="tab" aria-label="路由" title="路由" aria-selected={tab === "route"}
          >
            <Route size={13} />
            <span>路由</span>
          </button>
          <button
            type="button"
            className={`floating-tab ${tab === "collab" ? "active" : ""}`}
            onClick={() => setTab("collab")}
            role="tab" aria-label="协作" title="协作" aria-selected={tab === "collab"}
          >
            <Users size={13} />
            <span>协作</span>
          </button>
          <button
            type="button"
            className={`floating-tab ${tab === "menu" ? "active" : ""}`}
            onClick={() => setTab("menu")}
            role="tab" aria-label="菜单" title="菜单" aria-selected={tab === "menu"}
          >
            <SlidersHorizontal size={13} />
            <span>菜单</span>
          </button>
        </div>

        <div className="floating-window-controls">
          <button type="button" className="floating-resize-btn" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? "缩小协同助手" : "放大协同助手"} title={expanded ? "缩小" : "放大"}>
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            type="button"
            className="floating-minimize-btn"
            onClick={() => { setCollapsed(true); setExpanded(false); }}
            title="最小化为浮标"
          >
            <Minus size={15} />
          </button>
        </div>
      </header>

      <div className="floating-assistant-body">
        {tab === "chat" && (
          <div className="floating-chat-container">
            <div className="floating-chat-thread" ref={threadRef}>
              {messages.length === 0 ? (
                <div className="floating-hero">
                  <div className="floating-hero-icon">
                    <Sparkles size={20} />
                  </div>
                  <h3>智能体协同写作</h3>
                  <p>在下方输入写作目标或修改指令，智能体会主动直接编辑画布。</p>
                  <div className="floating-suggestions">
                    {[
                      "根据我的研究主题起草报告大纲，并写入画布",
                      "整理上传材料的关键证据，补充到画布对应章节",
                      "检查画布中的论证与引文，列出待核实之处",
                    ].map((sug) => (
                      <button
                        key={sug}
                        type="button"
                        className="floating-sug-item"
                        onClick={() => {
                          setInput(sug);
                          composerTextareaRef.current?.focus();
                        }}
                      >
                        <span>{sug}</span>
                        <ArrowRight size={12} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="floating-messages-list">
                  {messages.map((message, idx) => (
                    <div key={idx} className={`floating-msg-bubble ${message.role}`}>
                      <div className="msg-header">
                        <span className="msg-sender">
                          {message.role === "user"
                            ? "你"
                            : message.result?.selected_agent?.name ||
                              selectedAgent?.name ||
                              "协调智能体"}
                        </span>
                        {message.streaming && sending && idx === messages.length - 1 && (
                          <span className="msg-streaming-indicator">
                            <FlowMark className="flow-mark-compact" /> 正在落笔...
                          </span>
                        )}
                      </div>
                      {message.attachments && message.attachments.length > 0 && (
                        <div className="floating-msg-attachments">
                          {message.attachments.map((att) => (
                            <span key={att.file_id} className="att-pill">
                              <FileText size={11} /> {att.filename}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="msg-content">
                        <MarkdownText text={message.text} streaming={Boolean(message.streaming && sending)} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <form
              className="floating-composer"
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
            >
              {attachments.length > 0 && (
                <div className="floating-composer-attachments">
                  {attachments.map((att) => (
                    <span key={att.file_id} className="att-chip">
                      <FileText size={11} />
                      <span>{att.filename}</span>
                      <button type="button" onClick={() => removeAttachment(att.file_id)}>
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="floating-input-row">
                <textarea
                  ref={composerTextareaRef}
                  className="floating-textarea"
                  value={input}
                  placeholder="描述要写入或修改的内容"
                  rows={2}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                />
              </div>
              <div className="floating-actions-row">
                <div className="actions-left">
                  <button
                    type="button"
                    className="floating-upload-btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    title="上传学术文献、论文或图片"
                  >
                    <Paperclip size={13} />
                    <span>{uploading ? "解析中" : "上传材料"}</span>
                  </button>
                  <AgentPicker
                    className="floating-agent-dropdown"
                    value={agentId}
                    onChange={handleAgentSelect}
                    agents={agents}
                  />
                </div>
                <button
                  type="submit"
                  className="floating-send-btn"
                  disabled={!input.trim() && attachments.length === 0}
                  title="发送指令"
                >
                  <Send size={14} />
                </button>
              </div>
            </form>
          </div>
        )}

        {tab === "route" && (
          <div className="floating-panel-scroll">
            <div className="route-target-box">
              <span>当前主控智能体</span>
              <strong>
                {inspector?.selected_agent?.name ||
                  selectedAgent?.name ||
                  "科研智能体协作平台"}
              </strong>
              {sending && (
                <div className="route-running-pulse">
                  <FlowMark className="flow-mark-compact" />
                  <span>调度执行中...</span>
                </div>
              )}
            </div>

            {activeDispatches.length > 0 && (
              <div className="route-section-group">
                <div className="route-section-title">
                  <GitBranch size={13} color="#6366f1" />
                  <span>本轮实时调度智能体 ({activeDispatches.length})</span>
                </div>
                <div className="route-dispatches-list">
                  {activeDispatches.map((disp) => <DispatchCard key={`${disp.id}-${disp.task}`} dispatch={disp} />)}
                </div>
              </div>
            )}

            {inspector?.candidates && inspector.candidates.length > 0 && (
              <div className="candidate-scores">
                <div className="route-section-title">
                  <SlidersHorizontal size={13} color="var(--c888882)" />
                  <span>初选评估与综合打分</span>
                </div>
                {inspector.candidates.map((candidate) => (
                  <div key={candidate.agent_id} className="candidate-item">
                    <div>
                      <span className="rank">{candidate.eligible ? candidate.rank : "—"}</span>
                      <strong>{candidate.agent_name}</strong>
                      <b>{candidate.eligible ? candidate.score : "未入选"}</b>
                    </div>
                    {candidate.eligible && <ScoreBar value={candidate.score} />}
                  </div>
                ))}
              </div>
            )}

            {inspector?.usage && (
              <div className="usage-box">
                <div>
                  <span>调用</span>
                  <strong>{inspector.usage.llm_calls}</strong>
                </div>
                <div>
                  <span>输入</span>
                  <strong>{inspector.usage.prompt_tokens}</strong>
                </div>
                <div>
                  <span>输出</span>
                  <strong>{inspector.usage.completion_tokens}</strong>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "collab" && (
          <div className="floating-panel-scroll">
            <CollaborationPanel
              inspector={inspector}
              messages={messages}
              sessionResults={sessionResults}
              liveSubagents={liveSubagents}
              liveBlackboardMessages={liveBlackboardMessages}
              toolNames={toolNames}
            />
            {activityControls}
          </div>
        )}

        {tab === "menu" && (
          <div className="floating-panel-scroll floating-menu-panel">
            <div className="menu-group">
              <label>切换主控智能体</label>
              <AgentPicker
                value={agentId}
                onChange={handleAgentSelect}
                agents={agents}
              />
            </div>

            <div className="menu-group">
              <label>画布快捷操作</label>
              <div className="menu-btn-grid">
                <button
                  type="button"
                  className="menu-action-btn"
                  onClick={() => {
                    const blob = new Blob([canvasData?.content || ""], { type: "text/markdown" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${canvasData?.title || "画布文稿"}.md`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Download size={14} />
                  <span>导出 Markdown 文件</span>
                </button>
                <button
                  type="button"
                  className="menu-action-btn danger"
                  onClick={onClearHistory}
                >
                  <Trash2 size={14} />
                  <span>清空历史对话</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

export function ChatDemo({ onComplete }: { onComplete: () => Promise<void> }) {
  const sync = currentHistorySync();
  const [historyError, setHistoryError] = useState('');
  const [conversations, setConversations] =
    useState<ConversationMeta[]>(loadConversationIndex);
  const [activeId, setActiveId] = useState(
    () => conversations[0]?.id || crypto.randomUUID(),
  );
  const activeMeta = conversations.find((item) => item.id === activeId);
  const initialActive = loadConversationData(activeId);
  const [messages, setMessages] = useState<ChatMessage[]>(
    initialActive?.messages || [],
  );
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendingSince, setSendingSince] = useState<number | null>(null);
  const [feedbackBusy, setFeedbackBusy] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState(initialActive?.agentId || activeMeta?.agentId || "");
  const [structuredEnabled, setStructuredEnabled] = useState(false);
  const [structuredSkill, setStructuredSkill] = useState('');
  const [structuredValues, setStructuredValues] = useState<Record<string, string>>({});
  const [structuredError, setStructuredError] = useState('');
  const structuredDraftRef = useRef<StructuredTaskOptions | undefined>(undefined);
  const structuredAgent = agents.find(agent => agent.id === agentId);
  useEffect(() => {
    const draft = structuredDraftRef.current;
    structuredDraftRef.current = undefined;
    setStructuredEnabled(Boolean(draft) && Boolean(structuredAgent?.structured_io_enabled));
    setStructuredSkill(draft?.requested_skill || '');
    setStructuredValues(inputValues(draft?.input_data, taskSchemas(structuredAgent, draft?.requested_skill).input));
    setStructuredError('');
  }, [agentId, activeId, structuredAgent?.structured_io_enabled]);
  const [bountyEnabled, setBountyEnabled] = useState(false);
  const [executionMode, setExecutionMode] = useState<'route' | 'bounty'>('route');
  const [pendingAgentSwitch, setPendingAgentSwitch] = useState<{
    targetId: string;
    targetName: string;
  } | null>(null);
  const [liveSubagents, setLiveSubagents] = useState<Record<string, LiveSubagentState>>({});
  const [liveBlackboardMessages, setLiveBlackboardMessages] = useState<BlackboardMessage[]>([]);
  const [session, setSession] = useState<string | undefined>(initialActive?.session || activeMeta?.session);
  const sessionRef = useRef(session);
  const activeIdRef = useRef(activeId);
  const taskConvRef = useRef<string | null>(null); // 正在运行的任务所属会话
  const streamTextRef = useRef(""); // 流式累积文本（切走后回来也能续上）
  const lastStreamSaveRef = useRef(0);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const [inspector, setInspector] = useState<ChatResult | null>(
    latestResult(initialActive?.messages || []),
  );
  const [sessionActivity, setSessionActivity] = useState<{ session: string; results: ChatResult[]; next: string | null; error?: string }>({ session: "", results: [], next: null });
  const [activityRefresh, setActivityRefresh] = useState(0);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = async () => {
      let stillWorking = sending;
      try {
        const page = await api.sessionActivity(session);
        stillWorking ||= page.items.some(item => item.status === "working" || item.status === "routing");
        if (cancelled || activeIdRef.current !== activeId) return;
        setSessionActivity(old => ({ session, results: mergeSessionResults(session,
          old.session === session ? old.results : [], page.items),
          next: old.session === session && old.results.length > page.items.length ? old.next : page.next_before }));
      } catch (error) {
        if (!cancelled) setSessionActivity(old => ({ session,
          results: old.session === session ? old.results : [], next: old.session === session ? old.next : null,
          error: error instanceof Error ? error.message : "协作记录加载失败" }));
      } finally {
        if (!cancelled && stillWorking) timer = setTimeout(sync, 5000);
      }
    };
    void sync();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [activeId, session, sending, activityRefresh]);
  const loadMoreActivity = async () => {
    if (!session || sessionActivity.session !== session || !sessionActivity.next) return;
    try {
      const page = await api.sessionActivity(session, sessionActivity.next);
      if (activeIdRef.current !== activeId) return;
      setSessionActivity(old => ({ session, results: mergeSessionResults(session, old.results, page.items), next: page.next_before }));
    } catch (error) {
      if (activeIdRef.current === activeId) setSessionActivity(old => ({ ...old, error: error instanceof Error ? error.message : "协作记录加载失败" }));
    }
  };
  const [detail, setDetail] = useState<"route" | "collaboration" | "members" | "blackboard" | "canvas">(
    initialActive?.isGroup || activeMeta?.isGroup ? "members" : initialActive?.isCanvas || activeMeta?.isCanvas ? "canvas" : "route",
  );
  const [isCanvasConv, setIsCanvasConv] = useState(
    !Boolean(initialActive?.isGroup || activeMeta?.isGroup) &&
      Boolean(initialActive?.isCanvas || activeMeta?.isCanvas),
  );
  const [canvasMobileView, setCanvasMobileView] = useState<"canvas" | "chat">("canvas");
  const [canvasAssistantOpenRequest, setCanvasAssistantOpenRequest] = useState(0);
  const [canvasData, setCanvasData] = useState<CanvasDocument | null>(
    latestResult(initialActive?.messages || [])?.result_data?.canvas || null,
  );
  const [content, setContent] = useState<"chat" | "api">("chat");
  const [queue, setQueueState] = useState<QueuedTask[]>(initialActive?.queue || []);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [settings, setSettings] = useState<UserSettings>(loadSettings);
  const [initialSettingsSection] = useState(() => requestedSettings(window.location));
  const [settingsOpen, setSettingsOpen] = useState(Boolean(initialSettingsSection));
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(initialSettingsSection || 'general');
  useEffect(() => {
    if (initialSettingsSection) window.history.replaceState(null, '', workbenchAfterSettings(window.location));
  }, [initialSettingsSection]);
  const [newChatDropdownOpen, setNewChatDropdownOpen] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupModalMode, setGroupModalMode] = useState<"create" | "edit">("create");
  const [groupModalTargetId, setGroupModalTargetId] = useState<string | null>(null);

  // 确保群聊与单聊视图的 Tab 始终合法隔离
  useEffect(() => {
    const meta = conversations.find((c) => c.id === activeId);
    if (meta?.isGroup) {
      if (detail === "route") {
        setDetail("members");
      }
    } else {
      if (detail === "members") {
        setDetail("route");
      }
    }
  }, [activeId, conversations, detail]);

  // 全量汇总黑板交付资产 (当前实时消息 + 历史消息持久提取)
  const blackboardDeliverables = useMemo<BlackboardMessage[]>(() => {
    const list: BlackboardMessage[] = [];
    const seen = new Set<string>();

    for (const msg of liveBlackboardMessages) {
      if (msg.type === "report" || String(msg.metadata?.source || "").startsWith("group_chat")) {
        const key = msg.metadata?.title ? `title:${msg.metadata.title}` : msg.id;
        if (!seen.has(key)) {
          seen.add(key);
          list.push(msg);
        }
      }
    }

    for (const m of messages) {
      const bb = (m.result?.result_data as any)?.shared_context?.blackboard_messages || [];
      for (const msg of bb) {
        if (msg.type === "report" || String(msg.metadata?.source || "").startsWith("group_chat")) {
          const key = msg.metadata?.title ? `title:${msg.metadata.title}` : msg.id;
          if (!seen.has(key)) {
            seen.add(key);
            list.push(msg);
          }
        }
      }
      if (m.text && m.text.includes("```blackboard")) {
        const bbRegex = /```blackboard:?([^\n\r]*)\n([\s\S]*?)```/gi;
        let match;
        while ((match = bbRegex.exec(m.text)) !== null) {
          const title = (match[1] || "").trim() || "工作交付物";
          const content = (match[2] || "").trim();
          const key = `title:${title}`;
          if (!seen.has(key) && content) {
            seen.add(key);
            list.push({
              id: `extracted_${title}_${m.createdAt || Date.now()}`,
              sender_id: m.senderAgentId || "agent",
              sender_name: m.senderName || "智能体",
              nickname: `@${m.senderName || "智能体"}`,
              role: m.isHost ? "leader" : "expert",
              type: "report",
              content: `# ${title}\n\n${content}`,
              timestamp: (m.createdAt || Date.now()) / 1000,
              metadata: { title, source: "group_chat_history" },
            });
          }
        }
      }
    }
    return list;
  }, [liveBlackboardMessages, messages]);

  // 本轮实时调度智能体列表（包含实时流式运行中与已完成/异常的派发）
  const activeDispatches = useMemo(() => {
    const list: Array<{
      id: string;
      name: string;
      task: string;
      status: string;
      latency_ms?: number;
      error?: string;
    }> = [];
    const seen = new Set<string>();
    for (const sub of Object.values(liveSubagents)) {
      const key = `${sub.agent_id}-${sub.task}`;
      if (!seen.has(key)) {
        seen.add(key);
        list.push({
          id: sub.agent_id,
          name: sub.agent_name || sub.agent_id,
          task: sub.task,
          status: sub.status,
          latency_ms: sub.latency_ms,
          error: sub.error,
        });
      }
    }
    if (inspector?.result_data?.collaborations) {
      for (const c of inspector.result_data.collaborations) {
        const key = `${c.agent_id}-${c.task}`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({
            id: c.agent_id,
            name: c.agent_name || c.agent_id,
            task: c.task,
            status: c.status,
            latency_ms: c.latency_ms,
            error: c.error,
          });
        }
      }
    }
    return list;
  }, [liveSubagents, inspector]);

  // 本轮动态发现的外部/同伴候选列表
  const dynamicDiscoveredCandidates = useMemo(() => {
    const dynamicList: Array<{
      id: string;
      name: string;
      description: string;
      source: string;
      match_score?: number;
      eligible?: boolean;
    }> = [];
    const seen = new Set<string>();
    for (const m of messages.slice(-5)) {
      for (const t of m.result?.result_data?.tool_executions || []) {
        if (t.name === "list_agents" && t.output) {
          try {
            const parsed = typeof t.output === "string" ? JSON.parse(t.output) : t.output;
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (item.agent_id && !seen.has(item.agent_id)) {
                  seen.add(item.agent_id);
                  dynamicList.push({
                    id: item.agent_id,
                    name: item.name || item.agent_id,
                    description: item.description || "全网发现协同同伴",
                    source: item.source === "adp_network" ? "ADP 全网发现" : (item.source || "协同同伴"),
                    match_score: typeof item.match_score === "number" ? item.match_score : undefined,
                    eligible: typeof item.eligible === "boolean" ? item.eligible : undefined,
                  });
                }
              }
            }
          } catch {}
        }
      }
    }
    return dynamicList;
  }, [messages]);

  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionCursorPos, setMentionCursorPos] = useState(0);

  useEffect(() => {
    if (!mentionMenuOpen) return;
    const handleClick = () => setMentionMenuOpen(false);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [mentionMenuOpen]);

  useEffect(() => {
    if (!newChatDropdownOpen) return;
    const handleClose = () => setNewChatDropdownOpen(false);
    window.addEventListener("click", handleClose);
    return () => window.removeEventListener("click", handleClose);
  }, [newChatDropdownOpen]);

  const updateSettings = (patch: Partial<UserSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveSettings(next);
      applyTheme(next);
      return next;
    });
  };
  const queueRef = useRef(queue);
  const sendingRef = useRef(false);
  const currentTaskIdRef = useRef<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);

  const handleFileUpload = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const uploaded = await api.uploadFile(file);
        if (uploaded && uploaded.ok) {
          setAttachments((prev) => [
            ...prev,
            {
              file_id: uploaded.file_id,
              filename: uploaded.filename,
              content_type: uploaded.content_type,
              size: uploaded.size,
              url: uploaded.url,
              is_image: uploaded.is_image,
              extracted_text: uploaded.extracted_text,
              extracted_text_preview: uploaded.extracted_text_preview,
              text_length: uploaded.text_length,
            },
          ]);
        }
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "文件上传失败");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };
  const abortControllerRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef<boolean>(false);
  const stopQueueRef = useRef<boolean>(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const compactSidebar = useCompactSidebar();
  const historyVisible = compactSidebar ? mobileHistoryOpen : !historyCollapsed;
  const inspectorVisible = compactSidebar ? mobileInspectorOpen : !inspectorCollapsed;
  useEffect(() => {
    if (!compactSidebar || (!mobileHistoryOpen && !mobileInspectorOpen)) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setMobileHistoryOpen(false);
      setMobileInspectorOpen(false);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [compactSidebar, mobileHistoryOpen, mobileInspectorOpen]);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const viewportLimit = Math.min(window.innerHeight * 0.28, 220);
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 36), viewportLimit);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > viewportLimit ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    const composer = composerRef.current;
    const stage = composer?.parentElement;
    if (!composer || !stage || typeof ResizeObserver === "undefined") return;
    const syncHeight = () => {
      stage.style.setProperty("--composer-height", `${composer.getBoundingClientRect().height}px`);
    };
    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(composer);
    return () => {
      observer.disconnect();
      stage.style.removeProperty("--composer-height");
    };
  }, []);

  useEffect(() => {
    if (!contextMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [contextMenuOpen]);

  const setQueue = (
    next: QueuedTask[] | ((items: QueuedTask[]) => QueuedTask[]),
  ) => {
    setQueueState((items) => {
      const value = typeof next === "function" ? next(items) : next;
      queueRef.current = value;
      return value;
    });
  };

  const handleStopTask = async () => {
    stopRequestedRef.current = true;
    const abortCtrl = abortControllerRef.current;
    if (abortCtrl) {
      abortCtrl.abort();
    }
    const taskId = currentTaskIdRef.current;
    if (taskId) {
      void api.cancelTask(taskId).catch((err) => {
        console.warn("取消任务请求失败:", err);
      });
    }
    if (!abortCtrl) {
      sendingRef.current = false;
      setSending(false);
      setSendingSince(null);
      setLiveSubagents({});
      setLiveBlackboardMessages([]);
    }
  };

  const handleStopAll = async () => {
    stopQueueRef.current = true;
    setQueue([]);
    await handleStopTask();
  };

  useEffect(() => {
    if (!messages.length) return;
    const existing = loadConversationData(activeId);
    const title =
      existing?.isGroup
        ? (existing.groupConfig?.name || existing.title || "智能体协作讨论群")
        : messages.find((item) => item.role === "user")?.text.slice(0, 32) || "会话";
    const conversation: Conversation = {
      id: activeId,
      title,
      session: session || existing?.session,
      agentId,
      messages,
      queue,
      isGroup: existing?.isGroup,
      groupConfig: existing?.groupConfig,
      isCanvas: !existing?.isGroup && isCanvasConv,
    };
    const lastMessage = messages.at(-1);
    const previousMessage = existing?.messages.at(-1);
    const hasNewActivity = existing?.messages.length !== messages.length ||
      previousMessage?.text !== lastMessage?.text ||
      previousMessage?.result?.invocation_id !== lastMessage?.result?.invocation_id;
    saveConversationData(conversation);
    setConversations((items) => {
      const meta = mergeConversationMeta(items.find(item => item.id === activeId), {
        id: activeId,
        title,
        session: conversation.session,
        agentId,
        messageCount: messages.length,
        isGroup: existing?.isGroup,
        groupMemberCount: existing?.groupConfig?.members?.length,
        isCanvas: !existing?.isGroup && isCanvasConv,
      }, hasNewActivity ? Date.now() : undefined);
      const next = [meta, ...items.filter((item) => item.id !== activeId)];
      saveConversationIndex(next);
      return next;
    });
  }, [activeId, messages, session, agentId, queue, isCanvasConv]);

  useEffect(() => {
    const refreshAgents = () => Promise.all([api.agents(), api.chatConfig()])
      .then(([list, runtime]) => {
        setBountyEnabled(Boolean(runtime.bounty_enabled));
        if (!runtime.bounty_enabled) setExecutionMode('route');
        const selectable = list.filter(
          (agent) =>
            agent.active &&
            (!runtime.interop_compatibility || agent.transport === "aip-rpc" || (agent.registration_status === "approved" && Boolean(agent.aic) && !agent.aic.startsWith("local:"))) &&
            (agent.usage_mode === "internal" ||
              agent.usage_mode === "both" ||
              (agent.transport === "aip-rpc" && agent.usage_mode === "external")),
        );
        setAgents(selectable);
        setAgentId((curr) => {
          if (curr && selectable.some((a) => a.id === curr)) return curr;
          if (
            activeMeta?.agentId &&
            selectable.some((a) => a.id === activeMeta.agentId)
          )
            return activeMeta.agentId;
          if (runtime.interop_compatibility && selectable.some((a) => a.id === runtime.default_coordinator_id)) return runtime.default_coordinator_id!;
          return defaultCoordinatorId(selectable, activeMeta?.isCanvas);
        });
      })
      .catch(() => undefined);
    void refreshAgents();
    window.addEventListener("focus", refreshAgents);
    return () => window.removeEventListener("focus", refreshAgents);
  }, []);

  useEffect(() => {
    if (agents.length && (!agents.some((agent) => agent.id === agentId)
        || (executionMode === 'bounty' && agents.find(agent => agent.id === agentId)?.role !== 'leader'))) {
      setAgentId(defaultCoordinatorId(agents, isCanvasConv));
    }
  }, [agents, agentId, isCanvasConv, executionMode]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const thread = document.querySelector<HTMLElement>(".chat-thread");
      if (!thread) return;
      // A blank conversation is a landing page, not a transcript. Never move
      // its welcome heading out of view just because the suggestions overflow.
      if (messages.length === 0) {
        thread.scrollTo({ top: 0, behavior: "instant" });
        return;
      }
      const distanceFromBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
      const streaming = Boolean(messages.at(-1)?.streaming);
      // Keep following a live answer only while the reader is already near its tail.
      // Scrolling upward is an explicit user action and should never be overridden.
      if ((streaming && distanceFromBottom > 180) || distanceFromBottom > 900) return;
      thread.scrollTo({
        top: thread.scrollHeight,
        behavior: streaming ? "auto" : "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, sending]);

  const openConversation = (target: ConversationMeta) => {
    setExecutionMode('route');
    activeIdRef.current = target.id;
    setLiveSubagents({});
    setLiveBlackboardMessages([]);
    setActiveId(target.id);
    const data = loadConversationData(target.id);
    const taskStillRunning =
      sendingRef.current && taskConvRef.current === target.id;
    const msgs = (data?.messages || []).map((m) =>
      m.streaming && !taskStillRunning
        ? { ...m, streaming: false, text: m.text || "（任务已中断）" }
        : m,
    );
    setMessages(msgs);
    // 打开历史会话：直接瞬时定位到最新消息（smooth 会从顶部滚很久，像"蹦到前面"）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const thread = document.querySelector<HTMLElement>(".chat-thread");
        if (thread) thread.scrollTo({ top: msgs.length ? thread.scrollHeight : 0, behavior: "instant" });
      });
    });
    setShowAllMessages(false);
    setSession(data?.session || target.session);
    sessionRef.current = data?.session || target.session;
    const savedCanvas = latestResult(msgs)?.result_data?.canvas || null;
    const canvasConversation = !Boolean(target.isGroup || data?.isGroup) &&
      Boolean(target.isCanvas || data?.isCanvas || savedCanvas);
    setAgentId(
      data?.agentId ||
        target.agentId ||
        defaultCoordinatorId(agents, canvasConversation),
    );
    setInspector(latestResult(msgs));
    setIsCanvasConv(canvasConversation);
    if (canvasConversation) void import("./CanvasWorkspace");
    setCanvasData(savedCanvas);
    setCanvasMobileView("canvas");
    if (savedCanvas?.id && (data?.session || target.session)) {
      void api.getSessionCanvas((data?.session || target.session)!).then((fresh) => {
        if (activeIdRef.current === target.id) setCanvasData(fresh);
      }).catch(() => undefined);
    }
    setQueue(data?.queue || []);
    setContent("chat");
    setMobileHistoryOpen(false);
    setDetail(target.isGroup ? "members" : canvasConversation ? "canvas" : "route");
    if (canvasConversation) setInspectorCollapsed(false);
    if (sync && target.session && !taskStillRunning) {
      void sync.load(target).then(fresh => {
        if (!fresh || activeIdRef.current !== target.id || sendingRef.current) return;
        setMessages(fresh.messages);
        setInspector(latestResult(fresh.messages));
        setSession(fresh.session); sessionRef.current = fresh.session;
        setQueue(fresh.queue || []);
        const canvas = latestResult(fresh.messages)?.result_data?.canvas;
        if (canvas) setCanvasData(canvas);
      });
    }
  };
  useEffect(() => {
    if (!sync) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = await sync.refresh();
        if (cancelled) return;
        setConversations(list); setHistoryError('');
        const target = list.find(item => item.id === activeIdRef.current) || (!loadConversationData(activeIdRef.current) ? list[0] : undefined);
        if (target && !sendingRef.current) openConversation(target);
      } catch (error) {
        if (!cancelled) setHistoryError(error instanceof Error ? error.message : '历史同步失败');
      }
    };
    const unsubscribe = sync.subscribe((error, indexChanged) => {
      if (cancelled) return;
      setHistoryError(error || '');
      if (indexChanged) setConversations(sync.index());
    });
    void refresh().then(() => {
      if (cancelled) return;
      for (const meta of loadConversationIndex()) {
        const data = loadConversationData(meta.id);
        if (data) sync.enqueue(data);
      }
    });
    const resume = () => { void sync.retry().then(refresh).catch(error => setHistoryError(String(error))); };
    const storage = (event: StorageEvent) => { if (event.key?.includes(`aegismesh-owner:${sync.owner}:`)) void refresh(); };
    window.addEventListener('focus', resume); window.addEventListener('online', resume); window.addEventListener('storage', storage);
    return () => { cancelled = true; unsubscribe(); window.removeEventListener('focus', resume); window.removeEventListener('online', resume); window.removeEventListener('storage', storage); };
  }, [sync]);
  const createConversation = (targetAgentId?: string, isCanvas = false) => {
    setExecutionMode('route');
    setLiveSubagents({});
    setLiveBlackboardMessages([]);
    const newId = crypto.randomUUID();
    const canvasSession = `ses-${crypto.randomUUID()}`;
    const defaultAgentId = targetAgentId || defaultCoordinatorId(agents, isCanvas);
    setActiveId(newId);
    activeIdRef.current = newId;
    setMessages([]);
    setShowAllMessages(false);
    setSession(canvasSession);
    sessionRef.current = canvasSession;
    setIsCanvasConv(isCanvas);
    if (isCanvas) void import("./CanvasWorkspace");
    setCanvasData(null);
    setCanvasMobileView("canvas");
    setDetail(isCanvas ? "canvas" : "route");
    if (isCanvas) {
      const canvasConversation: Conversation = {
        id: newId, title: "未命名画布", session: canvasSession,
        agentId: defaultAgentId, messages: [], isCanvas: true,
      };
      saveConversationData(canvasConversation);
      setConversations((items) => {
        const next = [
          { id: newId, session: canvasSession, title: "未命名画布", agentId: defaultAgentId, messageCount: 0, isCanvas: true, updatedAt: Date.now() },
          ...items,
        ];
        saveConversationIndex(next);
        return next;
      });
      setInspectorCollapsed(false);
      if (canvasSession) {
        void api.getSessionCanvas(canvasSession).then((canvas) => {
          if (activeIdRef.current === newId) setCanvasData(canvas);
        }).catch(() => undefined);
      }
    }
    setAgentId(defaultAgentId);
    setInspector(null);
    setQueue([]);
    setContent("chat");
    setMobileHistoryOpen(false);
  };
  const createGroupConversation = (config: GroupConfig) => {
    void (async () => {
      try {
        const registered = await api.createGroupChat({
          name: config.name || "智能体协作讨论群",
          host_agent_id: config.hostAgentId || undefined,
          members: config.members,
        });
        config.backendId = registered.id;
        config.transport = registered.transport as "local" | "aip-mq";
      } catch {
        /* 平台群聊服务不可用时退化为纯前端群聊 */
      }
      createGroupConversationInner(config);
    })();
  };

  const createGroupConversationInner = (config: GroupConfig) => {
    const newId = crypto.randomUUID();
    const newMeta: ConversationMeta = {
      id: newId,
      session: `ses-${newId}`,
      title: config.name || "智能体协作讨论群",
      isGroup: true,
      groupMemberCount: config.members.length,
    };

    const newConv: Conversation = {
      id: newId,
      session: `ses-${newId}`,
      title: config.name || "智能体群聊",
      messages: [],
      isGroup: true,
      groupConfig: config,
    };
    saveConversationData(newConv);
    const nextMetas = [newMeta, ...conversations.filter((c) => c.id !== newId)];
    setConversations(nextMetas);
    saveConversationIndex(nextMetas);
    activeIdRef.current = newId;
    setActiveId(newId);
    setLiveSubagents({});
    setLiveBlackboardMessages([]);
    setMessages([]);
    setShowAllMessages(false);
    setSession(newConv.session);
    sessionRef.current = newConv.session;
    setAgentId(config.hostAgentId || config.members[0] || "");
    setIsCanvasConv(false);
    setCanvasData(null);
    setDetail("members");
    setInspector(null);
    setQueue([]);
    setContent("chat");
    setMobileHistoryOpen(false);
    setGroupModalOpen(false);
  };
  const updateGroupConfig = (convId: string, patch: Partial<GroupConfig>) => {
    const conv = loadConversationData(convId);
    if (!conv) return;
    const nextConfig: GroupConfig = {
      name: patch.name || conv.groupConfig?.name || conv.title || "智能体群聊",
      members: patch.members || conv.groupConfig?.members || [],
      hostAgentId: patch.hostAgentId !== undefined ? patch.hostAgentId : conv.groupConfig?.hostAgentId,
    };
    conv.groupConfig = nextConfig;
    if (patch.name) {
      conv.title = patch.name;
    }
    saveConversationData(conv);
    setConversations((prev) => {
      const next = prev.map((item) => {
        if (item.id === convId) {
          return {
            ...item,
            title: patch.name || item.title,
            groupMemberCount: nextConfig.members.length,
          };
        }
        return item;
      });
      saveConversationIndex(next);
      return next;
    });
    setGroupModalOpen(false);
  };
  const deleteConversation = async (id: string) => {
    const meta = conversations.find(item => item.id === id);
    if (sendingRef.current && taskConvRef.current === id) { setHistoryError('请先等待或停止该会话的任务'); return; }
    try { if (meta && sync) await sync.remove(meta); }
    catch (error) { setHistoryError(error instanceof Error ? error.message : '删除失败，请重试'); return; }
    try {
      conversationStorage.removeItem(`aegismesh-conv-${id}`);
    } catch {}
    const next = conversations.filter((item) => item.id !== id);
    setConversations(next);
    saveConversationIndex(next);
    if (id === activeId) {
      if (next[0]) openConversation(next[0]);
      else createConversation();
    }
  };
  const handleAgentSelect = (newAgentId: string) => {
    if (newAgentId === agentId) return;
    if (messages.length > 0) {
      const targetAgent = agents.find((a) => a.id === newAgentId);
      setPendingAgentSwitch({
        targetId: newAgentId,
        targetName: targetAgent ? targetAgent.name : newAgentId,
      });
    } else {
      setAgentId(newAgentId);
    }
  };

  // 检查并恢复后台未完成任务（防止用户刷新页面时任务中断）
  useEffect(() => {
    if (!session || sendingRef.current) return;
    let cancelled = false;
    api
      .getActiveTask(session)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.active || !res.task) {
          setMessages((items) => {
            if (res.interrupted) {
              if (items.some((m) => m.recoveryInvocationId === res.interrupted?.invocation_id)) return items;
              const last = items.at(-1);
              const partial = (last?.role === "assistant" && !last.result ? last.text.trim() : "") || res.interrupted.partial_result || "";
              return upsertRecoveredAssistant(items, {
                role: "assistant",
                text: partial ? `${partial}\n\n[${res.interrupted.message}]` : res.interrupted.message,
                recoveryInvocationId: res.interrupted.invocation_id,
                streaming: false,
                createdAt: Date.now(),
              });
            }
            return items.some((m) => m.streaming)
              ? items.map((m) =>
                  m.streaming ? { ...m, streaming: false, text: m.text || "（任务已中断）" } : m,
                )
              : items;
          });
          return;
        }
        const task = res.task;
        if (["running", "completed", "failed", "cancelled"].includes(task.status)) {
          const isRunning = task.status === "running";
          const recoveryConvId = activeId;
          const savedMessages = loadConversationData(recoveryConvId)?.messages || messages;
          if (!isRunning && hasCompletedTaskMessage(savedMessages, task.task_id)) return;
          taskConvRef.current = recoveryConvId;
          currentTaskIdRef.current = task.task_id;
          abortControllerRef.current = new AbortController();
          stopRequestedRef.current = false;
          sendingRef.current = isRunning;
          setSending(isRunning);
          setSendingSince(isRunning ? (task.created_at ? task.created_at * 1000 : Date.now()) : null);
          let recoveredText = "";
          const writeRecoveredMessage = (msg: ChatMessage) => {
            const tagged = { ...msg, taskId: task.task_id };
            if (activeIdRef.current === recoveryConvId) {
              setMessages((items) => upsertRecoveredAssistant(items, tagged));
              return;
            }
            const conv = loadConversationData(recoveryConvId);
            if (!conv) return;
            conv.messages = upsertRecoveredAssistant(conv.messages, tagged);
            saveConversationData(conv);
            setConversations((items) =>
              items.map((item) =>
                item.id === recoveryConvId
                  ? { ...item, messageCount: conv.messages.length, updatedAt: Date.now() }
                  : item,
              ),
            );
          };
          // Reconnect replays the retained backend event stream from the start.
          // Clear the persisted partial text first so replay cannot duplicate it.
          if (isRunning) {
            setMessages((items) => {
              const last = items.at(-1);
              if (last?.role === "assistant" && last.streaming) {
                return [...items.slice(0, -1), { ...last, text: "" }];
              }
              return items;
            });
          }
          try {
            const result = await api.reconnectTaskStream(
              task.task_id,
              (delta) => {
                recoveredText += delta;
                if (isRunning) {
                  writeRecoveredMessage({
                    role: "assistant",
                    text: recoveredText,
                    streaming: true,
                    senderAgentId: task.agent_id,
                  });
                }
              },
              (event) => {
                if (activeIdRef.current !== recoveryConvId) return;
                handleSubagentEvent(
                  event,
                  setLiveSubagents,
                  () => {
                    setDetail("collaboration");
                    setInspectorCollapsed(false);
                  },
                  setLiveBlackboardMessages,
                );
              },
              abortControllerRef.current.signal,
            );
            if (activeIdRef.current === recoveryConvId) setInspector(result);
            writeRecoveredMessage({
              role: "assistant",
              text: result.answer,
              result,
              senderAgentId: task.agent_id,
            });
            await onComplete();
          } catch (err) {
            if (
              stopRequestedRef.current ||
              (err instanceof DOMException && err.name === "AbortError") ||
              (err instanceof Error && err.name === "AbortError") ||
              (err instanceof Error && err.message.includes("任务已被用户取消"))
            ) {
              writeRecoveredMessage({
                role: "assistant",
                text: `${recoveredText}${recoveredText ? "\n\n" : ""}[任务已被用户主动终止]`,
                senderAgentId: task.agent_id,
              });
              return;
            }
            const errorText = err instanceof Error ? err.message : "任务恢复失败";
            writeRecoveredMessage({
              role: "assistant",
              text: `${recoveredText}${recoveredText ? "\n\n" : ""}${errorText}`,
              senderAgentId: task.agent_id,
            });
          } finally {
            sendingRef.current = false;
            setSending(false);
            setSendingSince(null);
            // Keep completed live records until the durable session snapshot arrives.
            abortControllerRef.current = null;
            currentTaskIdRef.current = null;
            if (taskConvRef.current === recoveryConvId) taskConvRef.current = null;
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, activeId]);

  const runGroupMessage = async (
    userText: string,
    groupCfg: GroupConfig,
    messageAttachments?: Attachment[],
  ) => {
    sendingRef.current = true;
    setSending(true);
    setSendingSince(Date.now());
    setLiveSubagents({});
    setLiveBlackboardMessages([]);
    const taskConvId = activeId;
    taskConvRef.current = taskConvId;
    const taskSessionId = sessionRef.current || `ses-${crypto.randomUUID()}`;
    if (!sessionRef.current) {
      sessionRef.current = taskSessionId;
      setSession(taskSessionId);
    }
    // 群聊发言是离散消息：用户切走后回写到原群聊存储
    const groupAppend = (msg: ChatMessage) => {
      if (activeIdRef.current === taskConvId) {
        setMessages((items) => [...items, msg]);
      } else {
        const conv = loadConversationData(taskConvId);
        if (conv) {
          conv.messages = [...conv.messages, msg];
          saveConversationData(conv);
          setConversations((items) =>
            items.map((item) =>
              item.id === taskConvId
                ? { ...item, messageCount: conv.messages.length, updatedAt: Date.now() }
                : item,
            ),
          );
        }
      }
    };

    const userMsg: ChatMessage = {
      role: "user",
      text: userText,
      attachments: messageAttachments,
      senderName: groupCfg.hostAgentId ? "我 (群成员)" : "我 (群主 / 主持人)",
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);

    let firstSpeakerId: string | undefined;
    const mentionedMember = groupCfg.members.find((mId) => {
      const a = agents.find((ag) => ag.id === mId);
      return a && (userText.includes(`@${a.name}`) || userText.includes(`@${a.id}`));
    });

    if (mentionedMember) {
      firstSpeakerId = mentionedMember;
    } else if (groupCfg.hostAgentId && groupCfg.members.includes(groupCfg.hostAgentId)) {
      firstSpeakerId = groupCfg.hostAgentId;
    } else {
      firstSpeakerId = groupCfg.members[0];
    }

    const matchMention = (text: string, mId: string) => {
      const a = agents.find((ag) => ag.id === mId);
      if (!a) return false;
      if (text.includes(`@${a.name}`) || text.includes(`@${a.id}`)) return true;
      const shortName = a.name.replace(/智能体$/, "").replace(/专家$/, "");
      if (shortName.length >= 2 && text.includes(`@${shortName}`)) return true;
      return false;
    };

    // 平台群聊通道：本地黑板 / 国标 MQ 群组（提示词与历史由服务端统一组装）
    if (groupCfg.backendId) {
      let chainTarget = firstSpeakerId;
      let chainText = userText;
      for (let round = 0; round < 6 && chainTarget; round += 1) {
        const speakerAgent = agents.find((a) => a.id === chainTarget);
        try {
          const res = await api.sendGroupChatMessage(
            groupCfg.backendId,
            chainText,
            chainTarget,
          );
          if (!res.reply) {
            groupAppend({
              role: "assistant",
              text: res.error ? `⚠️ ${res.error}` : "（本次没有智能体发言）",
              senderName: speakerAgent?.name || chainTarget,
              createdAt: Date.now(),
            });
            break;
          }
          groupAppend({
            role: "assistant",
            text: res.reply || "",
            senderAgentId: res.agent_id || chainTarget,
            senderName: res.agent_name || speakerAgent?.name || chainTarget,
            createdAt: Date.now(),
          });
          await onComplete();
          const nextTarget = groupCfg.members.find((mId) => {
            if (mId === res.agent_id) return false;
            return matchMention(res.reply || "", mId);
          });
          if (!nextTarget) break;
          chainTarget = nextTarget;
          chainText = `群内继续讨论：上一条发言 @了你，请接着回应（原话：${res.reply.slice(0, 200)}）`;
        } catch (reason) {
          groupAppend({
            role: "assistant",
            text: `⚠️ [${speakerAgent?.name || chainTarget}] 发言失败：${reason instanceof Error ? reason.message : "群聊服务异常"}`,
            senderName: speakerAgent?.name || chainTarget,
            createdAt: Date.now(),
          });
          break;
        }
      }
      sendingRef.current = false;
      setSending(false);
      setSendingSince(null);
      taskConvRef.current = null;
      return;
    }

    const executeSpeaker = async (
      targetId: string,
      currentMsgs: ChatMessage[],
      chainRound: number,
    ): Promise<void> => {
      const speakerAgent = agents.find((a) => a.id === targetId);
      const isHost = targetId === groupCfg.hostAgentId;

      const validMemberAgents = groupCfg.members
        .map((mId) => agents.find((ag) => ag.id === mId))
        .filter(Boolean) as Agent[];
      const validMemberNames = validMemberAgents.map((a) => `@${a.name}`).join("、");

      const membersListStr = validMemberAgents
        .map((a) => `- ${a.name}（ID: ${a.id}，专长: ${a.description || "领域专家"}）`)
        .join("\n");

      const cleanHistory = currentMsgs
        .slice(-14)
        .map((m) => {
          const sender =
            m.role === "user"
              ? groupCfg.hostAgentId
                ? "用户"
                : "群主 (用户)"
              : m.senderName || "智能体";
          const clean = m.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
          return `【${sender}】: ${clean}`;
        })
        .join("\n\n");

      const otherMembers = validMemberAgents
        .filter((a) => a.id !== targetId)
        .map((a) => a.name);
      const sampleOther = otherMembers[0] || (validMemberAgents[0]?.name || "其他专家");

      const groupPrompt = `【AIP 国标规范·智能体多方协作群聊】
你正在参与群聊「${groupCfg.name}」。
你的身份：${speakerAgent?.name || targetId}（角色：${isHost ? "本群主持人" : "受邀群成员"}）。
群内所有成员（仅限以下真实存在的成员，无其他人）：
${membersListStr}

【核心协作与输出规范（必须严格遵守）】：
1. 真实工作群沟通（仅限沟通短语）：
   - 公开回复必须像人类专家在微信工作群/Slack/飞书协作一样简明干练（控制在 50~120 字以内）。
   - 聊天气泡内【只允许】输出人类沟通短语（如确认诉求、交接工作、告知进度、@下一棒）。
   - 【严禁】在主聊天气泡内直接罗列大篇幅方案正文、长清单、复杂表格或多级标题。
2. 实质方案全部放入黑板（对齐 GB/T 43444-2023 与 GB/T 7714-2015 国家标准）：
   - 所有实质性的工作交付物（如详细研究方案、计量方程、因果推断设计、数据提取表、文献综述、代码等），必须且只能放入以下 blackboard 代码块中：
\`\`\`blackboard:交付物标题
这里放置完整的详细方案、表格、数据或代码...
\`\`\`
   - 若涉及学术文献或参考文献著录，必须严格遵循国家标准《GB/T 7714-2015》著录规范（包含序号、责任者、题名、文献标识、出版信息及 DOI 唯一溯源标识）。
   - 交付物会自动沉淀到本群【黑板】共享资产库中打上国标审定流水号，主聊天气泡只保留极简交接与提炼。
3. 严禁幻觉 @：你只能 @ 本群真实存在的成员（当前仅限：${validMemberNames}）。绝对严禁 @ 未入群的角色（严禁出现 @research_leader 或任何假想的负责人）。如需向群主汇报且未指定主持人，直接以文字回复群主即可。
4. 如需其他专家协作：在简短发言中使用「@专家名称 简要需求」（例如：@${sampleOther} 请...），系统会自动唤醒该专家接力。
5. 严禁包含思考草稿或 <think> 标签，直接给出面向群聊的公开回复。
${
  isHost
    ? "作为主持人，你负责统筹协调。你可以直接解答用户疑问，也可以将任务拆解后艾特对应专家协同，或发消息面向全群总结。"
    : "作为受邀专家，请针对艾特你的问题或主持人的委派，给出专业解答。"
}

【群聊历史公开记录】：
${cleanHistory}

请作为「${speakerAgent?.name || targetId}」在群聊中发表你的公开回复：`;

      let streamedText = "";
      const abortCtrl = new AbortController();
      abortControllerRef.current = abortCtrl;
      currentTaskIdRef.current = null;
      stopRequestedRef.current = false;

      const writeSpeakerMessage = (msg: ChatMessage) => {
        const replaceTail = (items: ChatMessage[]) => {
          const last = items.at(-1);
          if (
            last?.role === "assistant" &&
            last.streaming &&
            last.senderAgentId === targetId
          ) {
            return [...items.slice(0, -1), msg];
          }
          return [...items, msg];
        };
        if (activeIdRef.current === taskConvId) {
          setMessages(replaceTail);
          return;
        }
        const conv = loadConversationData(taskConvId);
        if (!conv) return;
        conv.messages = replaceTail(conv.messages);
        saveConversationData(conv);
        setConversations((items) =>
          items.map((item) =>
            item.id === taskConvId
              ? { ...item, messageCount: conv.messages.length, updatedAt: Date.now() }
              : item,
          ),
        );
      };

      try {
        const result = await api.chatStream(
          groupPrompt,
          taskSessionId,
          targetId,
          (delta) => {
            streamedText += delta;
            writeSpeakerMessage({
              role: "assistant",
              text: streamedText,
              streaming: true,
              senderAgentId: targetId,
              senderName: speakerAgent?.name || targetId,
              isHost,
              createdAt: Date.now(),
            });
          },
          () => {},
          abortCtrl.signal,
          (taskId) => {
            currentTaskIdRef.current = taskId;
          },
          messageAttachments,
        isCanvasConv,
        );

        setSession(result.session_id);
        sessionRef.current = result.session_id;

        let finalAnswer = result.answer;

        // 1. 提取 <think> 思考内容至黑板/协作活动，保持主气泡极简
        const thinkMatch = finalAnswer.match(/<think>([\s\S]*?)<\/think>/i);
        if (thinkMatch && thinkMatch[1].trim()) {
          const thinkText = thinkMatch[1].trim();
          setLiveBlackboardMessages((prev) => [
            ...prev,
            {
              id: `think_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              sender_id: targetId,
              sender_name: speakerAgent?.name || targetId,
              nickname: `@${speakerAgent?.name || targetId}`,
              role: isHost ? "leader" : "expert",
              type: "dispatch",
              content: `💡 **思考与内部推理**：\n${thinkText}`,
              timestamp: Date.now() / 1000,
              metadata: { type: "thought" },
            },
          ]);
        }
        finalAnswer = finalAnswer.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

        // 2. 提取 ```blackboard:交付物标题 沉淀至黑板协作资产
        let hasBlackboardDelivery = false;
        const bbRegex = /```blackboard:?([^\n\r]*)\n([\s\S]*?)```/gi;
        let bbMatch;
        while ((bbMatch = bbRegex.exec(finalAnswer)) !== null) {
          const bbTitle = (bbMatch[1] || "").trim() || "工作交付物";
          const bbContent = (bbMatch[2] || "").trim();
          if (bbContent) {
            hasBlackboardDelivery = true;
            setLiveBlackboardMessages((prev) => [
              ...prev,
              {
                id: `bb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                sender_id: targetId,
                sender_name: speakerAgent?.name || targetId,
                nickname: `@${speakerAgent?.name || targetId}`,
                role: isHost ? "leader" : "expert",
                type: "report",
                content: `# ${bbTitle}\n\n${bbContent}`,
                timestamp: Date.now() / 1000,
                metadata: { title: bbTitle, source: "group_chat" },
              },
            ]);
          }
        }
        let chatCleanAnswer = finalAnswer.replace(
          /```blackboard:?([^\n\r]*)\n[\s\S]*?```/gi,
          (_match, p1) => {
            const title = (p1 || "").trim() || "工作交付物";
            return `\n\n> 📋 **黑板成果已沉淀**：已将「${title}」写入【黑板】`;
          }
        ).trim();

        // 3. 兜底保护：若智能体未按规范使用 blackboard 块但输出了较长或分段的方案案卷（> 200 字），自动将后续实质方案切分送入黑板
        if (!hasBlackboardDelivery && chatCleanAnswer.length > 200) {
          const sectionSplit = chatCleanAnswer.search(/\n(?=[#一二三四五六七八九十0-9]+[、\.·\s]|\n## |\n- |\n\* |【)/);
          if (sectionSplit > 20 && sectionSplit < 320) {
            const briefIntro = chatCleanAnswer.slice(0, sectionSplit).trim();
            const deepDeliverable = chatCleanAnswer.slice(sectionSplit).trim();
            const title = "工作交付物与方案设计";
            setLiveBlackboardMessages((prev) => [
              ...prev,
              {
                id: `bb_split_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                sender_id: targetId,
                sender_name: speakerAgent?.name || targetId,
                nickname: `@${speakerAgent?.name || targetId}`,
                role: isHost ? "leader" : "expert",
                type: "report",
                content: `# ${title}\n\n${deepDeliverable}`,
                timestamp: Date.now() / 1000,
                metadata: { title, source: "group_chat_split" },
              },
            ]);
            const mentionTailMatch = deepDeliverable.match(/(@[^\s\n]+[^\n]*)$/);
            const tailMention = mentionTailMatch ? `\n\n${mentionTailMatch[1]}` : "";
            chatCleanAnswer = `${briefIntro}\n\n> 📋 **黑板成果已沉淀**：详细方案与数据分析表已写入【黑板】${tailMention}`;
          }
        }

        const assistantMsg: ChatMessage = {
          role: "assistant",
          text: chatCleanAnswer,
          result,
          senderAgentId: targetId,
          senderName: speakerAgent?.name || targetId,
          isHost,
          createdAt: Date.now(),
        };

        writeSpeakerMessage(assistantMsg);

        await onComplete();

        if (chainRound < 6 && !stopRequestedRef.current) {
          const nextTargetId = groupCfg.members.find((mId) => {
            if (mId === targetId) return false;
            return matchMention(finalAnswer, mId);
          });
          if (nextTargetId) {
            await executeSpeaker(nextTargetId, [...currentMsgs, assistantMsg], chainRound + 1);
          }
        }
      } catch (reason) {
        if (
          stopRequestedRef.current ||
          (reason instanceof DOMException && reason.name === "AbortError") ||
          (reason instanceof Error && reason.name === "AbortError")
        ) {
          writeSpeakerMessage({
            role: "assistant",
            text: `${streamedText}${streamedText ? "\n\n" : ""}[发言已由用户终止]`,
            senderAgentId: targetId,
            senderName: speakerAgent?.name || targetId,
            isHost,
            createdAt: Date.now(),
          });
          return;
        }
        const errorMsg = reason instanceof Error ? reason.message : "智能体发言失败";
        writeSpeakerMessage({
          role: "assistant",
          text: `${streamedText}${streamedText ? "\n\n" : ""}⚠️ [${speakerAgent?.name || targetId}] 发言遇到异常: ${errorMsg}`,
          senderAgentId: targetId,
          senderName: speakerAgent?.name || targetId,
          isHost,
          createdAt: Date.now(),
        });
      }
    };

    try {
      await executeSpeaker(firstSpeakerId, [...messages, userMsg], 0);
    } finally {
      sendingRef.current = false;
      setSending(false);
      setSendingSince(null);
      abortControllerRef.current = null;
      currentTaskIdRef.current = null;
    }
  };

  const runMessage = async (
    message: string,
    taskAgentId: string,
    messageAttachments?: Attachment[],
    taskMode: 'route' | 'bounty' = 'route',
    structuredOptions?: StructuredTaskOptions,
  ) => {
    const currentConv = loadConversationData(activeId);
    if (currentConv?.isGroup && currentConv?.groupConfig) {
      return await runGroupMessage(message, currentConv.groupConfig, messageAttachments);
    }
    sendingRef.current = true;
    setSending(true);
    setSendingSince(Date.now());
    setLiveSubagents({});
    setLiveBlackboardMessages([]);
    const taskConvId = activeId; // 任务绑定发起它的会话
    taskConvRef.current = taskConvId;
    // Give the task a durable client-known session before opening the stream.
    // A refresh during the very first response can then still locate and replay it.
    const taskSessionId = sessionRef.current || `ses-${crypto.randomUUID()}`;
    if (!sessionRef.current) {
      sessionRef.current = taskSessionId;
      setSession(taskSessionId);
    }
    streamTextRef.current = "";
    setMessages((items) => [
      ...items,
      { role: "user", text: structuredOptions?.input_data ? `${message}\n\n\`\`\`json\n${JSON.stringify(structuredOptions.input_data, null, 2)}\n\`\`\`` : message, attachments: messageAttachments },
    ]);
    let receivedDelta = false;
    const abortCtrl = new AbortController();
    abortControllerRef.current = abortCtrl;
    currentTaskIdRef.current = null;
    stopRequestedRef.current = false;

    // 任务完成/终止时：若用户已切到其他会话，把结果回写到原会话存储而不是当前视图
    const finishTaskMessage = (msg: ChatMessage) => {
      const tagged = { ...msg, taskId: currentTaskIdRef.current || undefined };
      if (activeIdRef.current === taskConvId) {
        setMessages((items) => upsertRecoveredAssistant(items, tagged));
      } else {
        const conv = loadConversationData(taskConvId);
        if (conv) {
          conv.messages = upsertRecoveredAssistant(conv.messages, { ...tagged, streaming: false });
          saveConversationData(conv);
          setConversations((items) =>
            items.map((item) =>
              item.id === taskConvId
                ? { ...item, messageCount: conv.messages.length, updatedAt: Date.now() }
                : item,
            ),
          );
        }
      }
    };

    const upsertStreamToSaved = (agentId: string) => {
      const now = Date.now();
      if (now - lastStreamSaveRef.current < 400) return;
      lastStreamSaveRef.current = now;
      const conv = loadConversationData(taskConvId);
      if (!conv) return;
      const last = conv.messages.at(-1);
      if (last && last.streaming && last.senderAgentId === agentId) {
        last.text = streamTextRef.current;
        last.taskId = currentTaskIdRef.current || undefined;
      } else {
        conv.messages.push({
          role: "assistant",
          text: streamTextRef.current,
          streaming: true,
          senderAgentId: agentId,
          taskId: currentTaskIdRef.current || undefined,
          createdAt: Date.now(),
        });
      }
      saveConversationData(conv);
      setConversations((items) =>
        items.map((item) =>
          item.id === taskConvId
            ? { ...item, messageCount: conv.messages.length, updatedAt: Date.now() }
            : item,
        ),
      );
    };

    try {
      const result = await api.chatStream(
        message,
        taskSessionId,
        taskAgentId,
        (delta) => {
          receivedDelta = true;
          streamTextRef.current += delta;
          upsertStreamToSaved(taskAgentId);
          if (activeIdRef.current !== taskConvId) return; // 用户已切走：流内容仍实时写入所属会话
          setMessages((items) => {
            const last = items.at(-1);
            if (last?.role === "assistant" && last.streaming) {
              return [
                ...items.slice(0, -1),
                { ...last, text: streamTextRef.current, taskId: currentTaskIdRef.current || undefined },
              ];
            }
            return [
              ...items,
              { role: "assistant", text: streamTextRef.current, streaming: true, taskId: currentTaskIdRef.current || undefined },
            ];
          });
        },
        (event) => {
          if (activeIdRef.current !== taskConvId) return;
          handleSubagentEvent(
            event,
            setLiveSubagents,
            () => {
              if (!isCanvasConv) setDetail("collaboration");
              setInspectorCollapsed(false);
            },
            setLiveBlackboardMessages,
          );
          if (event.type === "canvas_updated" && event.data?.canvas_id) {
            api
              .getSessionCanvas(taskSessionId)
              .then((canvas) => {
                if (activeIdRef.current === taskConvId) {
                  setCanvasData((current) => !current || current.id !== canvas.id || canvas.version >= current.version ? canvas : current);
                }
              })
              .catch(() => undefined);
          }
        },
        abortCtrl.signal,
        (taskId) => {
          currentTaskIdRef.current = taskId;
        },
        messageAttachments,
        isCanvasConv,
        taskMode,
        structuredOptions,
      );
      if (activeIdRef.current === taskConvId) {
        setSession(result.session_id);
        sessionRef.current = result.session_id;
        setInspector(result);
      } else {
        const conv = loadConversationData(taskConvId);
        if (conv) {
          conv.session = result.session_id;
          saveConversationData(conv);
        }
      }
      finishTaskMessage({
        role: "assistant",
        text: result.answer,
        result,
        createdAt: Date.now(),
      });
      await onComplete();
    } catch (reason) {
      if (
        stopRequestedRef.current ||
        (reason instanceof DOMException && reason.name === "AbortError") ||
        (reason instanceof Error && reason.name === "AbortError") ||
        (reason instanceof Error && reason.message.includes("任务已被用户取消"))
      ) {
        finishTaskMessage({
          role: "assistant",
          text: `${streamTextRef.current}\n\n[任务已被用户主动终止]`,
          createdAt: Date.now(),
        });
        return;
      }
      let error = reason instanceof Error ? reason.message : "任务执行失败";
      if (
        error === "Load failed" ||
        error.includes("Failed to fetch") ||
        error.includes("NetworkError") ||
        error.includes("network error")
      ) {
        error = "网络连接中断，后台任务仍在继续运行，请稍后刷新或重连查看";
      }
      finishTaskMessage({
        role: "assistant",
        text: `${streamTextRef.current}\n\n${error}`,
        createdAt: Date.now(),
      });
    } finally {
      sendingRef.current = false;
      setSending(false);
      setSendingSince(null);
      // Finalization must not make just-completed tool/subtask rows disappear.
      abortControllerRef.current = null;
      currentTaskIdRef.current = null;
      taskConvRef.current = null;
      const shouldRunNext = !stopQueueRef.current;
      stopRequestedRef.current = false;
      stopQueueRef.current = false;
      if (shouldRunNext) {
        const next = queueRef.current[0];
        if (next) {
          setQueue(queueRef.current.slice(1));
          void runMessage(next.text, next.agentId, next.attachments, next.mode, next.structuredOptions);
        }
      }
    }
  };
  const rateMessage = async (
    message: ChatMessage,
    rating: "positive" | "negative",
  ) => {
    const invocationId = message.result?.invocation_id;
    if (!invocationId || feedbackBusy) return;
    setFeedbackBusy(invocationId);
    try {
      await api.submitFeedback(invocationId, rating);
      setMessages((items) =>
        items.map((item) =>
          item.result?.invocation_id === invocationId
            ? { ...item, feedback: rating }
            : item,
        ),
      );
    } catch (reason) {
      alert(reason instanceof Error ? reason.message : "评价提交失败");
    } finally {
      setFeedbackBusy("");
    }
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const message = input.trim();
    if (!message && attachments.length === 0) return;
    let structuredOptions: StructuredTaskOptions | undefined;
    try {
      structuredOptions = buildStructuredTask(agents.find(agent => agent.id === agentId), structuredEnabled && !isCanvasConv && !activeMeta?.isGroup, structuredSkill, structuredValues);
      setStructuredError('');
    } catch (reason) { setStructuredError(reason instanceof Error ? reason.message : '输入格式不正确'); return; }
    const currentAttachments = [...attachments];
    setAttachments([]);
    setInput("");
    const defaultMsg =
      currentAttachments.length > 0
        ? `请针对上传的学术资料与研究材料开展深度分析：${currentAttachments.map((a) => a.filename).join(", ")}`
        : "";
    const finalMsg = message || defaultMsg;
    if (sendingRef.current) {
      setQueue((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          text: finalMsg,
          agentId,
          attachments: currentAttachments,
          mode: executionMode,
          structuredOptions,
        },
      ]);
      return;
    }
    void runMessage(finalMsg, agentId, currentAttachments, executionMode, structuredOptions);
  };

  const groupConfig = activeMeta?.isGroup ? loadConversationData(activeId)?.groupConfig : null;
  useEffect(() => {
    const canvas = inspector?.result_data?.canvas;
    if (canvas && canvas.id) {
      setCanvasData((current) => !current || current.id !== canvas.id || canvas.version >= current.version ? canvas : current);
    }
  }, [inspector]);
  useEffect(() => {
    if (!isCanvasConv || !session) return;
    let active = true;
    void api.getSessionCanvas(session).then((canvas) => {
      if (active) setCanvasData((current) => !current || current.id !== canvas.id || canvas.version >= current.version ? canvas : current);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [activeId, isCanvasConv, session]);
  useEffect(() => {
    if (isCanvasConv && mobileInspectorOpen) setCanvasMobileView("canvas");
  }, [isCanvasConv, mobileInspectorOpen]);
  const groupMemberAgents = useMemo(() => {
    if (!groupConfig) return [];
    return groupConfig.members.map((mId) => agents.find((a) => a.id === mId)).filter(Boolean) as Agent[];
  }, [groupConfig, agents]);

  const mentionList = useMemo(() => {
    if (!activeMeta?.isGroup) return [];
    const allOption = { id: "__all__", name: "所有人", roleTag: "Bot", isAll: true };
    const botOptions = groupMemberAgents.map((ag) => ({
      id: ag.id,
      name: ag.name,
      roleTag: ag.id === groupConfig?.hostAgentId ? "主持" : "Bot",
      isAll: false,
    }));
    const full = [allOption, ...botOptions];
    if (!mentionFilter) return full;
    return full.filter((item) => item.name.toLowerCase().includes(mentionFilter.toLowerCase()));
  }, [activeMeta?.isGroup, groupMemberAgents, groupConfig?.hostAgentId, mentionFilter]);

  const insertMention = (name: string) => {
    const textBeforeAt = input.slice(0, mentionCursorPos);
    const textAfterCursor = input.slice(composerTextareaRef.current?.selectionStart || (mentionCursorPos + mentionFilter.length + 1));
    const replacement = `@${name} `;
    const nextInput = textBeforeAt + replacement + textAfterCursor;
    setInput(nextInput);
    setMentionMenuOpen(false);
    setTimeout(() => {
      if (composerTextareaRef.current) {
        composerTextareaRef.current.focus();
        const newPos = (textBeforeAt + replacement).length;
        composerTextareaRef.current.setSelectionRange(newPos, newPos);
      }
    }, 10);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const pos = e.target.selectionStart || 0;
    setInput(val);

    if (activeMeta?.isGroup) {
      const textBeforeCursor = val.slice(0, pos);
      const lastAt = textBeforeCursor.lastIndexOf("@");
      if (lastAt !== -1 && (lastAt === 0 || /\s/.test(textBeforeCursor[lastAt - 1]))) {
        const query = textBeforeCursor.slice(lastAt + 1);
        if (!/\s/.test(query)) {
          setMentionFilter(query);
          setMentionCursorPos(lastAt);
          setMentionIndex(0);
          setMentionMenuOpen(true);
          return;
        }
      }
    }
    setMentionMenuOpen(false);
  };

  const composingRef = useRef(false);
  const handleCompositionStart = () => { composingRef.current = true; };
  const handleCompositionEnd = () => { composingRef.current = false; };
  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (mentionMenuOpen && mentionList.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((prev) => (prev + 1) % mentionList.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((prev) => (prev - 1 + mentionList.length) % mentionList.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const target = mentionList[mentionIndex];
        if (target) {
          insertMention(target.name);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionMenuOpen(false);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && (!window.matchMedia("(max-width: 820px), (pointer: coarse)").matches || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setMentionMenuOpen(false);
      submit();
    }
  };

  const handlePromoteTask = async (item: QueuedTask) => {
    setQueue((items) => items.filter((entry) => entry.id !== item.id));
    await handleStopTask();
    void runMessage(item.text, item.agentId || agentId, item.attachments || [], item.mode, item.structuredOptions);
  };

  const handleEditTask = (item: QueuedTask) => {
    setQueue((items) => items.filter((entry) => entry.id !== item.id));
    setInput(item.text);
    if (item.agentId !== agentId) structuredDraftRef.current = item.structuredOptions;
    setAgentId(item.agentId);
    setExecutionMode(bountyEnabled ? item.mode || 'route' : 'route');
    setStructuredEnabled(Boolean(item.structuredOptions));
    setStructuredSkill(item.structuredOptions?.requested_skill || '');
    setStructuredValues(inputValues(item.structuredOptions?.input_data, taskSchemas(agents.find(agent => agent.id === item.agentId), item.structuredOptions?.requested_skill).input));
    setStructuredError('');
    if (item.attachments) {
      setAttachments(item.attachments);
    }
    composerTextareaRef.current?.focus();
  };

  const handleDeleteTask = (id: string) => {
    setQueue((items) => items.filter((entry) => entry.id !== id));
  };
  const suggestions = [
    "针对大模型多智能体协作，撰写系统性文献综述并分析研究空白",
    "推导自适应多智能体通信博弈模型，给出数学公式与命题假说",
    "设计一项因果推断实证实验方案，设定计量回归模型与稳健性检验",
    "对我的论文方法论与实验设计出具同行评审意见（Peer Review）",
  ];
  const compressed = (() => {
    const strategy = settings.compressionStrategy || (settings.autoCompress ? "auto" : "off");
    if (strategy === "off" || !settings.autoCompress)
      return {
        start: 0,
        tokens: messages.reduce(
          (sum, item) => sum + estimateTokens(item.text),
          0,
        ),
      };
    const costs = messages.map((item) => estimateTokens(item.text));
    let total = costs.reduce((sum, value) => sum + value, 0);
    const thresholdRatio =
      strategy === "aggressive" ? 0.4 : strategy === "conservative" ? 0.8 : 0.6;
    const minKeep =
      settings.keepRecentTurns === 0
        ? 1
        : Math.max(2, (settings.keepRecentTurns || 4) * 2);
    let start = 0;
    while (
      total > settings.contextWindow * thresholdRatio &&
      messages.length - start > minKeep
    ) {
      total -= costs[start];
      start += 1;
    }
    return { start, tokens: total + start * 30 };
  })();
  const contextPercent = Math.min(
    100,
    Math.max(1, Math.round((compressed.tokens / settings.contextWindow) * 100)),
  );
  const clearConversations = () => {
    try {
      const metas = loadConversationIndex();
      metas.forEach((m) => conversationStorage.removeItem(`aegismesh-conv-${m.id}`));
      conversationStorage.removeItem("aegismesh-conversations-index");
      conversationStorage.removeItem("aegismesh-conversations");
    } catch {}
    window.location.reload();
  };
  const directTools = inspector?.result_data?.tool_executions || [];
  const collaborationTools = (
    inspector?.result_data?.contributions || []
  ).flatMap((item) => {
    const data = item.data as { tool_executions?: typeof directTools };
    return data.tool_executions || [];
  });
  const toolExecutions = [...directTools, ...collaborationTools];
  const dispatches = directTools.filter(
    (item) => item.name === "dispatch_task",
  );
  return (
    <div
      className={`chat-layout ${historyCollapsed ? "history-collapsed" : ""} ${inspectorCollapsed ? "inspector-collapsed" : ""} ${mobileHistoryOpen ? "mobile-history-open" : ""} ${mobileInspectorOpen ? "mobile-inspector-open" : ""} ${isCanvasConv && content === "chat" ? "canvas-mode" : ""} ${canvasMobileView === "chat" ? "canvas-chat-view" : ""}`}
    >
        <button
          className={`chat-drawer-backdrop ${mobileHistoryOpen || mobileInspectorOpen ? "is-open" : ""}`}
          onClick={() => {
            setMobileHistoryOpen(false);
            setMobileInspectorOpen(false);
          }}
          aria-label="关闭抽屉"
          aria-hidden={!(compactSidebar && (mobileHistoryOpen || mobileInspectorOpen))}
          tabIndex={compactSidebar && (mobileHistoryOpen || mobileInspectorOpen) ? 0 : -1}
        />
        <SidebarToggle
          className="chat-side-toggle left"
          side="left"
          expanded={!historyCollapsed}
          label={historyCollapsed ? "展开会话" : "折叠会话"}
          aria-controls="chat-history-sidebar"
          onClick={() => setHistoryCollapsed(value => !value)}
        />
      {!isCanvasConv && (
        <SidebarToggle
          className="chat-side-toggle right"
          side="right"
          expanded={!inspectorCollapsed}
          label={inspectorCollapsed ? "展开详情" : "折叠详情"}
          aria-controls="chat-route-inspector"
          onClick={() => setInspectorCollapsed(value => !value)}
        />
      )}
      <aside id="chat-history-sidebar" className="history-sidebar" inert={!historyVisible} aria-hidden={!historyVisible}>
        <div className="chat-brand">
          <span>
            <Network size={17} />
          </span>
          <strong>AegisMesh</strong>
          <button
            className="mobile-drawer-close"
            onClick={() => setMobileHistoryOpen(false)}
            title="关闭侧栏"
            aria-label="关闭侧栏"
          >
            <X size={16} />
          </button>
        </div>
        <div className="new-chat-split-container">
          <button
            className="new-chat-main"
            onClick={() => createConversation()}
            title="新建普通会话"
          >
            <CirclePlus size={15} />
            <span>新会话</span>
          </button>
          <button
            type="button"
            className="new-chat-split-trigger"
            onClick={(e) => {
              e.stopPropagation();
              setNewChatDropdownOpen((prev) => !prev);
            }}
            title="更多会话类型"
            aria-label="更多会话类型"
          >
            <ChevronDown size={14} />
          </button>
          {newChatDropdownOpen && (
            <div className="new-chat-dropdown-menu">
              <button type="button" onClick={() => window.location.assign('/digital-human')}><Bot size={15}/><div><strong>数字人服务厅</strong><span className="subtext">和虚拟助手直接聊聊</span></div></button>
              <button
                type="button"
                onClick={() => {
                  setNewChatDropdownOpen(false);
                  createConversation();
                }}
              >
                <MessageSquareText size={15} />
                <div>
                  <strong>普通会话</strong>
                  <span className="subtext">单智能体独立对话或系统协调</span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setNewChatDropdownOpen(false);
                  setGroupModalMode("create");
                  setGroupModalTargetId(null);
                  setGroupModalOpen(true);
                }}
              >
                <Users size={15} />
                <div>
                  <strong>
                    智能体群聊 <span className="beta-tag">实验性</span>
                  </strong>
                  <span className="subtext">类似微信群聊的多方协同研讨</span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setNewChatDropdownOpen(false);
                  createConversation(undefined, true);
                  setDetail("canvas");
                }}
              >
                <FileText size={15} />
                <div>
                  <strong>
                    画布协作 <span className="beta-tag">实验性</span>
                  </strong>
                  <span className="subtext">多智能体共享画布，协同撰写与修改报告</span>
                </div>
              </button>
            </div>
          )}
        </div>
        {historyError && <div className="history-sync-error" role="status"><span>{historyError}</span><button type="button" onClick={() => { void sync?.retry().then(list => { setConversations(list); setHistoryError(''); }).catch(error => setHistoryError(String(error))); }}>重试</button></div>}
        <nav>
          {(() => {
            const sorted = [...conversations].sort(
              (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
            );
            const day = 86_400_000;
            const now = Date.now();
            const groups: { key: string; label: string; items: ConversationMeta[] }[] = [
              { key: "today", label: "今天", items: [] },
              { key: "week", label: "近 7 天", items: [] },
              { key: "earlier", label: "更早", items: [] },
            ];
            for (const meta of sorted) {
              const t = meta.updatedAt || 0;
              const key = t && now - t < day ? "today" : t && now - t < 7 * day ? "week" : "earlier";
              groups.find((g) => g.key === key)!.items.push(meta);
            }
            return groups
              .filter((g) => g.items.length > 0)
              .map((g) => (
              <div key={g.key} className="history-group">
                <div className="history-group-label">{g.label}</div>
                {g.items.map((conversation) => (
            <div
              className={`history-item ${conversation.id === activeId ? "active" : ""} ${conversation.isGroup ? "is-group" : ""} ${sending && taskConvRef.current === conversation.id ? "is-running" : ""}`}
              key={conversation.id}
            >
              <button onClick={() => openConversation(conversation)} title={conversation.title} aria-current={conversation.id === activeId ? "page" : undefined}>
                {conversation.isGroup ? (
                  <Users size={14} className="group-item-icon" />
                ) : conversation.isCanvas ? (
                  <FileText size={14} />
                ) : null}
                <span className="history-title">{conversation.title}</span>
                {conversation.isGroup && (
                  <span className="group-count-badge">
                    {conversation.groupMemberCount || 0}人
                  </span>
                )}
              </button>
              {sending && taskConvRef.current === conversation.id && (
                <span className="history-running" role="status" aria-label="任务运行中" title="任务运行中"><span className="history-spinner" aria-hidden="true" /></span>
              )}
              <div className="history-actions-col">
                {conversation.isGroup && (
                  <button
                    type="button"
                    className="edit-chat"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveId(conversation.id);
                      setDetail("members");
                      setInspectorCollapsed(false);
                      setMobileInspectorOpen(true);
                    }}
                    title="群成员与设置"
                  >
                    <SlidersHorizontal size={13} />
                  </button>
                )}
                <button
                  className="delete-chat"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteConversation(conversation.id);
                  }}
                  title="删除会话"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            ))}
              </div>
              ));
          })()}
        </nav>
        <button
          className={content === "api" ? "active api-entry" : "api-entry"}
          onClick={() => {
            setContent("api");
            setMobileHistoryOpen(false);
          }}
        >
          <Braces size={15} />
          开放 API
        </button>
        <SidebarAccount onSettings={section => {
            setSettingsSection(section);
            setSettingsOpen(true);
            setMobileHistoryOpen(false);
          }} />
      </aside>
      {content === "api" ? (
        <section className="chat-stage api-stage">
          <header className="chat-mobile-header">
            <button
              className="mobile-header-btn"
              onClick={() => setMobileHistoryOpen(true)}
              aria-label="打开侧栏"
              title="会话列表"
            >
              <Menu size={18} />
            </button>
            <div className="chat-mobile-title">
              <span className="mobile-brand-mark">
                <Network size={14} />
              </span>
              <strong>开放 API</strong>
            </div>
            <div className="chat-mobile-actions">
              <button
                className="mobile-back-chip"
                onClick={() => setContent("chat")}
              >
                <ArrowLeft size={13} />
                <span>对话</span>
              </button>
            </div>
          </header>
          <ApiPage onBack={() => setContent("chat")} />
        </section>
      ) : isCanvasConv ? (
        <>
          {canvasData ? <Suspense fallback={<LoadingFlow label="正在加载画布…" canvas />}><CanvasWorkspace
            key={canvasData.id}
            document={canvasData}
            agentBusy={sending}
            sessionTitle={activeMeta?.title || "协同画布"}
            showHistoryToggle={false}
            onOpenHistory={() => {
              if (window.matchMedia("(max-width: 820px)").matches) {
                setMobileHistoryOpen(true);
              } else {
                setHistoryCollapsed(false);
              }
            }}
            onAskAI={(selected, action) => {
              const instruction = { polish: "润色表达并保持原意", expand: "补充有依据的细节，不编造事实", correct: "纠正错别字、语法和明显事实错误", restructure: "重组段落结构，使论证更清晰" }[action];
              setInput(`请只针对画布中选中的文本${instruction}。先 canvas_read 获取最新版本，优先用 canvas_replace_selection 精确替换唯一原文；若无法唯一匹配，请说明原因，不要改动其他段落。选中文本：\n\n“${selected}”`);
              setCanvasAssistantOpenRequest((value) => value + 1);
            }}
            onUploadImage={async (file) => (await api.uploadFile(file)).url}
            onSave={async (content, baseVersion) => {
              if (!session) throw new Error("当前画布尚未绑定会话");
              try {
                const saved = await api.updateSessionCanvas(session, content, baseVersion);
                setCanvasData(saved);
                return saved;
              } catch (reason) {
                void api.getSessionCanvas(session).then(setCanvasData).catch(() => undefined);
                throw reason;
              }
            }}
          /></Suspense> : <LoadingFlow label="正在加载画布…" canvas />}
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: "none" }}
            multiple
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                void handleFileUpload(e.target.files);
              }
            }}
          />
          <CanvasFloatingAssistant
            key={activeId}
            messages={messages}
            sessionResults={sessionActivity.session === session ? sessionActivity.results : []}
            activityControls={<>
              {sessionActivity.session === session && sessionActivity.error && <button className="activity-history-control" onClick={() => setActivityRefresh(v => v + 1)}>协作记录加载失败，点击重试</button>}
              {sessionActivity.session === session && sessionActivity.next && <button className="activity-history-control" onClick={() => void loadMoreActivity()}>加载更早的协作记录</button>}
            </>}
            showAllMessages={showAllMessages}
            setShowAllMessages={setShowAllMessages}
            sending={sending}
            sendingSince={sendingSince}
            input={input}
            setInput={setInput}
            handleSend={() => submit()}
            handleKeyDown={handleInputKeyDown}
            handleCompositionStart={handleCompositionStart}
            handleCompositionEnd={handleCompositionEnd}
            attachments={attachments}
            uploading={uploading}
            fileInputRef={fileInputRef}
            removeAttachment={(id: string) =>
              setAttachments((prev) => prev.filter((a) => a.file_id !== id))
            }
            agents={agents}
            agentId={agentId}
            handleAgentSelect={handleAgentSelect}
            inspector={inspector}
            setInspector={setInspector}
            activeDispatches={activeDispatches}
            dynamicDiscoveredCandidates={dynamicDiscoveredCandidates}
            metricLabels={metricLabels}
            formatMs={formatMs}
            liveSubagents={Object.values(liveSubagents)}
            liveBlackboardMessages={liveBlackboardMessages}
            toolNames={toolNames}
            onClearHistory={() => {
              if (window.confirm("确定清空当前会话的消息记录吗？")) {
                setMessages([]);
                setQueue([]);
                const conv = loadConversationData(activeId);
                if (conv) {
                  conv.messages = [];
                  saveConversationData(conv);
                }
              }
            }}
            canvasData={canvasData}
            composerTextareaRef={composerTextareaRef}
            openRequest={canvasAssistantOpenRequest}
          />
        </>
      ) : (
        <section className="chat-stage">
          <header className="chat-mobile-header">
            <button
              className="mobile-header-btn"
              onClick={() => setMobileHistoryOpen(true)}
              aria-label="打开会话历史"
              title="会话列表"
            >
              <Menu size={18} />
            </button>
            <div className="chat-mobile-title">
              <span className="mobile-brand-mark">
                <Network size={14} />
              </span>
              <strong>{activeMeta?.title || "AegisMesh"}</strong>
            </div>
            <div className="chat-mobile-actions">
              {isCanvasConv && (
                <button
                  className="mobile-header-btn"
                  onClick={() => setCanvasMobileView("canvas")}
                  aria-label="查看画布"
                  title="查看画布"
                >
                  <FileText size={17} />
                </button>
              )}
              {!isCanvasConv && <button
                className={`mobile-header-btn ${inspector ? "active" : ""}`}
                onClick={() => {
                  setMobileInspectorOpen((val) => !val);
                }}
                aria-label="查看路由详情"
                title="路由详情"
              >
                <SlidersHorizontal size={17} />
                {inspector && <span className="mobile-btn-dot" />}
              </button>}
            </div>
          </header>
          {isCanvasConv && (
            <div className="canvas-chat-heading">
              <div><strong>协作对话</strong><span>提出修改，正文在画布中更新</span></div>
              <button type="button" aria-label="收起协作对话" onClick={() => setCanvasMobileView("canvas")}><X size={16} /></button>
            </div>
          )}
          <div className="chat-thread">
            {messages.length === 0 ? (
              <div className="chat-hero">
                <div className="hero-mark">
                  <Sparkles size={24} />
                </div>
                <h2>{isCanvasConv ? "开始撰写画布" : "今天要完成什么？"}</h2>
                {isCanvasConv && <p>描述目标、资料和期望结构，正文会写入左侧画布。</p>}
                <div className="prompt-grid">
                  {(isCanvasConv ? [
                    "根据我的研究主题起草报告大纲，并写入画布",
                    "整理上传材料的关键证据，补充到画布对应章节",
                    "检查画布中的论证与引文，列出待核实之处",
                  ] : suggestions).map((suggestion, index) => (
                    <button
                      key={suggestion}
                      onClick={() => setInput(suggestion)}
                    >
                      <span>
                        {index === 0 ? (
                          <Database size={17} />
                        ) : index === 1 ? (
                          <Search size={17} />
                        ) : (
                          <GitBranch size={17} />
                        )}
                      </span>
                      {suggestion}
                      <ArrowRight size={14} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {compressed.start > 0 && (
                  <div className="compress-divider">
                    已压缩 {compressed.start} 条较早消息 · 工具记录不计入上下文
                  </div>
                )}
                {messages.length > 25 && !showAllMessages && (
                  <div style={{ textAlign: "center", margin: "14px 0" }}>
                    <button
                      type="button"
                      className="load-more-btn"
                      onClick={() => setShowAllMessages(true)}
                    >
                      查看更早的历史记录（还有 {messages.length - 25} 条）
                    </button>
                  </div>
                )}
                {(showAllMessages
                  ? messages.slice(compressed.start)
                  : messages.slice(Math.max(compressed.start, messages.length - 25))
                ).map((message, index) => (
                  <div className={`message ${message.role}`} key={index}>
                    {message.role === "assistant" && (
                      <div className="assistant-mark">
                        <Bot size={15} />
                      </div>
                    )}
                    <div>
                      <div className="message-header-line">
                        <span
                          className={`message-role ${activeMeta?.isGroup && message.role === "assistant" ? "group-sender" : ""}`}
                          onClick={() => {
                            if (activeMeta?.isGroup && message.senderName && message.senderName !== "系统") {
                              const mention = `@${message.senderName} `;
                              setInput((prev) => (prev.includes(mention) ? prev : `${mention}${prev}`));
                              composerTextareaRef.current?.focus();
                            }
                          }}
                          title={activeMeta?.isGroup && message.role === "assistant" ? "点击在输入框 @TA" : undefined}
                        >
                          {activeMeta?.isGroup ? (
                            message.role === "user" ? (
                              "你"
                            ) : (
                              <>
                                <strong>{message.senderName || message.result?.selected_agent?.name || "智能体"}</strong>
                                {message.isHost && (
                                  <span className="group-role-badge host">主持</span>
                                )}
                              </>
                            )
                          ) : (
                            message.role === "user"
                              ? "你"
                              : message.result?.selected_agent?.name || "AegisMesh"
                          )}
                        </span>
                        {message.streaming && (
                          <div className="turn-status" role="status" aria-live="polite">
                            <span className="turn-status-text">
                              {agents.find((agent) => agent.id === agentId)?.role ===
                              "leader"
                                ? "正在协调"
                                : agents.find((agent) => agent.id === agentId)
                                  ? "正在执行"
                                  : "平台调度中"}
                            </span>
                            {sendingSince !== null && (
                              <>
                                <span className="turn-status-sep">·</span>
                                <TurnClock start={sendingSince} />
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      {message.result && (
                        <ConciseTurn
                          result={message.result}
                          onInspect={(tab) => {
                            setInspector(message.result!);
                            setDetail(tab);
                            setInspectorCollapsed(false);
                            setMobileInspectorOpen(true);
                          }}
                        />
                      )}
                      {message.attachments && message.attachments.length > 0 && (
                        <div className="message-attachments-container">
                          {message.attachments.map((att) =>
                            att.is_image ? (
                              <a
                                key={att.file_id}
                                href={att.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="message-attachment-image-link"
                              >
                                <img
                                  src={att.url}
                                  alt={att.filename}
                                  className="message-attachment-image"
                                />
                              </a>
                            ) : (
                              <a
                                key={att.file_id}
                                href={att.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="message-attachment-doc-chip"
                                title="点击查看/下载原始文件"
                              >
                                <FileText size={14} />
                                <span className="doc-chip-name">{att.filename}</span>
                                <span className="doc-chip-meta">
                                  ({formatFileSize(att.size)}
                                  {att.text_length ? ` · 提取 ${att.text_length} 字` : ""})
                                </span>
                              </a>
                            ),
                          )}
                        </div>
                      )}
                      {message.result?.structured_output && message.result.status === 'completed'
                        ? <StructuredResult value={message.result.structured_output}/>
                        : <MarkdownText text={message.text} streaming={message.streaming} />}
                      {message.streaming && (
                        <>
                          {Object.values(liveSubagents)
                            .filter((s) => s.status === "running")
                            .map((sub) => (
                              <LiveSubagentRow
                                key={sub.task_id || sub.agent_id}
                                liveSubagent={sub}
                                onInspect={(tab) => {
                                  setDetail(tab);
                                  setInspectorCollapsed(false);
                                  setMobileInspectorOpen(true);
                                }}
                              />
                            ))}
                        </>
                      )}
                      {message.result && (
                        <div className="message-result-actions">
                          <button
                            className="route-chip"
                            onClick={() => {
                              setInspector(message.result!);
                              setDetail("route");
                              setInspectorCollapsed(false);
                              setMobileInspectorOpen(true);
                            }}
                          >
                            <Route size={13} />
                            {formatMs(message.result.latency_ms)}
                          </button>
                          <div className="message-feedback-actions" aria-label="回复评价">
                            <button
                              type="button"
                              aria-label="复制回复"
                              onClick={() => void navigator.clipboard.writeText(message.text)}
                            >
                              <Copy size={14} />
                            </button>
                            <button
                              type="button"
                              className={message.feedback === "positive" ? "active" : ""}
                              aria-label="回复优秀"
                              aria-pressed={message.feedback === "positive"}
                              disabled={feedbackBusy === message.result.invocation_id}
                              onClick={() => void rateMessage(message, "positive")}
                            >
                              <ThumbsUp size={14} />
                            </button>
                            <button
                              type="button"
                              className={message.feedback === "negative" ? "active negative" : ""}
                              aria-label="回复不佳"
                              aria-pressed={message.feedback === "negative"}
                              disabled={feedbackBusy === message.result.invocation_id}
                              onClick={() => void rateMessage(message, "negative")}
                            >
                              <ThumbsDown size={14} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}
            {sending && activeIdRef.current === taskConvRef.current && !messages.some((m) => m.streaming) && (
              <div className="message assistant">
                <div className="assistant-mark">
                  <Network size={15} />
                </div>
                <div>
                  <div className="message-header-line">
                    <span className="message-role">
                      {agents.find((agent) => agent.id === agentId)?.name ||
                        "AegisMesh"}
                    </span>
                    <div className="turn-status" role="status" aria-live="polite">
                      <span className="turn-status-text">
                        {agents.find((agent) => agent.id === agentId)?.role ===
                        "leader"
                          ? "正在协调"
                          : agents.find((agent) => agent.id === agentId)
                            ? "正在执行"
                            : "平台调度中"}
                      </span>
                      {sendingSince !== null && (
                        <>
                          <span className="turn-status-sep">·</span>
                          <TurnClock start={sendingSince} />
                        </>
                      )}
                    </div>
                  </div>
                  {activeIdRef.current === taskConvRef.current && Object.values(liveSubagents)
                    .filter((s) => s.status === "running")
                    .map((sub) => (
                      <LiveSubagentRow
                        key={sub.task_id || sub.agent_id}
                        liveSubagent={sub}
                        onInspect={(tab) => {
                          setDetail(tab);
                          setInspectorCollapsed(false);
                          setMobileInspectorOpen(true);
                        }}
                      />
                    ))}
                </div>
              </div>
            )}
          </div>
          <form
            className={`composer ${queue.length > 0 ? "has-queue" : ""}`}
            ref={composerRef}
            onSubmit={submit}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                void handleFileUpload(e.dataTransfer.files);
              }
            }}
          >
            {queue.length > 0 && (
              <div className="composer-queue-card">
                {queue.map((item) => (
                  <div className="composer-queue-row" key={item.id}>
                    <div className="queue-row-left">
                      <GripVertical size={13} className="queue-grip-icon" />
                      <span className="queue-item-text">{item.text}</span>
                    </div>
                    <div className="queue-row-actions">
                      <button
                        type="button"
                        className="queue-act-btn promote"
                        onClick={() => handlePromoteTask(item)}
                        title="立即执行此项"
                      >
                        <ArrowUp size={12} />
                        <span>立即</span>
                      </button>
                      <button
                        type="button"
                        className="queue-act-btn icon-only"
                        onClick={() => handleEditTask(item)}
                        title="编辑并放回输入框"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        className="queue-act-btn icon-only"
                        onClick={() => handleDeleteTask(item.id)}
                        title="从队列中删除"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: "none" }}
              multiple
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  void handleFileUpload(e.target.files);
                }
              }}
            />
            {attachments.length > 0 && (
              <div className="composer-attachments">
                {attachments.map((att) => (
                  <div key={att.file_id} className="composer-attachment-pill" title={att.filename}>
                    {att.is_image ? (
                      <img className="attachment-pill-preview" src={att.url} alt="" />
                    ) : (
                      <span className="attachment-pill-icon"><FileText size={13} /></span>
                    )}
                    <span className="attachment-pill-name">{att.filename}</span>
                    <span className="attachment-pill-size">({formatFileSize(att.size)})</span>
                    <button
                      type="button"
                      className="attachment-remove-btn"
                      onClick={() => setAttachments((prev) => prev.filter((a) => a.file_id !== att.file_id))}
                      title="移除附件"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {mentionMenuOpen && mentionList.length > 0 && (
              <div className="mention-popup" role="listbox">
                {mentionList.map((item, idx) => (
                  <div
                    key={item.id}
                    className={`mention-popup-item ${idx === mentionIndex ? "active" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      insertMention(item.name);
                    }}
                    onMouseEnter={() => setMentionIndex(idx)}
                    role="option"
                    aria-selected={idx === mentionIndex}
                  >
                    <div className="mention-popup-left">
                      <div className={`mention-popup-icon ${item.isAll ? "is-all" : ""}`}>
                        {item.isAll ? "@" : <Bot size={13} />}
                      </div>
                      <span className="mention-popup-name">
                        {item.isAll ? "所有人" : item.name}
                      </span>
                    </div>
                    <span className="mention-popup-tag">{item.roleTag}</span>
                  </div>
                ))}
              </div>
            )}
            {!activeMeta?.isGroup && !isCanvasConv && agents.find(agent => agent.id === agentId)?.structured_io_enabled && <StructuredTaskControls
              agent={agents.find(agent => agent.id === agentId)!} enabled={structuredEnabled} skillId={structuredSkill} values={structuredValues}
              onEnabled={value => { setStructuredEnabled(value); setStructuredError(''); }}
              onSkill={value => { setStructuredSkill(value); setStructuredValues({}); setStructuredError(''); }}
              onValues={value => { setStructuredValues(value); setStructuredError(''); }}/>}
            {structuredError && <p className="builder-error" role="alert">{structuredError}</p>}
            <textarea
              ref={composerTextareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleInputKeyDown}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              placeholder={
                activeMeta?.isGroup
                  ? `给 ${loadConversationData(activeId)?.groupConfig?.name || "群聊"} 发消息`
                  : sending
                    ? queue.length > 0
                      ? "继续输入以排队后续修改"
                      : "继续输入，消息将加入队列"
                    : attachments.length > 0
                      ? "输入对已上传材料的研讨或分析指令（可直接回车发送）..."
                      : isCanvasConv ? "描述要写入或修改的内容" : "请输入问题"
              }
              rows={1}
            />
            <div className="composer-bottom">
              <div className="composer-bottom-left">
                <button
                  type="button"
                  className="composer-upload-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  title="上传学术文献、论文或图片 (PDF, DOCX, TXT, MD, CSV, JSON, PNG, JPG 等)"
                >
                  {uploading ? <FlowMark className="flow-mark-compact" /> : <Paperclip size={14} />}
                  <span>{uploading ? "解析中..." : "上传材料"}</span>
                </button>
                {!activeMeta?.isGroup && (
                  <AgentPicker
                    className="runtime-mode"
                    value={agentId}
                    onChange={handleAgentSelect}
                    agents={isCanvasConv || executionMode === 'bounty' ? agents.filter((agent) => agent.role === "leader") : agents}
                  />
                )}
                {!activeMeta?.isGroup && !isCanvasConv && bountyEnabled && <Dropdown
                  className="runtime-mode" title="协作方式" value={executionMode}
                  options={[{ value: 'route', label: '默认调度' }, { value: 'bounty', label: '竞标模式' }]}
                  onChange={value => setExecutionMode(value as 'route' | 'bounty')} />}
              </div>
              <div className="composer-bottom-right">
                {settings.showContextMeter && (
                  <div className="context-menu-anchor" ref={contextMenuRef}>
                    <button
                      type="button"
                      className={`context-ring-btn ${contextPercent >= 80 ? "high" : contextPercent >= 60 ? "mid" : ""}`}
                      onClick={() => setContextMenuOpen((prev) => !prev)}
                      title={`上下文容量：${contextPercent}%（点击查看详情）`}
                      aria-label="查看上下文容量详情"
                    >
                      <ContextRing percent={contextPercent} />
                    </button>
                    {contextMenuOpen && (
                      <div className="context-popover" role="dialog" aria-label="上下文容量">
                        <div className="context-popover-row">
                          <span className="context-popover-title">上下文容量</span>
                          <span className="context-popover-value">
                            {formatTokensZh(compressed.tokens)}/{formatTokensZh(settings.contextWindow)}（{contextPercent}%）
                          </span>
                        </div>
                        <div className="context-popover-track">
                          <div
                            className="context-popover-fill"
                            data-level={
                              contextPercent >= 80
                                ? "high"
                                : contextPercent >= 60
                                  ? "mid"
                                  : "low"
                            }
                            style={{ width: `${contextPercent}%` }}
                          />
                        </div>
                        <div className="context-popover-row context-popover-sub">
                          <span>平均缓存命中率</span>
                          <span className="context-popover-bold">
                            {compressed.start > 0
                              ? `${Math.max(82.0, 98.5 - compressed.start * 1.5).toFixed(1)}%`
                              : "95.8%"}
                          </span>
                        </div>
                        <div className="context-popover-row context-popover-sub">
                          <span>压缩策略</span>
                          <span className="context-popover-bold">
                            {settings.compressionStrategy === "aggressive"
                              ? "激进精简 (40%)"
                              : settings.compressionStrategy === "conservative"
                                ? "宽容保留 (80%)"
                                : settings.compressionStrategy === "off"
                                  ? "关闭压缩"
                                  : "自适应 (60%)"}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {sending ? (
                  input.trim() || attachments.length > 0 ? (
                    <button
                      type="submit"
                      className="send-button queue-add-button"
                      title="加入队列"
                    >
                      <ListPlus size={16} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="send-button stop"
                      onClick={handleStopTask}
                      title="中断任务"
                    >
                      <Square size={13} fill="currentColor" />
                    </button>
                  )
                ) : (
                  <button
                    type="submit"
                    className="send-button"
                    disabled={!input.trim() && attachments.length === 0}
                    title="发送"
                  >
                    <Send size={16} />
                  </button>
                )}
              </div>
            </div>
          </form>
        </section>
      )}
      {!isCanvasConv && (
        <aside id="chat-route-inspector" className="route-inspector" inert={!inspectorVisible} aria-hidden={!inspectorVisible}>
          <div className="inspector-mobile-bar">
            <div className="inspector-mobile-title">
              <SlidersHorizontal size={14} />
              <span>路由与诊断</span>
            </div>
            <button
              className="mobile-drawer-close"
              onClick={() => setMobileInspectorOpen(false)}
              title="关闭详情"
              aria-label="关闭详情"
            >
              <X size={16} />
            </button>
          </div>
          <div className="inspector-header">
            <div
              className="detail-tabs"
              role="tablist"
              style={{
                "--pill-count": activeMeta?.isGroup ? 3 : 2,
                "--pill-index": activeMeta?.isGroup
                  ? Math.max(0, ["members", "collaboration", "blackboard"].indexOf(detail))
                  : Math.max(0, ["route", "collaboration"].indexOf(detail)),
              } as CSSProperties}
            >
              {activeMeta?.isGroup ? (
                <>
                  <button
                    className={detail === "members" ? "active" : ""}
                    onClick={() => setDetail("members")}
                    role="tab" aria-selected={detail === "members"} title="成员"
                  >
                    <Users size={14} /><span className="tab-label">成员</span>
                  </button>
                  <button
                    className={detail === "collaboration" ? "active" : ""}
                    onClick={() => setDetail("collaboration")}
                    role="tab" aria-selected={detail === "collaboration"} title="协作"
                  >
                    <GitBranch size={14} /><span className="tab-label">协作</span>
                  </button>
                  <button
                    className={detail === "blackboard" ? "active" : ""}
                    onClick={() => setDetail("blackboard")}
                    role="tab" aria-selected={detail === "blackboard"} title="黑板"
                  >
                    <FileText size={14} /><span className="tab-label">黑板</span> {blackboardDeliverables.length > 0 && <span className="tab-badge">{blackboardDeliverables.length}</span>}
                  </button>
                </>
              ) : (
                <>
                  <button
                    className={detail === "route" ? "active" : ""}
                    onClick={() => setDetail("route")}
                    role="tab" aria-selected={detail === "route"} title="路由"
                  >
                    <Route size={14} /><span className="tab-label">路由</span>
                  </button>
                  <button
                    className={detail === "collaboration" ? "active" : ""}
                    onClick={() => setDetail("collaboration")}
                    role="tab" aria-selected={detail === "collaboration"} title="协作"
                  >
                    <Users size={14} /><span className="tab-label">协作</span>
                  </button>
                </>
              )}
            </div>
        </div>
        {activeMeta?.isGroup && detail === "members" && (
          <GroupMembersPanel
            activeConv={
              loadConversationData(activeId) || {
                id: activeId,
                title: activeMeta?.title || "智能体协作讨论群",
                messages: [],
              }
            }
            agents={agents}
            onUpdateConfig={(patch) => updateGroupConfig(activeId, patch)}
            onClearChat={() => {
              if (window.confirm("确定清空当前群聊的所有聊天记录与黑板成果吗？")) {
                setMessages([]);
                setLiveBlackboardMessages([]);
                const conv = loadConversationData(activeId);
                if (conv) {
                  conv.messages = [];
                  saveConversationData(conv);
                }
              }
            }}
            onSwitchToBlackboard={() => setDetail("blackboard")}
            onMentionAgent={(name) => {
              const mentionText = `@${name} `;
              setInput((prev) => (prev.includes(mentionText) ? prev : `${mentionText}${prev}`));
              composerTextareaRef.current?.focus();
            }}
          />
        )}
        {!activeMeta?.isGroup && detail === "route" && (
          (inspector || activeDispatches.length > 0 || dynamicDiscoveredCandidates.length > 0) ? (
            <>
              <div className="selected-route">
                <span>已选择主控</span>
                <strong>{inspector?.selected_agent?.name || agents.find((a) => a.id === agentId)?.name || "科研智能体协作平台"}</strong>
                {sending && (
                  <div className="route-running-pulse">
                    <FlowMark className="flow-mark-compact" />
                    <span>本轮任务调度执行中...</span>
                  </div>
                )}
              </div>

              {/* 1. 本轮实时调度与协同状态 */}
              {activeDispatches.length > 0 && (
                <div className="route-section-group">
                  <div className="route-section-title">
                    <GitBranch size={13} color="#6366f1" />
                    <span>本轮实时调度智能体 ({activeDispatches.length})</span>
                  </div>
                  <div className="route-dispatches-list">
                    {activeDispatches.map((disp) => <DispatchCard key={`${disp.id}-${disp.task}`} dispatch={disp} />)}
                  </div>
                </div>
              )}

              {/* 2. 本轮动态全网发现候选 */}
              {dynamicDiscoveredCandidates.length > 0 && (
                <div className="route-section-group">
                  <div className="route-section-title">
                    <Search size={13} color="#0d9488" />
                    <span>本轮全网动态发现候选 ({dynamicDiscoveredCandidates.length})</span>
                  </div>
                  <div className="discovered-candidates-list">
                    {dynamicDiscoveredCandidates.map((c) => (
                      <div key={c.id} className="discovered-cand-card">
                        <div className="discovered-name-row">
                          <strong>{c.name}</strong>
                          {typeof c.match_score === "number" && c.match_score > 0 && (
                            <span className="score-tag">{c.match_score} 分{c.eligible === false ? " · 不可用" : ""}</span>
                          )}
                          <span className="source-tag">{c.source}</span>
                        </div>
                        <p className="discovered-desc">{c.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 3. 初选融合打分与候选 */}
              {inspector?.candidates && inspector.candidates.length > 0 && (
                <div className="candidate-scores">
                  <div className="route-section-title" style={{ padding: "10px 0 6px" }}>
                    <SlidersHorizontal size={13} color="var(--c888882)" />
                    <span>初选评估与 TOPSIS 综合打分</span>
                  </div>
                  {inspector.candidates.some((item) => item.weights && Object.keys(item.weights).length > 0) && (
                    <p className="muted">
                      本次融合权重
                      {Object.entries(
                        inspector.candidates.find((item) => item.weights && Object.keys(item.weights).length > 0)?.weights || {},
                      )
                        .map(([key, value]) => ` ${metricLabels[key] || key} ${Math.round(value * 100)}%`)
                        .join(" ·")}
                    </p>
                  )}
                  {inspector.candidates.map((candidate) => (
                    <div key={candidate.agent_id}>
                      <div>
                        <span className="rank">{candidate.eligible ? candidate.rank : "—"}</span>
                        <strong>{candidate.agent_name}</strong>
                        <b>{candidate.eligible ? candidate.score : "未入选"}</b>
                      </div>
                      {candidate.eligible && <ScoreBar value={candidate.score} />}
                      {candidate.reasons.length > 0 && (
                        <p className="muted">{candidate.reasons.slice(0, 2).join(" · ")}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* 4. Token 消耗 */}
              {inspector?.usage && (
                <div className="usage-box">
                  <div>
                    <span>模型调用</span>
                    <strong>{inspector.usage.llm_calls}</strong>
                  </div>
                  <div>
                    <span>输入 Token</span>
                    <strong>{inspector.usage.prompt_tokens}</strong>
                  </div>
                  <div>
                    <span>输出 Token</span>
                    <strong>{inspector.usage.completion_tokens}</strong>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="inspector-empty">
              {sending ? "正在评估路由与可用智能体..." : "等待运行记录"}
            </div>
          )
        )}
        {detail === "collaboration" && (
          activeMeta?.isGroup ? (
            <GroupCollaborationPanel
              messages={messages}
              liveBlackboardMessages={liveBlackboardMessages}
              groupMembers={loadConversationData(activeId)?.groupConfig?.members || []}
              agents={agents}
            />
          ) : (
            <>
            <CollaborationPanel
              key={activeId}
              inspector={inspector}
              messages={messages}
              sessionResults={sessionActivity.session === session ? sessionActivity.results : []}
              liveSubagents={Object.values(liveSubagents)}
              liveBlackboardMessages={liveBlackboardMessages}
              toolNames={toolNames}
            />
            {sessionActivity.session === session && sessionActivity.error && <button className="activity-history-control" onClick={() => setActivityRefresh(v => v + 1)}>协作记录加载失败，点击重试</button>}
            {sessionActivity.session === session && sessionActivity.next && <button className="activity-history-control" onClick={() => void loadMoreActivity()}>加载更早的协作记录</button>}
            </>
          )
        )}
        {activeMeta?.isGroup && detail === "blackboard" && (
          <BlackboardPanel items={blackboardDeliverables} />
        )}
      </aside>
      )}
      {settingsOpen && (
        <SettingsDialog
          historySync={sync}
          initialSection={settingsSection}
          settings={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
          onClear={clearConversations}
        />
      )}
      {pendingAgentSwitch && (
        <AgentSwitchModal
          currentAgentName={
            agents.find((a) => a.id === agentId)?.name || agentId
          }
          targetAgentName={pendingAgentSwitch.targetName}
          onCancel={() => setPendingAgentSwitch(null)}
          onSwitchHere={() => {
            setAgentId(pendingAgentSwitch.targetId);
            setPendingAgentSwitch(null);
          }}
          onNewSession={() => {
            const targetId = pendingAgentSwitch.targetId;
            setPendingAgentSwitch(null);
            createConversation(targetId);
          }}
        />
      )}
      <GroupSettingsDrawer
        isOpen={groupModalOpen && groupModalMode === "create"}
        mode={groupModalMode}
        targetConv={
          groupModalTargetId
            ? loadConversationData(groupModalTargetId)
            : activeMeta?.isGroup
              ? loadConversationData(activeId)
              : null
        }
        agents={agents}
        onClose={() => setGroupModalOpen(false)}
        onSubmit={(config) => {
          if (groupModalMode === "create") {
            createGroupConversation(config);
          } else {
            updateGroupConfig(groupModalTargetId || activeId, config);
          }
        }}
        onClearChat={() => {
          if (window.confirm("确定清空当前群聊的所有消息记录吗？")) {
            setMessages([]);
            setLiveBlackboardMessages([]);
            const cid = groupModalTargetId || activeId;
            const conv = loadConversationData(cid);
            if (conv) {
              conv.messages = [];
              saveConversationData(conv);
            }
            setGroupModalOpen(false);
          }
        }}
        onViewCollaboration={() => {
          setDetail("collaboration");
          setInspectorCollapsed(false);
          setGroupModalOpen(false);
        }}
      />
    </div>
  );
}

function formatRunDuration(ms: number) {
  if (!ms || ms <= 0) return "0s";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 1) {
    return `${Math.round(ms)}ms`;
  }
  if (totalSeconds < 60) {
    return totalSeconds % 1 !== 0 && totalSeconds < 10
      ? `${totalSeconds.toFixed(1)}s`
      : `${Math.round(totalSeconds)}s`;
  }
  const total = Math.round(totalSeconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}m ${secs}s`;
}

function TurnClock({ start }: { start: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const total = Math.max(0, Math.floor((now - start) / 1000));
  const text =
    total < 60
      ? `${total}s`
      : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  return (
    <span className="turn-clock" translate="no">
      {text}
    </span>
  );
}

function getToolIcon(name: string) {
  if (name === "dispatch_task") return Bot;
  if (name === "list_agents") return ScanSearch;
  if (name === "check_subagent_status") return Activity;
  if (name === "web_search") return Search;
  if (name === "read_web_page") return FileText;
  if (name === "calculator") return Braces;
  if (name === "current_time") return Clock;
  return TerminalSquare;
}

function ConciseItem({
  icon: Icon,
  title,
  subtitle,
  args,
  output,
  extra,
  duration,
}: {
  icon: any;
  title: string;
  subtitle?: string;
  args?: any;
  output?: any;
  extra?: React.ReactNode;
  duration?: string;
}) {
  const [open, setOpen] = useState(false);
  const hasDetails =
    (args !== undefined &&
      (typeof args !== "object" ||
        args === null ||
        Object.keys(args).length > 0)) ||
    output !== undefined ||
    extra !== undefined;

  return (
    <div className="concise-item" data-open={open || undefined}>
      <button
        type="button"
        className="concise-item-header"
        onClick={() => hasDetails && setOpen((v) => !v)}
        disabled={!hasDetails}
        style={{ cursor: hasDetails ? "pointer" : "default" }}
        aria-expanded={hasDetails ? open : undefined}
      >
        <span className="concise-leading">
          <span className="concise-icon-idle">
            <Icon size={12} />
          </span>
          {hasDetails && (
            <ChevronRight size={12} className={`chev ${open ? "open" : ""}`} />
          )}
        </span>
        <span className="concise-item-title">{title}</span>
        {subtitle && <span className="concise-item-subtitle">{subtitle}</span>}
        {duration && (
          <>
            <span className="concise-turn-dot" />
            <span className="concise-turn-duration">{duration}</span>
          </>
        )}
      </button>
      {open && hasDetails && (
        <div className="concise-item-details">
          {args !== undefined && (
            <div className="concise-io-block">
              <span className="concise-io-label">参数</span>
              <pre className="concise-io-code">
                <code>
                  {typeof args === "string"
                    ? args
                    : JSON.stringify(args, null, 2)}
                </code>
              </pre>
            </div>
          )}
          {output !== undefined && (
            <div className="concise-io-block">
              <span className="concise-io-label">结果</span>
              <pre className="concise-io-code">
                <code>
                  {typeof output === "string"
                    ? output
                    : JSON.stringify(output, null, 2)}
                </code>
              </pre>
            </div>
          )}
          {extra}
        </div>
      )}
    </div>
  );
}

function ConciseAgentItem({
  action,
  onInspect,
  duration,
}: {
  action: Extract<TurnAction, { kind: "agent" }>;
  onInspect: (tab: "route" | "collaboration") => void;
  duration?: string;
}) {
  const [open, setOpen] = useState(false);
  const targetAgent = action.agentName;
  const isGeneric =
    !targetAgent ||
    targetAgent === "执行智能体" ||
    targetAgent === "协同智能体";
  let subtitle: string | undefined;
  if (!isGeneric && action.task) {
    const combined = `目标: ${targetAgent} · ${action.task}`;
    subtitle = combined.length > 40 ? combined.slice(0, 40) + "..." : combined;
  } else if (!isGeneric) {
    subtitle = `目标: ${targetAgent}`;
  } else if (action.task) {
    const t = String(action.task).trim();
    subtitle = t.length > 35 ? t.slice(0, 35) + "..." : t;
  }

  const hasDetails = Boolean(
    action.task ||
      action.output !== undefined ||
      (action.totalCollabs && action.totalCollabs > 0),
  );

  return (
    <div className="concise-item" data-open={open || undefined}>
      <button
        type="button"
        className="concise-item-header"
        onClick={() => hasDetails && setOpen((v) => !v)}
        disabled={!hasDetails}
        style={{ cursor: hasDetails ? "pointer" : "default" }}
        aria-expanded={hasDetails ? open : undefined}
      >
        <span className="concise-leading">
          <span className="concise-icon-idle">
            <Bot size={13} />
          </span>
          {hasDetails && (
            <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} />
          )}
        </span>
        <span className="concise-item-title">智能体已创建</span>
        {subtitle && <span className="concise-item-subtitle">{subtitle}</span>}
        {duration && (
          <>
            <span className="concise-turn-dot" />
            <span className="concise-turn-duration">{duration}</span>
          </>
        )}
      </button>
      {open && hasDetails && (
        <div className="concise-item-details">
          {action.task && (
            <div className="concise-io-block">
              <span className="concise-io-label">分配任务</span>
              <div className="concise-io-text">{action.task}</div>
            </div>
          )}
          {action.callChain && action.callChain.length > 1 && (
            <div className="concise-io-block">
              <span className="concise-io-label">调用链追踪</span>
              <div className="concise-io-text" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" }}>
                {action.callChain.map((step, idx) => (
                  <span key={idx} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <span style={{
                      padding: "1px 6px",
                      borderRadius: "4px",
                      fontSize: "11px",
                      background: idx === action.callChain!.length - 1 ? "var(--accent-subtle, #eff6ff)" : "var(--bg-secondary, #f1f5f9)",
                      color: idx === action.callChain!.length - 1 ? "var(--accent, #2563eb)" : "inherit",
                      fontWeight: idx === action.callChain!.length - 1 ? 600 : 400,
                    }}>
                      {step}
                    </span>
                    {idx < action.callChain!.length - 1 && <span style={{ opacity: 0.4 }}>→</span>}
                  </span>
                ))}
              </div>
            </div>
          )}
          {action.output !== undefined && (
            <div className="concise-io-block">
              <span className="concise-io-label">执行结果</span>
              <pre className="concise-io-code">
                <code>
                  {typeof action.output === "string"
                    ? action.output
                    : JSON.stringify(action.output, null, 2)}
                </code>
              </pre>
            </div>
          )}
          {action.totalCollabs > 0 && (
            <button
              type="button"
              className="concise-link"
              onClick={() => onInspect("collaboration")}
            >
              查看协同详情 ({action.totalCollabs} 个记录){" "}
              <ChevronRight size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ConciseSingleToolItem({
  tool,
  duration,
}: {
  tool: Extract<TurnAction, { kind: "tool" }>;
  duration?: string;
}) {
  const subtitle = getToolSubtitle(tool.arguments);
  const Icon = getToolIcon(tool.name);

  return (
    <ConciseItem
      icon={Icon}
      title={toolNames[tool.name] || tool.name}
      subtitle={subtitle}
      args={tool.arguments}
      output={tool.output}
      duration={duration}
    />
  );
}

function ConciseToolGroup({
  tools,
  summaryTitle,
  leadIconName,
  duration,
}: {
  tools: Extract<TurnAction, { kind: "tool" }>[];
  summaryTitle: string;
  leadIconName: string;
  duration?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const LeadIcon = getToolIcon(leadIconName);

  return (
    <div className="concise-turn-root" data-open={expanded || undefined}>
      <button
        type="button"
        className="concise-turn-trigger"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="concise-leading">
          <span className="concise-icon-idle">
            <LeadIcon size={13} />
          </span>
          <ChevronRight size={13} className={`chev ${expanded ? "open" : ""}`} />
        </span>
        <span className="concise-turn-title">{summaryTitle}</span>
        {duration && (
          <>
            <span className="concise-turn-dot" />
            <span className="concise-turn-duration">{duration}</span>
          </>
        )}
      </button>
      {expanded && (
        <div className="concise-turn-body">
          {tools.map((item, index) => {
            const subtitle = getToolSubtitle(item.arguments);
            const Icon = getToolIcon(item.name);

            return (
              <ConciseItem
                key={`${item.name}-${index}`}
                icon={Icon}
                title={toolNames[item.name] || item.name}
                subtitle={subtitle}
                args={item.arguments}
                output={item.output}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConciseTurn({
  result,
  onInspect,
}: {
  result: ChatResult;
  onInspect: (tab: "route" | "collaboration") => void;
}) {
  const actions = useMemo(() => buildTurnActions(result), [result]);
  const blocks = useMemo(() => partitionTurnActions(actions), [actions]);
  const duration = useMemo(
    () => formatRunDuration(result.latency_ms),
    [result.latency_ms],
  );

  if (!blocks.length) return null;

  const toolGroupIdx = blocks.findIndex((b) => b.kind === "tool_group");
  const durationIdx = toolGroupIdx >= 0 ? toolGroupIdx : blocks.length - 1;

  return (
    <div className="concise-turn-flow">
      {blocks.map((block, idx) => {
        const itemDuration = idx === durationIdx ? duration : undefined;
        if (block.kind === "agent") {
          return (
            <ConciseAgentItem
              key={`agent-${idx}`}
              action={block.action}
              onInspect={onInspect}
              duration={itemDuration}
            />
          );
        }
        if (block.kind === "tool_group") {
          return (
            <ConciseToolGroup
              key={`group-${idx}`}
              tools={block.tools}
              summaryTitle={block.summaryTitle}
              leadIconName={block.leadIconName}
              duration={itemDuration}
            />
          );
        }
        return (
          <ConciseSingleToolItem
            key={`single-${idx}`}
            tool={block.action}
            duration={itemDuration}
          />
        );
      })}
    </div>
  );
}

function LiveSubagentRow({
  liveSubagent,
  onInspect,
}: {
  liveSubagent: LiveSubagentState;
  onInspect: (tab: "route" | "collaboration") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolLabel = liveSubagent.current_tool
    ? toolNames[liveSubagent.current_tool] || liveSubagent.current_tool
    : null;
  const title = `智能体已创建 · ${liveSubagent.agent_name}${toolLabel ? ` · 正在调用${toolLabel}` : ""}`;

  return (
    <div
      className="concise-turn-root live"
      data-state="running"
      data-open={expanded || undefined}
    >
      <button
        type="button"
        className="concise-turn-trigger"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="concise-leading">
          <span className="concise-icon-idle">
            <Bot size={13} />
          </span>
          <ChevronRight size={13} className={`chev ${expanded ? "open" : ""}`} />
        </span>
        <span className="concise-turn-title">{title}</span>
        <span className="concise-turn-dot" />
        <span className="concise-turn-duration live-pulse">协同执行中</span>
      </button>
      {expanded && (
        <div className="concise-turn-body">
          <div className="concise-item open">
            <div className="concise-item-header" style={{ cursor: "default" }}>
              <span className="concise-item-icon">
                <Bot size={12} />
              </span>
              <span className="concise-item-title">{liveSubagent.agent_name}</span>
              <span className="concise-item-subtitle">{liveSubagent.agent_id}</span>
            </div>
            {(liveSubagent.task || toolLabel) && (
              <div className="concise-item-details">
                {liveSubagent.task && (
                  <div className="concise-io-block">
                    <span className="concise-io-label">分配任务</span>
                    <div className="concise-io-text">{liveSubagent.task}</div>
                  </div>
                )}
                {liveSubagent.call_chain && liveSubagent.call_chain.length > 1 && (
                  <div className="concise-io-block">
                    <span className="concise-io-label">调用链追踪</span>
                    <div className="concise-io-text" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" }}>
                      {liveSubagent.call_chain.map((step, idx) => (
                        <span key={idx} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <span style={{
                            padding: "1px 6px",
                            borderRadius: "4px",
                            fontSize: "11px",
                            background: idx === liveSubagent.call_chain!.length - 1 ? "var(--accent-subtle, #eff6ff)" : "var(--bg-secondary, #f1f5f9)",
                            color: idx === liveSubagent.call_chain!.length - 1 ? "var(--accent, #2563eb)" : "inherit",
                            fontWeight: idx === liveSubagent.call_chain!.length - 1 ? 600 : 400,
                          }}>
                            {step}
                          </span>
                          {idx < liveSubagent.call_chain!.length - 1 && <span style={{ opacity: 0.4 }}>→</span>}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {toolLabel && (
                  <div className="concise-io-block">
                    <span className="concise-io-label">实时工具</span>
                    <div className="concise-io-text">
                      {toolLabel}
                      {liveSubagent.tool_preview ? `：${liveSubagent.tool_preview}` : ""}
                    </div>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              className="concise-link"
              onClick={() => onInspect("collaboration")}
            >
              查看协同详情 <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ApiPage({ onBack }: { onBack?: () => void }) {
  const origin =
    typeof window !== "undefined" && window.location.origin
      ? window.location.origin
      : "https://demmo.cc.cd";
  const endpoints = [
    { method: "POST", path: "/api/chat", note: "运行任务" },
    { method: "POST", path: "/api/chat/stream", note: "流式运行任务" },
    { method: "POST", path: "/api/discovery/search", note: "发现智能体" },
    { method: "GET", path: "/api/agents/{id}/acs", note: "读取能力声明" },
  ];
  return (
    <div className="api-layout public-api">
      <section className="panel api-intro">
        <div className="api-header-row">
          <div className="api-icon">
            <TerminalSquare size={22} />
          </div>
          {onBack && (
            <button className="api-back-btn" onClick={onBack}>
              <ArrowLeft size={14} />
              <span>返回对话</span>
            </button>
          )}
        </div>
        <h2>开放 API</h2>
        <div className="code-block">
          <div>
            <span />
            <span />
            <span />
          </div>
          <code>
            curl -X POST {origin}/api/chat \<br />
            &nbsp;&nbsp;-H "X-API-Key: YOUR_KEY" \<br />
            &nbsp;&nbsp;-H "Content-Type: application/json" \<br />
            &nbsp;&nbsp;-d '&#123;"message":"开始任务"&#125;'
          </code>
        </div>
        <a
          className="primary-button inline"
          href="/docs"
          target="_blank"
          rel="noopener noreferrer"
        >
          API 文档 <ArrowRight size={15} />
        </a>
      </section>
      <section className="panel endpoint-panel">
        <div className="panel-heading">
          <h2>端点</h2>
          <Braces size={18} />
        </div>
        <div className="endpoint-list">
          {endpoints.map((endpoint) => (
            <div key={`${endpoint.method}-${endpoint.path}`}>
              <span className={endpoint.method.toLowerCase()}>
                {endpoint.method}
              </span>
              <code>{endpoint.path}</code>
              <p>{endpoint.note}</p>
              <ChevronRight size={15} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="skeleton-grid">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flow-sweep" />
      ))}
    </div>
  );
}

export default App;
