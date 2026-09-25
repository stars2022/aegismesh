import {
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
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
  Hash,
  Hourglass,
  Layers,
  ListPlus,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
  MessageSquareText,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Play,
  Pin,
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
  FileText,
  Loader2,
  Paperclip,
} from "lucide-react";
import { api } from "./api";
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
import {
  COMPRESSION_STRATEGIES,
  CONTEXT_WINDOWS,
  applyTheme,
  estimateTokens,
  loadSettings,
  saveSettings,
  type CompressionStrategy,
  type ThemeChoice,
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

type View =
  | "overview"
  | "studio"
  | "providers"
  | "routing"
  | "probes"
  | "traces"
  | "access";

const navigation: { id: View; label: string; icon: typeof LayoutDashboard }[] =
  [
    { id: "overview", label: "概览", icon: LayoutDashboard },
    { id: "studio", label: "智能体管理", icon: Bot },
    { id: "providers", label: "模型供应商", icon: ServerCog },
    { id: "routing", label: "路由策略", icon: Route },
    { id: "probes", label: "智能体探针", icon: ScanSearch },
    { id: "traces", label: "运行记录", icon: Activity },
    { id: "access", label: "访问与数据", icon: ShieldCheck },
  ];

const titles: Record<View, string> = {
  overview: "运行概览",
  studio: "智能体管理",
  providers: "模型供应商",
  routing: "路由策略",
  probes: "智能体探针",
  traces: "运行记录",
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

function App({ onLogout }: { onLogout?: () => void }) {
  const [view, setView] = useState<View>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
          <button
            className="sidebar-collapse"
            onClick={() => setSidebarCollapsed((value) => !value)}
            title={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
            aria-label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen size={16} />
            ) : (
              <PanelLeftClose size={16} />
            )}
          </button>
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
        <nav>
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
          <button className="mobile-menu" onClick={() => setMobileNav(true)}>
            <Menu size={20} />
          </button>
          <div>
            <h1>{titles[view]}</h1>
          </div>
          <div className="topbar-actions">
            <button
              className="icon-button"
              onClick={() => void load()}
              title="刷新"
            >
              <RefreshCw size={17} className={loading ? "spin" : ""} />
            </button>
            <a className="primary-small" href="/">
              <Play size={15} fill="currentColor" />
              打开聊天
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

  const loadAdpFeed = async (refresh = false) => {
    setAdpLoading(true);
    setAdpError("");
    try {
      const items = await api.discoveryFeed(refresh);
      setAdpAgents(items || []);
    } catch (err) {
      setAdpError(err instanceof Error ? err.message : "获取全网智能体失败");
    } finally {
      setAdpLoading(false);
    }
  };

  const handleToggleFeed = (checked: boolean) => {
    setShowAdpFeed(checked);
    if (checked && adpAgents.length === 0) {
      void loadAdpFeed();
    }
  };

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
    setPreviewAgent(null);
    setPreviewData(null);
    await register(target);
  };

  const register = async (agent: Agent) => {
    setRegBusy(agent.id);
    setRegNotice("");
    try {
      await api.registerAgent(agent.id);
      await onChanged();
      setRegNotice(`${agent.name} 已提交注册审核`);
    } catch (reason) {
      setRegNotice(reason instanceof Error ? reason.message : "提交注册失败");
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
      role !== "adp" &&
      (role === "all" || agent.role === role) &&
      `${agent.name} ${agent.description} ${agent.skills.map((skill) => skill.name).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );

  const adpFiltered = (showAdpFeed || role === "adp")
    ? adpAgents.filter((ext) => {
        if (role === "leader") return false;
        const text = `${ext.name} ${ext.description} ${ext.organization} ${(ext.skills || []).map((s: any) => s.name || s.id).join(" ")} ${ext.aic}`;
        return text.toLowerCase().includes(query.toLowerCase());
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
                <RefreshCw size={13} className={adpLoading ? "spin" : ""} />
              </button>
            )}
          </div>
        </div>
      </div>
      {regNotice && <div className="studio-notice">{regNotice}</div>}
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
                    <RefreshCw
                      size={11}
                      className={regBusy === agent.id ? "spin" : ""}
                    />
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
            style={{
              border: "1px dashed #38bdf8",
              background: "rgba(56, 189, 248, 0.03)",
              cursor: "pointer",
            }}
          >
            <div className="agent-card-top">
              <span className="agent-glyph large" style={{ background: "#e0f2fe", color: "#0284c7" }}>
                🌐
              </span>
              <span className="inline-status" style={{ background: "#f0fdf4", color: "#16a34a", padding: "2px 8px", borderRadius: "12px", fontSize: "11px", fontWeight: 600 }}>
                {ext.alive === false ? "发现记录为离线" : ext.alive === true ? "发现记录为存活" : "存活状态未知"}
              </span>
            </div>
            <div>
              <span className="eyebrow" style={{ color: "#0284c7" }}>
                {ext.organization || "全网外部节点"} · {ext.transport}
              </span>
              <h3>{ext.name}</h3>
              <p style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {ext.description || "暂无描述"}
              </p>
            </div>
            <div className="tag-row">
              {(ext.skills || []).slice(0, 3).map((skill: any) => (
                <span key={skill.id || skill.name} style={{ background: "#f1f5f9", color: "#475569" }}>
                  {skill.name || skill.id}
                </span>
              ))}
            </div>
            <div className="agent-card-stats">
              <div>
                <span>协议端点</span>
                <strong style={{ fontSize: "12px" }}>{ext.transport}</strong>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <span>全局 AIC 标识</span>
                <strong style={{ fontSize: "10px", wordBreak: "break-all" }}>{ext.aic}</strong>
              </div>
            </div>
            <div className="agent-card-reg">
              <span className="reg-pill" style={{ background: "#e0f2fe", color: "#0369a1" }}>
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

      {role === "adp" && adpFiltered.length === 0 && (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--muted)" }}>
          {adpLoading ? (
            <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <RefreshCw size={16} className="spin" />
              <span>正在从官方 ADP 发现服务拉取全网智能体...</span>
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
      const list = Object.entries(acsMap).map(([aic, acs]) => {
        const record = acs && typeof acs === "object" ? acs as Record<string, unknown> : {};
        const alive = aliveMap[aic] && typeof aliveMap[aic] === "object" ? (aliveMap[aic] as { alive?: boolean }).alive : undefined;
        return { ...record, aic: record.aic || aic, alive };
      });
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
              <h3>发现与接入外部智能体 (ACPs ADP)</h3>
              <p className="preview-modal-sub">
                连接梧桐官方发现服务检索全网已认证上线的第三方智能体并一键接入本平台
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
                placeholder="输入任务场景或能力关键词（如：文献检索、求职规划、问答）"
              />
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={() => void search(query)}
              disabled={loading || !query.trim()}
            >
              {loading ? <RefreshCw size={13} className="spin" /> : <Search size={13} />}
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
              <RefreshCw size={24} className="spin" />
              <span>正在向官方发现服务查询候选智能体...</span>
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

                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                      {httpsEp && (
                        <span style={{ fontSize: "10px", background: "rgba(59, 130, 246, 0.1)", color: "#3b82f6", padding: "2px 6px", borderRadius: "4px" }}>
                          HTTPS mTLS
                        </span>
                      )}
                      <span style={{ fontSize: "10px", background: "rgba(15, 23, 42, 0.06)", padding: "2px 6px", borderRadius: "4px" }}>
                        流式：{target.streaming || target.capabilities?.streaming ? "对方已声明" : "未声明"}
                      </span>
                      <span style={{ fontSize: "10px", background: "rgba(15, 23, 42, 0.06)", padding: "2px 6px", borderRadius: "4px" }}>
                        通知：{target.notification || target.capabilities?.notification ? "对方已声明，未配公网回调时仍轮询" : "未声明"}
                      </span>
                      <span style={{ fontSize: "10px", background: "rgba(168, 85, 247, 0.1)", color: "#a855f7", padding: "2px 6px", borderRadius: "4px" }}>
                        群组：{mqEp || declaredGroup(target) ? "对方已声明 AMQP，本平台未接入" : "未声明"}
                      </span>
                      {target.skills?.map((s: any) => (
                        <span key={s.id || s.name} style={{ fontSize: "10px", border: "1px solid var(--border)", padding: "2px 6px", borderRadius: "4px" }}>
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
              向官方梧桐注册中心提审前，请核验基础信息、技能声明与通信端点，并可单独配置提交审核的凭据。
            </p>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="preview-modal-loading">
            <RefreshCw size={24} className="spin" />
            <span>正在实时组装与校验 ACS 标准能力规范...</span>
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
                  {agent.security_schemes?.includes("mtls")
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
            disabled={loading || submitting}
          >
            {submitting ? (
              <>
                <RefreshCw size={13} className="spin" />
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

    onSave({
      id: cleanId,
      name: name.trim(),
      version: version.trim() || "1.0.0",
      description: description.trim(),
      tags,
      examples,
      input_modes: input_modes.length > 0 ? input_modes : ["text/plain"],
      output_modes:
        output_modes.length > 0 ? output_modes : ["application/json"],
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
  const [toolsSubmenuOpen, setToolsSubmenuOpen] = useState(true);
  const [customToolInput, setCustomToolInput] = useState("");
  const [skills, setSkills] = useState<Skill[]>(() => {
    if (agent?.skills && agent.skills.length > 0) {
      return agent.skills.map((s) => ({
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
      endpoint_url: form.endpoint_url,
      input_modes: ["text/plain", "application/json"],
      output_modes: ["application/json", "text/markdown"],
      security_schemes: ["mtls"],
      skills: skills.map((s) => ({
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
  const [notice, setNotice] = useState("");
  const remove = async (provider: Provider) => {
    if (!window.confirm(`删除供应商“${provider.name}”？`)) return;
    try {
      await api.deleteProvider(provider.id);
      await onChanged();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "删除失败");
    }
  };
  const test = async (provider: Provider) => {
    setTesting(provider.id);
    setNotice("");
    try {
      const result = await api.testProvider(provider.id);
      setNotice(`${provider.name} 连接正常 · ${formatMs(result.latency_ms)}`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "连接失败");
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
        <div className="connection-banner">
          <span>{notice}</span>
          <button onClick={() => setNotice("")}>关闭</button>
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
                    <RefreshCw className="spin" size={14} />
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
            <label className="switch-row">
              <span>启用</span>
              <input
                type="checkbox"
                checked={form.active}
                onChange={(event) => update("active", event.target.checked)}
              />
            </label>
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
                <span>
                  {trace.id} · {formatMs(trace.total_latency_ms)}
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
                <span className="eyebrow">{selected.id}</span>
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
            {selected.attempts.length > 0 && (
              <div className="finding-list">
                <h3>路由评分</h3>
                {selected.attempts.map((attempt) => (
                  <div key={`${attempt.agent_id}-${attempt.rank}`}>
                    <span>{attempt.state}</span>
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
            )}
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
                    <p>
                      {Object.entries(event.detail)
                        .map(([key, value]) => `${key}: ${formatDetailValue(value)}`)
                        .join(" · ") || "—"}
                    </p>
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

type GroupConfig = {
  name: string;
  members: string[]; // agent IDs
  hostAgentId?: string | null; // agent ID or null for user host
  backendId?: string; // 平台群聊会话 ID（本地黑板 / 国标 MQ 群组）
  transport?: "local" | "aip-mq";
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  result?: ChatResult;
  streaming?: boolean;
  attachments?: Attachment[];
  feedback?: "positive" | "negative";
  senderAgentId?: string;
  senderName?: string;
  isHost?: boolean;
  createdAt?: number;
};
type QueuedTask = { id: string; text: string; agentId: string; attachments?: Attachment[] };
type Conversation = {
  id: string;
  title: string;
  session?: string;
  agentId?: string;
  messages: ChatMessage[];
  queue?: QueuedTask[];
  isGroup?: boolean;
  groupConfig?: GroupConfig;
};

type ConversationMeta = {
  id: string;
  title: string;
  session?: string;
  agentId?: string;
  messageCount?: number;
  isGroup?: boolean;
  groupMemberCount?: number;
};

function loadConversationIndex(): ConversationMeta[] {
  try {
    const raw = localStorage.getItem("aegismesh-conversations-index");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
    // Migration from old monolithic localStorage blob
    const oldBlob = localStorage.getItem("aegismesh-conversations");
    if (oldBlob) {
      const oldList = JSON.parse(oldBlob);
      if (Array.isArray(oldList)) {
        const index: ConversationMeta[] = [];
        for (const item of oldList) {
          if (item && item.id) {
            try {
              localStorage.setItem(`aegismesh-conv-${item.id}`, JSON.stringify(item));
            } catch {}
            index.push({
              id: item.id,
              title: item.title || "会话",
              session: item.session,
              agentId: item.agentId,
              messageCount: Array.isArray(item.messages) ? item.messages.length : 0,
              isGroup: item.isGroup,
              groupMemberCount: item.groupConfig?.members?.length,
            });
          }
        }
        try {
          localStorage.setItem("aegismesh-conversations-index", JSON.stringify(index));
        } catch {}
        return index;
      }
    }
  } catch {}
  return [];
}

function saveConversationIndex(metas: ConversationMeta[]): void {
  try {
    localStorage.setItem("aegismesh-conversations-index", JSON.stringify(metas));
  } catch {}
}

function loadConversationData(id: string): Conversation | null {
  try {
    const raw = localStorage.getItem(`aegismesh-conv-${id}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
    const oldBlob = localStorage.getItem("aegismesh-conversations");
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
  try {
    localStorage.setItem(`aegismesh-conv-${conv.id}`, JSON.stringify(conv));
  } catch {}
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

function MarkdownText({ text }: { text: string }) {
  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ node, ...props }) => (
            <div className="markdown-table-wrapper">
              <table {...props} />
            </div>
          ),
        }}
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
  tools?: Array<{ name: string; arguments?: any; output_preview?: string }>;
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
        task_id: event.data.task_id,
        agent_id: event.data.agent_id,
        agent_name: event.data.agent_name,
        caller_id: event.data.caller_id,
        call_chain: event.data.call_chain,
        depth: event.data.call_chain ? event.data.call_chain.length - 1 : undefined,
        task: event.data.task,
        status: "running",
        started_at: Date.now(),
        tools: [],
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
      const tools = [
        ...(current.tools || []),
        { name: event.data.tool, arguments: event.data.arguments, output_preview: "" },
      ];
      return {
        ...prev,
        [key]: {
          ...current,
          current_tool: event.data.tool,
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
      if (tools.length > 0) {
        tools[tools.length - 1] = {
          ...tools[tools.length - 1],
          output_preview: event.data.output_preview,
        };
      }
      return {
        ...prev,
        [key]: {
          ...current,
          current_tool: undefined,
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
              <Sparkles size={12} className="spin-slow" />
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
            <div className="collab-tools-list">
              {collab.tools.map((tool, idx) => (
                <div className="collab-tool-item" key={idx}>
                  <div className="collab-tool-head">
                    <span className="tool-chip">
                      {toolNames[tool.name] || tool.name}
                    </span>
                    <code>{tool.name}</code>
                  </div>
                  {tool.arguments && Object.keys(tool.arguments).length > 0 && (
                    <pre className="collab-tool-args">
                      {JSON.stringify(tool.arguments, null, 2)}
                    </pre>
                  )}
                  {tool.output_preview && (
                    <div className="collab-tool-preview">
                      <span>输出摘要：</span>
                      <p>{tool.output_preview}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
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
  const result: SubagentCollaboration[] = [];
  for (const item of list) {
    const existingIdx = result.findIndex((r) => {
      if (item.task_id && r.task_id && item.task_id === r.task_id) return true;
      const rName = (r.agent_name || r.agent_id || "").replace(/(智能体|协同|系统)/g, "").trim();
      const iName = (item.agent_name || item.agent_id || "").replace(/(智能体|协同|系统)/g, "").trim();
      if (rName && iName && (rName === iName || rName.includes(iName) || iName.includes(rName))) {
        const rTask = (r.task || "").trim();
        const iTask = (item.task || "").trim();
        if (
          !rTask || !iTask ||
          rTask === iTask ||
          rTask.includes(iTask) ||
          iTask.includes(rTask) ||
          rTask === "协同任务" || iTask === "协同任务" ||
          rTask === "子任务" || iTask === "子任务"
        ) {
          return true;
        }
      }
      return false;
    });

    if (existingIdx >= 0) {
      const ex = result[existingIdx];
      result[existingIdx] = {
        ...ex,
        ...item,
        task_id: ex.task_id || item.task_id,
        agent_id: ex.agent_id || item.agent_id,
        agent_name: (ex.agent_name && ex.agent_name !== "执行智能体") ? ex.agent_name : item.agent_name,
        task: (ex.task && ex.task !== "子任务" && ex.task !== "协同任务") ? ex.task : item.task,
        status: (item.status === "completed" || item.status === "failed") ? item.status : ex.status,
        result: ex.result || item.result,
        error: ex.error || item.error,
        tools: (ex.tools && ex.tools.length > 0) ? ex.tools : item.tools,
        latency_ms: ex.latency_ms || item.latency_ms,
        started_at: ex.started_at || item.started_at,
        completed_at: ex.completed_at || item.completed_at,
        phase_name: ex.phase_name || item.phase_name,
        token_count: ex.token_count || item.token_count,
        tokens_per_second: ex.tokens_per_second || item.tokens_per_second,
      };
    } else {
      result.push({ ...item });
    }
  }
  return result;
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
      items.push(c);
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
    if (agent && agent !== "执行智能体" && seenAgentKeys.has(agent)) continue;
    if (view.agent && view.agent !== "执行智能体" && seenAgentKeys.has(view.agent)) continue;
    if (seenAgentKeys.has(`${agent}-${task}`) || seenAgentKeys.has(`${view.agent}-${task}`)) {
      continue;
    }

    const alreadyHandled = items.some((it) => {
      if (taskId && it.task_id && it.task_id === taskId) return true;
      const itAgent = it.agent_id || it.agent_name || "";
      const dAgent = agent || view.agent || "";
      if (itAgent && dAgent && itAgent !== "执行智能体" && dAgent !== "执行智能体") {
        if (itAgent === dAgent || itAgent.includes(dAgent) || dAgent.includes(itAgent)) {
          if (!it.task || !task || it.task === task || it.task.includes(task) || task.includes(it.task)) {
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
  inspector,
  messages = [],
  liveSubagents = [],
  liveBlackboardMessages = [],
  toolNames = {},
}: {
  inspector: ChatResult | null;
  messages?: ChatMessage[];
  liveSubagents?: LiveSubagentState[];
  liveBlackboardMessages?: BlackboardMessage[];
  toolNames?: Record<string, string>;
}) {
  const [scope, setScope] = useState<"turn" | "all">("turn");

  const { turnRunning, turnCompleted, allRunning, allCompleted } = useMemo(() => {
    const liveRunning: SubagentCollaboration[] = liveSubagents
      .filter((s) => s.status === "running")
      .map((s) => ({
        task_id: s.task_id,
        agent_id: s.agent_id,
        agent_name: s.agent_name,
        caller_id: s.caller_id,
        call_chain: s.call_chain,
        depth: s.depth,
        task: s.task,
        status: "running" as const,
        tools: s.tools,
        current_tool: s.current_tool,
        started_at: s.started_at,
        phase_name: s.phase_name,
        tokens_per_second: s.tokens_per_second,
        token_count: s.token_count,
      }));

    const liveFinished: SubagentCollaboration[] = liveSubagents
      .filter((s) => s.status === "completed" || s.status === "error")
      .map((s) => ({
        task_id: s.task_id,
        agent_id: s.agent_id,
        agent_name: s.agent_name,
        caller_id: s.caller_id,
        call_chain: s.call_chain,
        depth: s.depth,
        task: s.task,
        status: s.status === "completed" ? ("completed" as const) : ("failed" as const),
        result: s.result,
        error: s.error,
        tools: s.tools,
        latency_ms: s.latency_ms,
        started_at: s.started_at,
        completed_at: s.completed_at,
        phase_name: s.phase_name,
        tokens_per_second: s.tokens_per_second,
        token_count: s.token_count,
      }));

    // 1. Current turn items from inspector
    const turnItems = extractResultCollabs(inspector);
    const turnCompletedItems: SubagentCollaboration[] = [];
    const turnSeen = new Set<string>();

    for (const c of turnItems) {
      const key = c.task_id || `${c.agent_id || c.agent_name}-${c.task}`;
      if (!turnSeen.has(key)) {
        turnSeen.add(key);
        if (c.task_id) turnSeen.add(c.task_id);
        if (c.agent_id && c.task) turnSeen.add(`${c.agent_id}-${c.task}`);
        if (c.agent_name && c.task) turnSeen.add(`${c.agent_name}-${c.task}`);
        if (c.status !== "running") {
          turnCompletedItems.push(c);
        }
      }
    }
    for (const f of liveFinished) {
      const key = f.task_id || `${f.agent_id || f.agent_name}-${f.task}`;
      if (!turnSeen.has(key)) {
        turnSeen.add(key);
        if (f.task_id) turnSeen.add(f.task_id);
        if (f.agent_id && f.task) turnSeen.add(`${f.agent_id}-${f.task}`);
        if (f.agent_name && f.task) turnSeen.add(`${f.agent_name}-${f.task}`);
        turnCompletedItems.push(f);
      }
    }

    // 2. All session items from all messages
    const allCompletedItems: SubagentCollaboration[] = [];
    const allSeen = new Set<string>();

    for (const m of messages) {
      if (m.result) {
        const mCollabs = extractResultCollabs(m.result);
        for (const c of mCollabs) {
          const key = c.task_id || `${c.agent_id || c.agent_name}-${c.task}`;
          if (!allSeen.has(key)) {
            allSeen.add(key);
            if (c.task_id) allSeen.add(c.task_id);
            if (c.agent_id && c.task) allSeen.add(`${c.agent_id}-${c.task}`);
            if (c.agent_name && c.task) allSeen.add(`${c.agent_name}-${c.task}`);
            if (c.status !== "running") {
              allCompletedItems.push(c);
            }
          }
        }
      }
    }
    for (const c of turnCompletedItems) {
      const key = c.task_id || `${c.agent_id || c.agent_name}-${c.task}`;
      if (!allSeen.has(key)) {
        allSeen.add(key);
        if (c.task_id) allSeen.add(c.task_id);
        if (c.agent_id && c.task) allSeen.add(`${c.agent_id}-${c.task}`);
        if (c.agent_name && c.task) allSeen.add(`${c.agent_name}-${c.task}`);
        allCompletedItems.push(c);
      }
    }

    return {
      turnRunning: dedupeCollabList(liveRunning),
      turnCompleted: dedupeCollabList(turnCompletedItems),
      allRunning: dedupeCollabList(liveRunning),
      allCompleted: dedupeCollabList(allCompletedItems),
    };
  }, [inspector, messages, liveSubagents]);

  const allTotal = allRunning.length + allCompleted.length;
  const turnTotal = turnRunning.length + turnCompleted.length;
  const hasMultipleTurns = allTotal > turnTotal && turnTotal > 0;

  const isTurnScope = scope === "turn" && hasMultipleTurns;
  const runningList = isTurnScope ? turnRunning : allRunning;
  const completedList = isTurnScope ? turnCompleted : allCompleted;
  const totalCount = runningList.length + completedList.length;

  // Workflow pipeline ordered list
  // ===== 微信式统一入口列表 =====
  // 联系人：独立派发的智能体（并行分工，发了几个就是几个）
  // 群组：串行工作流（每个任务一个入口）、集群群聊黑板（每次研讨一个入口）
  const [selectedEntry, setSelectedEntry] = useState<ListEntry | null>(null);
  useEffect(() => {
    setSelectedEntry(null);
  }, [inspector]);

  const listEntries = useMemo<ListEntry[]>(() => {
    const results: ChatResult[] = [];
    const seenInv = new Set<string>();
    if (!isTurnScope) {
      for (const m of messages) {
        if (m.result && !seenInv.has(m.result.invocation_id)) {
          seenInv.add(m.result.invocation_id);
          results.push(m.result);
        }
      }
    }
    if (inspector && !seenInv.has(inspector.invocation_id)) {
      seenInv.add(inspector.invocation_id);
      results.push(inspector);
    }

    const entries: ListEntry[] = [];
    const contactSeen = new Set<string>();
    const isGroupInternalTask = (task: string) =>
      task.includes("群聊黑板") || task.includes("【承接前序") || task.includes("【本阶段目标");

    const pushContacts = (collabs: SubagentCollaboration[]) => {
      for (const c of collabs) {
        const taskText = c.task || "";
        if (isGroupInternalTask(taskText)) continue;
        const key = c.task_id || `${c.agent_id}-${c.task}`;
        if (contactSeen.has(key)) continue;
        contactSeen.add(key);
        entries.push({
          kind: "contact",
          key,
          collab: c,
          timeText: formatSubagentTime(
            c.started_at,
            c.completed_at,
            c.latency_ms || (c.elapsed_seconds ? c.elapsed_seconds * 1000 : undefined),
          ),
        });
      }
    };

    for (const res of results) {
      const rd = res.result_data;
      // 集群群组：真实黑板消息
      const bb = rd?.shared_context?.blackboard_messages || [];
      if (bb.length > 0) {
        entries.push({ kind: "swarm", key: `swarm-${res.invocation_id}`, messages: [...bb] });
      }
      // 串行群组：execute_workflow 工具调用
      for (const t of rd?.tool_executions || []) {
        if (t.name !== "execute_workflow") continue;
        const raw = typeof t.output === "string"
          ? (() => { try { return JSON.parse(t.output as string); } catch { return {}; } })()
          : (t.output || {});
        const out = raw as Record<string, any>;
        if (out?.ok && Array.isArray(out.steps) && out.steps.length) {
          entries.push({
            kind: "workflow",
            key: `wf-${res.invocation_id}-${entries.length}`,
            title: String(out.workflow_title || "串行工作流"),
            steps: out.steps as WorkflowStep[],
          });
        }
      }
      pushContacts(dedupeCollabList(extractResultCollabs(res)));
    }
    // 进行中的实时派发（尚无最终结果）
    pushContacts(runningList);
    // 实时群组：正在进行的集群研讨与串行工作流置顶展示
    const discussionLive = (liveBlackboardMessages || []).filter(
      (m) => m.type === "chat" || m.type === "broadcast",
    );
    if (discussionLive.length > 0) {
      let lastSwarmIdx = -1;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i].kind === "swarm") {
          lastSwarmIdx = i;
          break;
        }
      }
      if (lastSwarmIdx >= 0) {
        const lastSwarm = entries[lastSwarmIdx];
        if (lastSwarm.kind === "swarm") {
          const merged = [...lastSwarm.messages];
          for (const m of discussionLive) {
            if (!merged.some((x) => x.id === m.id)) merged.push(m);
          }
          entries[lastSwarmIdx] = { ...lastSwarm, messages: merged };
        }
      } else {
        entries.unshift({
          kind: "swarm",
          key: "swarm-live",
          messages: discussionLive,
          live: true,
        });
      }
    }
    const liveWorkflowTasks = runningList.filter(
      (r) => r.task?.includes("【本阶段目标") || r.task?.includes("【承接前序"),
    );
    if (liveWorkflowTasks.length > 0) {
      entries.unshift({
        kind: "workflow",
        key: `wf-live-${liveWorkflowTasks[0].task_id || liveWorkflowTasks[0].agent_id || "live"}`,
        title: "串行工作流（进行中）",
        steps: liveWorkflowTasks.map((r, i) => ({
          step: i + 1,
          step_title: r.phase_name || r.task?.slice(0, 40) || `阶段 ${i + 1}`,
          agent: r.agent_name || r.agent_id,
          result: r.status === "completed" ? r.result : undefined,
        })),
      });
    }
    return entries;
  }, [inspector, messages, isTurnScope, runningList, liveBlackboardMessages]);

  if (selectedEntry) {
    if (selectedEntry.kind === "workflow") {
      return <WorkflowGroupView entry={selectedEntry} onBack={() => setSelectedEntry(null)} />;
    }
    if (selectedEntry.kind === "swarm") {
      return <SwarmGroupView entry={selectedEntry} onBack={() => setSelectedEntry(null)} />;
    }
    return (
      <SubagentConversationView
        collab={selectedEntry.collab}
        onBack={() => setSelectedEntry(null)}
        toolNames={toolNames}
      />
    );
  }

  if (listEntries.length === 0) {
    return (
      <div className="collab-empty">
        <Bot size={28} className="empty-icon" />
        <p>本次会话暂无子智能体协同记录</p>
        <span>当协调型智能体派发子任务时，将在此展示协同详情与成果回传</span>
      </div>
    );
  }

  return (
    <div className="collab-concise-panel">
      {/* Overview Top Bar */}
      <div className="collab-overview-bar">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span>协同会话 ({listEntries.length})</span>
          {hasMultipleTurns && (
            <div className="collab-scope-switch">
              <button
                type="button"
                className={`collab-scope-btn ${!isTurnScope ? "active" : ""}`}
                onClick={() => setScope("all")}
                title="查看本对话全部轮次派发的子智能体"
              >
                全部会话 ({allTotal})
              </button>
              <button
                type="button"
                className={`collab-scope-btn ${isTurnScope ? "active" : ""}`}
                onClick={() => setScope("turn")}
                title="仅查看当前轮次派发的子智能体"
              >
                当前轮次 ({turnTotal})
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="collab-workflow-container">
        {listEntries.map((entry, idx) => {
          const palette = getSubagentPalette(idx, entry.kind === "contact" ? entry.collab.agent_id || entry.collab.agent_name : entry.key);
          const Icon = palette.icon;
          if (entry.kind === "workflow") {
            const lastStep = entry.steps[entry.steps.length - 1];
            return (
              <button key={entry.key} type="button" className="collab-entry-row" onClick={() => setSelectedEntry(entry)}>
                <div className="collab-concise-icon" style={{ color: palette.color, backgroundColor: palette.bg }}>
                  <GitBranch size={16} />
                </div>
                <div className="collab-entry-main">
                  <div className="collab-entry-top">
                    <strong>{entry.title}</strong>
                    <span className="collab-entry-tag">串行工作流</span>
                  </div>
                  <span className="collab-entry-preview">
                    {entry.steps.length} 棒 · 最新：{lastStep?.agent || "—"} · {lastStep?.step_title || ""}
                  </span>
                </div>
                <ChevronRight size={15} color="var(--muted)" />
              </button>
            );
          }
          if (entry.kind === "swarm") {
            const members = new Set(entry.messages.map((m) => m.nickname || m.sender_name || m.sender_id));
            return (
              <button key={entry.key} type="button" className="collab-entry-row" onClick={() => setSelectedEntry(entry)}>
                <div className="collab-concise-icon" style={{ color: palette.color, backgroundColor: palette.bg }}>
                  <Users size={16} />
                </div>
                <div className="collab-entry-main">
                  <div className="collab-entry-top">
                    <strong>集群群聊黑板</strong>
                    <span className="collab-entry-tag swarm">集群群聊</span>
                  </div>
                  <span className="collab-entry-preview">
                    {entry.messages.length} 条发言 · {members.size} 位成员 · {entry.messages.at(-1)?.content?.slice(0, 30) || ""}
                  </span>
                </div>
                <ChevronRight size={15} color="var(--muted)" />
              </button>
            );
          }
          const c = entry.collab;
          return (
            <button key={entry.key} type="button" className="collab-entry-row" onClick={() => setSelectedEntry(entry)}>
              <div className="collab-concise-icon" style={{ color: palette.color, backgroundColor: palette.bg }}>
                <Icon size={16} />
              </div>
              <div className="collab-entry-main">
                <div className="collab-entry-top">
                  <strong>{c.agent_name || c.agent_id}</strong>
                  {c.status === "running" ? (
                    <span className="collab-live-tag"><span className="pulse" />进行中</span>
                  ) : (
                    <span className="collab-entry-time">{entry.timeText}</span>
                  )}
                </div>
                <span className="collab-entry-preview">{c.task}</span>
              </div>
              <ChevronRight size={15} color="var(--muted)" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GroupChatModal({
  isOpen,
  mode,
  targetConv,
  agents,
  onClose,
  onSubmit,
}: {
  isOpen: boolean;
  mode: "create" | "edit";
  targetConv?: Conversation | null;
  agents: Agent[];
  onClose: () => void;
  onSubmit: (config: GroupConfig) => void;
}) {
  const [name, setName] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (mode === "edit" && targetConv?.groupConfig) {
      setName(targetConv.groupConfig.name || targetConv.title || "智能体协作讨论群");
      setSelectedIds(targetConv.groupConfig.members || []);
      setHostId(targetConv.groupConfig.hostAgentId ?? null);
    } else {
      setName("智能体协作讨论群");
      const defaultAgents = agents.filter((a) => a.active).slice(0, 3).map((a) => a.id);
      setSelectedIds(defaultAgents);
      const leader = agents.find((a) => a.role === "leader" && a.active);
      setHostId(leader ? leader.id : null);
    }
  }, [isOpen, mode, targetConv, agents]);

  if (!isOpen) return null;

  const activeAgents = agents.filter((a) => a.active);
  const filteredAgents = activeAgents.filter((a) =>
    `${a.name} ${a.id} ${a.description || ""}`.toLowerCase().includes(search.toLowerCase()),
  );

  const toggleAgent = (id: string) => {
    setSelectedIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      if (hostId === id && !next.includes(id)) {
        setHostId(null);
      }
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
      hostAgentId: hostId,
    });
  };

  return (
    <div className="group-modal-overlay" onClick={onClose}>
      <div className="group-modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="group-modal-header">
          <div className="modal-header-left">
            <Users size={16} />
            <h3>{mode === "create" ? "新建群聊" : "群成员管理"}</h3>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="关闭">
            <X size={15} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="group-modal-form">
          <div className="form-group">
            <label>群聊名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入群聊名称..."
              required
            />
          </div>

          <div className="form-group">
            <div className="form-group-label-row">
              <label>选择群成员 ({selectedIds.length})</label>
              <div className="quick-select-links">
                <button
                  type="button"
                  onClick={() => setSelectedIds(activeAgents.map((a) => a.id))}
                >
                  全选
                </button>
                <span>·</span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedIds([]);
                    setHostId(null);
                  }}
                >
                  清空
                </button>
              </div>
            </div>
            <div className="group-agent-search">
              <Search size={14} />
              <input
                type="text"
                placeholder="搜索智能体..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="group-agent-picker-list">
              {filteredAgents.map((agent) => {
                const checked = selectedIds.includes(agent.id);
                return (
                  <div
                    key={agent.id}
                    className={`group-agent-picker-item ${checked ? "selected" : ""}`}
                    onClick={() => toggleAgent(agent.id)}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {}}
                    />
                    <div className="agent-info">
                      <div className="agent-title-row">
                        <strong>{agent.name}</strong>
                        <span className={`role-pill ${agent.role}`}>
                          {agent.role === "leader" ? "协调型" : "执行型"}
                        </span>
                        {hostId === agent.id && <span className="host-pill">主持</span>}
                      </div>
                      <p className="agent-desc">{agent.description || "专业领域智能体"}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="form-group">
            <label>指定主持人</label>
            <select
              value={hostId || ""}
              onChange={(e) => setHostId(e.target.value ? e.target.value : null)}
              className="select-host-control"
            >
              <option value="">自己主持</option>
              {selectedIds.map((id) => {
                const a = agents.find((ag) => ag.id === id);
                return (
                  <option key={id} value={id}>
                    {a ? a.name : id} (主持)
                  </option>
                );
              })}
            </select>
          </div>

          <div className="group-modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={selectedIds.length === 0 || !name.trim()}
            >
              {mode === "create" ? "创建群聊" : "保存修改"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ChatDemo({ onComplete }: { onComplete: () => Promise<void> }) {
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
  const [pendingAgentSwitch, setPendingAgentSwitch] = useState<{
    targetId: string;
    targetName: string;
  } | null>(null);
  const [liveSubagents, setLiveSubagents] = useState<Record<string, LiveSubagentState>>({});
  const [liveBlackboardMessages, setLiveBlackboardMessages] = useState<BlackboardMessage[]>([]);
  const [session, setSession] = useState<string | undefined>(initialActive?.session || activeMeta?.session);
  const sessionRef = useRef(session);
  const [inspector, setInspector] = useState<ChatResult | null>(
    latestResult(initialActive?.messages || []),
  );
  const [detail, setDetail] = useState<"route" | "collaboration" | "members">(
    "route",
  );
  const [content, setContent] = useState<"chat" | "api">("chat");
  const [queue, setQueueState] = useState<QueuedTask[]>(initialActive?.queue || []);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [settings, setSettings] = useState<UserSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newChatDropdownOpen, setNewChatDropdownOpen] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupModalMode, setGroupModalMode] = useState<"create" | "edit">("create");
  const [groupModalTargetId, setGroupModalTargetId] = useState<string | null>(null);

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
      session,
      agentId,
      messages,
      queue,
      isGroup: existing?.isGroup,
      groupConfig: existing?.groupConfig,
    };
    saveConversationData(conversation);
    setConversations((items) => {
      const meta: ConversationMeta = {
        id: activeId,
        title,
        session,
        agentId,
        messageCount: messages.length,
        isGroup: existing?.isGroup,
        groupMemberCount: existing?.groupConfig?.members?.length,
      };
      const next = [meta, ...items.filter((item) => item.id !== activeId)].slice(0, 50);
      saveConversationIndex(next);
      return next;
    });
  }, [activeId, messages, session, agentId, queue]);

  useEffect(() => {
    api
      .agents()
      .then((list) => {
        const selectable = list.filter(
          (agent) =>
            agent.active &&
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
          const leader =
            selectable.find((a) => a.role === "leader") || selectable[0];
          return leader ? leader.id : "";
        });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const thread = document.querySelector<HTMLElement>(".chat-thread");
      if (!thread) return;
      thread.scrollTo({
        top: thread.scrollHeight,
        behavior: messages.at(-1)?.streaming ? "auto" : "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, sending]);

  const openConversation = (target: ConversationMeta) => {
    setActiveId(target.id);
    const data = loadConversationData(target.id);
    const msgs = (data?.messages || []).map((m) =>
      m.streaming ? { ...m, streaming: false, text: m.text || "（任务已中断）" } : m,
    );
    setMessages(msgs);
    setShowAllMessages(false);
    setSession(data?.session || target.session);
    sessionRef.current = data?.session || target.session;
    setAgentId(
      data?.agentId ||
        target.agentId ||
        agents.find((a) => a.role === "leader")?.id ||
        agents[0]?.id ||
        "",
    );
    setInspector(latestResult(msgs));
    setQueue(data?.queue || []);
    setContent("chat");
    setMobileHistoryOpen(false);
  };
  const createConversation = (targetAgentId?: string) => {
    const newId = crypto.randomUUID();
    setActiveId(newId);
    setMessages([]);
    setShowAllMessages(false);
    setSession(undefined);
    sessionRef.current = undefined;
    if (targetAgentId) {
      setAgentId(targetAgentId);
    } else {
      const leader = agents.find((a) => a.role === "leader") || agents[0];
      if (leader) setAgentId(leader.id);
    }
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
      title: config.name || "智能体协作讨论群",
      isGroup: true,
      groupMemberCount: config.members.length,
    };

    const newConv: Conversation = {
      id: newId,
      title: config.name || "智能体群聊",
      messages: [],
      isGroup: true,
      groupConfig: config,
    };
    saveConversationData(newConv);
    const nextMetas = [newMeta, ...conversations.filter((c) => c.id !== newId)];
    setConversations(nextMetas);
    saveConversationIndex(nextMetas);
    setActiveId(newId);
    setMessages([]);
    setShowAllMessages(false);
    setSession(undefined);
    sessionRef.current = undefined;
    setAgentId(config.hostAgentId || config.members[0] || "");
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
  const deleteConversation = (id: string) => {
    try {
      localStorage.removeItem(`aegismesh-conv-${id}`);
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
          setMessages((items) =>
            items.some((m) => m.streaming)
              ? items.map((m) =>
                  m.streaming ? { ...m, streaming: false, text: m.text || "（任务已中断）" } : m,
                )
              : items,
          );
          return;
        }
        const task = res.task;
        if (task.status === "running") {
          currentTaskIdRef.current = task.task_id;
          abortControllerRef.current = new AbortController();
          stopRequestedRef.current = false;
          sendingRef.current = true;
          setSending(true);
          setSendingSince(task.created_at ? task.created_at * 1000 : Date.now());
          let receivedDelta = false;
          try {
            const result = await api.reconnectTaskStream(
              task.task_id,
              (delta) => {
                receivedDelta = true;
                setMessages((items) => {
                  const last = items.at(-1);
                  if (last?.role === "assistant" && last.streaming) {
                    return [
                      ...items.slice(0, -1),
                      { ...last, text: last.text + delta },
                    ];
                  }
                  return [
                    ...items,
                    { role: "assistant", text: delta, streaming: true },
                  ];
                });
              },
              (event) => {
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
            setInspector(result);
            setMessages((items) => {
              const last = items.at(-1);
              if (receivedDelta && last?.role === "assistant" && last.streaming) {
                return [
                  ...items.slice(0, -1),
                  { role: "assistant", text: result.answer, result },
                ];
              }
              return [...items, { role: "assistant", text: result.answer, result }];
            });
            await onComplete();
          } catch (err) {
            if (
              stopRequestedRef.current ||
              (err instanceof DOMException && err.name === "AbortError") ||
              (err instanceof Error && err.name === "AbortError") ||
              (err instanceof Error && err.message.includes("任务已被用户取消"))
            ) {
              setMessages((items) => {
                const last = items.at(-1);
                if (last?.role === "assistant" && last.streaming) {
                  return [
                    ...items.slice(0, -1),
                    { role: "assistant", text: `${last.text}\n\n[任务已被用户主动终止]` },
                  ];
                }
                return [...items, { role: "assistant", text: "[任务已被用户主动终止]" }];
              });
              return;
            }
            console.error("恢复任务流失败:", err);
          } finally {
            sendingRef.current = false;
            setSending(false);
            setSendingSince(null);
            setLiveSubagents({});
            setLiveBlackboardMessages([]);
            abortControllerRef.current = null;
            currentTaskIdRef.current = null;
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session]);

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
    } else if (groupCfg.hostAgentId) {
      firstSpeakerId = groupCfg.hostAgentId;
    } else {
      firstSpeakerId = agentId || groupCfg.members[0];
    }

    // 平台群聊通道：本地黑板 / 国标 MQ 群组（提示词与历史由服务端统一组装）
    if (groupCfg.backendId) {
      let chainTarget = firstSpeakerId;
      let chainText = userText;
      for (let round = 0; round < 2 && chainTarget; round += 1) {
        const speakerAgent = agents.find((a) => a.id === chainTarget);
        try {
          const res = await api.sendGroupChatMessage(
            groupCfg.backendId,
            chainText,
            chainTarget,
          );
          if (!res.reply) {
            setMessages((items) => [
              ...items,
              {
                role: "assistant",
                text: res.error ? `⚠️ ${res.error}` : "（本次没有智能体发言）",
                senderName: speakerAgent?.name || chainTarget,
                createdAt: Date.now(),
              },
            ]);
            break;
          }
          setMessages((items) => [
            ...items,
            {
              role: "assistant",
              text: res.reply || "",
              senderAgentId: res.agent_id || chainTarget,
              senderName: res.agent_name || speakerAgent?.name || chainTarget,
              createdAt: Date.now(),
            },
          ]);
          await onComplete();
          const nextTarget = groupCfg.members.find((mId) => {
            if (mId === res.agent_id) return false;
            const a = agents.find((ag) => ag.id === mId);
            return a && res.reply && (res.reply.includes(`@${a.name}`) || res.reply.includes(`@${a.id}`));
          });
          if (!nextTarget) break;
          chainTarget = nextTarget;
          chainText = `群内继续讨论：上一条发言 @了你，请接着回应（原话：${res.reply.slice(0, 200)}）`;
        } catch (reason) {
          setMessages((items) => [
            ...items,
            {
              role: "assistant",
              text: `⚠️ [${speakerAgent?.name || chainTarget}] 发言失败：${reason instanceof Error ? reason.message : "群聊服务异常"}`,
              senderName: speakerAgent?.name || chainTarget,
              createdAt: Date.now(),
            },
          ]);
          break;
        }
      }
      sendingRef.current = false;
      setSending(false);
      setSendingSince(null);
      return;
    }

    const executeSpeaker = async (
      targetId: string,
      currentMsgs: ChatMessage[],
      chainRound: number,
    ): Promise<void> => {
      const speakerAgent = agents.find((a) => a.id === targetId);
      const isHost = targetId === groupCfg.hostAgentId;

      const membersListStr = groupCfg.members
        .map((mId) => {
          const a = agents.find((ag) => ag.id === mId);
          return `- ${a?.name || mId}（ID: ${mId}，专长: ${a?.description || "领域专家"}）`;
        })
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

      const otherMembers = groupCfg.members
        .filter((mId) => mId !== targetId)
        .map((mId) => agents.find((ag) => ag.id === mId)?.name || mId);
      const sampleOther = otherMembers[0] || "其他专家";

      const groupPrompt = `【AIP 国标规范·智能体多方协作群聊】
你正在参与群聊「${groupCfg.name}」。
你的身份：${speakerAgent?.name || targetId}（角色：${isHost ? "本群主持人" : "受邀群成员"}）。
群内所有智能体成员：
${membersListStr}

【群聊规则与格式】：
1. 这是一个开放、平等的专业群聊，你正在直接公开发言。
2. 你的发言必须言简意赅、切中要害。直接给出公开回复，绝对不要包含内部思考草稿（如 <think>）。
3. 如果你需要让群内某位专家处理具体任务或回答问题，请在发言中明确使用「@专家名称」（例如：@${sampleOther} 请...）。系统将自动触发该专家在群内继续响应。
4. ${
        isHost
          ? "作为主持人，你负责统筹协调。你可以直接解答用户疑问，也可以将任务拆解后艾特对应专家协同，或发消息面向全群总结。"
          : "作为受邀专家，请针对艾特你的问题或主持人的委派，给出专业解答。"
      }

【群聊历史公开记录】：
${cleanHistory}

请作为「${speakerAgent?.name || targetId}」在群聊中发表你的公开回复：`;

      let receivedDelta = false;
      const abortCtrl = new AbortController();
      abortControllerRef.current = abortCtrl;
      currentTaskIdRef.current = null;
      stopRequestedRef.current = false;

      try {
        const result = await api.chatStream(
          groupPrompt,
          sessionRef.current,
          targetId,
          (delta) => {
            receivedDelta = true;
            setMessages((items) => {
              const last = items.at(-1);
              if (last?.role === "assistant" && last.streaming && last.senderAgentId === targetId) {
                return [
                  ...items.slice(0, -1),
                  { ...last, text: last.text + delta },
                ];
              }
              return [
                ...items,
                {
                  role: "assistant",
                  text: delta,
                  streaming: true,
                  senderAgentId: targetId,
                  senderName: speakerAgent?.name || targetId,
                  isHost,
                  createdAt: Date.now(),
                },
              ];
            });
          },
          () => {},
          abortCtrl.signal,
          (taskId) => {
            currentTaskIdRef.current = taskId;
          },
          messageAttachments,
        );

        setSession(result.session_id);
        sessionRef.current = result.session_id;

        let finalAnswer = result.answer;
        finalAnswer = finalAnswer.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

        const assistantMsg: ChatMessage = {
          role: "assistant",
          text: finalAnswer,
          result,
          senderAgentId: targetId,
          senderName: speakerAgent?.name || targetId,
          isHost,
          createdAt: Date.now(),
        };

        setMessages((items) => {
          const last = items.at(-1);
          if (receivedDelta && last?.role === "assistant" && last.streaming) {
            return [...items.slice(0, -1), assistantMsg];
          }
          return [...items, assistantMsg];
        });

        await onComplete();

        if (chainRound < 2 && !stopRequestedRef.current) {
          const nextTargetId = groupCfg.members.find((mId) => {
            if (mId === targetId) return false;
            const a = agents.find((ag) => ag.id === mId);
            return a && (finalAnswer.includes(`@${a.name}`) || finalAnswer.includes(`@${a.id}`));
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
          setMessages((items) => {
            const last = items.at(-1);
            if (last?.role === "assistant" && last.streaming) {
              return [
                ...items.slice(0, -1),
                { ...last, text: `${last.text}\n\n[发言已由用户终止]` },
              ];
            }
            return [...items, { role: "assistant", text: "[发言已由用户终止]" }];
          });
          return;
        }
        const errorMsg = reason instanceof Error ? reason.message : "智能体发言失败";
        setMessages((items) => [
          ...items,
          {
            role: "assistant",
            text: `⚠️ [${speakerAgent?.name || targetId}] 发言遇到异常: ${errorMsg}`,
            senderName: speakerAgent?.name || targetId,
            isHost,
          },
        ]);
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
    setMessages((items) => [
      ...items,
      { role: "user", text: message, attachments: messageAttachments },
    ]);
    let receivedDelta = false;
    const abortCtrl = new AbortController();
    abortControllerRef.current = abortCtrl;
    currentTaskIdRef.current = null;
    stopRequestedRef.current = false;

    try {
      const result = await api.chatStream(
        message,
        sessionRef.current,
        taskAgentId,
        (delta) => {
          receivedDelta = true;
          setMessages((items) => {
            const last = items.at(-1);
            if (last?.role === "assistant" && last.streaming) {
              return [
                ...items.slice(0, -1),
                { ...last, text: last.text + delta },
              ];
            }
            return [
              ...items,
              { role: "assistant", text: delta, streaming: true },
            ];
          });
        },
        (event) => {
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
        abortCtrl.signal,
        (taskId) => {
          currentTaskIdRef.current = taskId;
        },
        messageAttachments,
      );
      setSession(result.session_id);
      sessionRef.current = result.session_id;
      setInspector(result);
      setMessages((items) => {
        const last = items.at(-1);
        if (receivedDelta && last?.role === "assistant" && last.streaming) {
          return [
            ...items.slice(0, -1),
            { role: "assistant", text: result.answer, result },
          ];
        }
        return [...items, { role: "assistant", text: result.answer, result }];
      });
      await onComplete();
    } catch (reason) {
      if (
        stopRequestedRef.current ||
        (reason instanceof DOMException && reason.name === "AbortError") ||
        (reason instanceof Error && reason.name === "AbortError") ||
        (reason instanceof Error && reason.message.includes("任务已被用户取消"))
      ) {
        setMessages((items) => {
          const last = items.at(-1);
          if (last?.role === "assistant" && last.streaming) {
            return [
              ...items.slice(0, -1),
              { role: "assistant", text: `${last.text}\n\n[任务已被用户主动终止]` },
            ];
          }
          return [...items, { role: "assistant", text: "[任务已被用户主动终止]" }];
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
      setMessages((items) => {
        const last = items.at(-1);
        if (last?.role === "assistant" && last.streaming) {
          return [
            ...items.slice(0, -1),
            { role: "assistant", text: `${last.text}\n\n${error}` },
          ];
        }
        return [...items, { role: "assistant", text: error }];
      });
    } finally {
      sendingRef.current = false;
      setSending(false);
      setSendingSince(null);
      setLiveSubagents({});
      setLiveBlackboardMessages([]);
      abortControllerRef.current = null;
      currentTaskIdRef.current = null;
      const shouldRunNext = !stopQueueRef.current;
      stopRequestedRef.current = false;
      stopQueueRef.current = false;
      if (shouldRunNext) {
        const next = queueRef.current[0];
        if (next) {
          setQueue(queueRef.current.slice(1));
void runMessage(next.text, next.agentId, next.attachments);
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
        },
      ]);
      return;
    }
    void runMessage(finalMsg, agentId, currentAttachments);
  };

  const groupConfig = activeMeta?.isGroup ? loadConversationData(activeId)?.groupConfig : null;
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

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      setMentionMenuOpen(false);
      submit();
    }
  };
  const suggestions = [
    "针对大模型多智能体协作，撰写系统性文献综述并分析研究空白",
    "推导自适应多智能体通信博弈模型，给出数学公式与命题假说",
    "设计一项因果推断实证实验方案，设定计量回归模型与稳健性检验",
    "对我的论文方法论与实验设计出具同行评审意见（Peer Review）",
    "核验 BibTeX 参考文献引注规范，并进行学术原创性查重初筛",
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
      metas.forEach((m) => localStorage.removeItem(`aegismesh-conv-${m.id}`));
      localStorage.removeItem("aegismesh-conversations-index");
      localStorage.removeItem("aegismesh-conversations");
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
      className={`chat-layout ${historyCollapsed ? "history-collapsed" : ""} ${inspectorCollapsed ? "inspector-collapsed" : ""} ${mobileHistoryOpen ? "mobile-history-open" : ""} ${mobileInspectorOpen ? "mobile-inspector-open" : ""}`}
    >
      {(mobileHistoryOpen || mobileInspectorOpen) && (
        <button
          className="chat-drawer-backdrop"
          onClick={() => {
            setMobileHistoryOpen(false);
            setMobileInspectorOpen(false);
          }}
          aria-label="关闭抽屉"
        />
      )}
      {historyCollapsed && (
        <button
          className="chat-side-toggle left"
          onClick={() => setHistoryCollapsed(false)}
          title="展开会话"
          aria-label="展开会话"
        >
          <PanelLeftOpen size={16} />
        </button>
      )}
      {inspectorCollapsed && (
        <button
          type="button"
          className="chat-side-toggle right inspector-collapsed-toggle"
          onClick={() => setInspectorCollapsed(false)}
          title="展开详情"
          aria-label="展开详情"
        >
          <PanelRightOpen size={16} />
        </button>
      )}
      <aside className="history-sidebar">
        <div className="chat-brand">
          <span>
            <Network size={17} />
          </span>
          <strong>AegisMesh</strong>
          <button
            className="history-collapse-btn"
            onClick={() => setHistoryCollapsed(true)}
            title="折叠会话"
            aria-label="折叠会话"
          >
            <PanelLeftClose size={16} />
          </button>
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
            </div>
          )}
        </div>
        <nav>
          {conversations.map((conversation) => (
            <div
              className={`history-item ${conversation.id === activeId ? "active" : ""} ${conversation.isGroup ? "is-group" : ""}`}
              key={conversation.id}
            >
              <button onClick={() => openConversation(conversation)}>
                {conversation.isGroup ? (
                  <Users size={14} className="group-item-icon" />
                ) : (
                  <MessageSquareText size={14} />
                )}
                <span>{conversation.title}</span>
                {conversation.isGroup && (
                  <span className="group-count-badge">
                    {conversation.groupMemberCount || 0}人
                  </span>
                )}
              </button>
              <div className="history-actions-col">
                {conversation.isGroup && (
                  <button
                    type="button"
                    className="edit-chat"
                    onClick={(e) => {
                      e.stopPropagation();
                      setGroupModalMode("edit");
                      setGroupModalTargetId(conversation.id);
                      setGroupModalOpen(true);
                    }}
                    title="设置"
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
        <button
          className="api-entry"
          onClick={() => {
            setSettingsOpen(true);
            setMobileHistoryOpen(false);
          }}
        >
          <Settings2 size={15} />
          用户设置
        </button>
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
              <button
                className={`mobile-header-btn ${inspector ? "active" : ""}`}
                onClick={() => setMobileInspectorOpen((val) => !val)}
                aria-label="查看路由详情"
                title="路由详情"
              >
                <SlidersHorizontal size={17} />
                {inspector && <span className="mobile-btn-dot" />}
              </button>
            </div>
          </header>
          <div className="chat-thread">
            {messages.length === 0 ? (
              <div className="chat-hero">
                <div className="hero-mark">
                  <Sparkles size={24} />
                </div>
                <h2>今天要完成什么？</h2>
                <div className="prompt-grid">
                  {suggestions.map((suggestion, index) => (
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
                            <span className="pulse" />
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
                      <MarkdownText text={message.text} />
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
            {sending && !messages.some((m) => m.streaming) && (
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
                      <span className="pulse" />
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
                </div>
              </div>
            )}
          </div>
          {queue.length > 0 && (
            <div className={`queue-dock ${queueExpanded ? "expanded" : "compact"}`}>
              <div className="queue-dock-header">
                <button
                  type="button"
                  className="queue-header-toggle"
                  onClick={() => setQueueExpanded((value) => !value)}
                  aria-expanded={queueExpanded}
                  title={queueExpanded ? "收起发送队列" : "展开发送队列"}
                >
                  <span className="queue-header-left">
                    <strong>发送队列</strong>
                    <span className="queue-count-badge">{queue.length}</span>
                  </span>
                  {!queueExpanded && (
                    <span className="queue-preview-text">{queue[0]?.text}</span>
                  )}
                  {queueExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                </button>
                <button
                  type="button"
                  className="queue-clear-btn"
                  onClick={() => setQueue([])}
                  title="清空队列"
                >
                  <Trash2 size={12} />
                  <span>清空队列</span>
                </button>
              </div>
              {(queueExpanded ? queue : queue.slice(0, 1)).map((item, index) => (
                <div className="queue-item" key={item.id}>
                  <span>{index + 1}</span>
                  <p>{item.text}</p>
                  <button
                    type="button"
                    onClick={() =>
                      setQueue((items) =>
                        items.filter((entry) => entry.id !== item.id),
                      )
                    }
                    title="移除此项"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <form
            className="composer"
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
            <textarea
              ref={composerTextareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleInputKeyDown}
              placeholder={
                activeMeta?.isGroup
                  ? `给 ${loadConversationData(activeId)?.groupConfig?.name || "群聊"} 发消息`
                  : sending
                    ? "继续输入，消息将加入队列"
                    : attachments.length > 0
                      ? "输入对已上传材料的研讨或分析指令（可直接回车发送）..."
                      : "请输入问题"
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
                  {uploading ? <Loader2 size={14} className="spin" /> : <Paperclip size={14} />}
                  <span>{uploading ? "解析中..." : "上传材料"}</span>
                </button>
                {!activeMeta?.isGroup && (
                  <Dropdown
                    className="runtime-mode"
                    value={agentId}
                    onChange={handleAgentSelect}
                    placeholder={agents.length === 0 ? "暂无可用智能体" : "请选择智能体"}
                    options={agents.map((agent) => ({
                      value: agent.id,
                      label: `${agent.name} · ${agent.role === "leader" ? "协调型" : "执行型"}`,
                    }))}
                  />
                )}
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
      <aside className="route-inspector">
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
          <div className={`detail-tabs ${activeMeta?.isGroup ? "detail-tabs-3" : "detail-tabs-2"}`}>
            {activeMeta?.isGroup && (
              <button
                className={detail === "members" ? "active" : ""}
                onClick={() => setDetail("members")}
              >
                成员
              </button>
            )}
            <button
              className={detail === "route" ? "active" : ""}
              onClick={() => setDetail("route")}
            >
              路由
            </button>
            <button
              className={detail === "collaboration" ? "active" : ""}
              onClick={() => setDetail("collaboration")}
            >
              协作
            </button>
          </div>
          <button
            type="button"
            className="inspector-toggle-btn"
            onClick={() => setInspectorCollapsed(true)}
            title="折叠详情"
            aria-label="折叠详情"
          >
            <PanelRightClose size={16} />
          </button>
        </div>
        {activeMeta?.isGroup && detail === "members" && (
          <div className="group-members-panel">
            <div className="members-panel-title">
              <span>成员 ({loadConversationData(activeId)?.groupConfig?.members.length || 0})</span>
              <button
                type="button"
                className="members-panel-manage-btn"
                onClick={() => {
                  setGroupModalMode("edit");
                  setGroupModalTargetId(activeId);
                  setGroupModalOpen(true);
                }}
              >
                管理
              </button>
            </div>
            <div className="members-panel-list">
              {loadConversationData(activeId)?.groupConfig?.members.map((mId) => {
                const a = agents.find((ag) => ag.id === mId);
                const isHost = mId === loadConversationData(activeId)?.groupConfig?.hostAgentId;
                return (
                  <div key={mId} className="member-panel-card">
                    <div className="member-avatar">
                      <Bot size={15} />
                    </div>
                    <div className="member-meta">
                      <div className="member-name-row">
                        <strong>{a?.name || mId}</strong>
                        {isHost && <span className="member-host-badge">主持</span>}
                      </div>
                      <span className="member-role-desc">
                        {a?.role === "leader" ? "协调型" : "执行型"}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="member-mention-btn"
                      onClick={() => {
                        const name = a?.name || mId;
                        const mentionText = `@${name} `;
                        setInput((prev) => (prev.includes(mentionText) ? prev : `${mentionText}${prev}`));
                        composerTextareaRef.current?.focus();
                      }}
                      title="点击在输入框 @TA"
                    >
                      @
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {inspector && detail === "route" && (
          <>
            <div className="selected-route">
              <span>已选择</span>
              <strong>{inspector.selected_agent?.name || "—"}</strong>
            </div>
            <div className="candidate-scores">
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
                  {candidate.eligible && (
                    <p className="muted">
                      {Object.entries(candidate.breakdown)
                        .map(([key, value]) => `${metricLabels[key] || key} ${value}`)
                        .join(" · ")}
                    </p>
                  )}
                  {candidate.reasons.length > 0 && (
                    <p className="muted">{candidate.reasons.join(" · ")}</p>
                  )}
                </div>
              ))}
            </div>
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
          </>
        )}
        {detail === "collaboration" && (
          <CollaborationPanel
            inspector={inspector}
            messages={messages}
            liveSubagents={Object.values(liveSubagents)}
            liveBlackboardMessages={liveBlackboardMessages}
            toolNames={toolNames}
          />
        )}
        {detail === "route" && !inspector && (
          <div className="inspector-empty">
            {sending ? "正在评估路由与可用智能体..." : "等待运行记录"}
          </div>
        )}
      </aside>
      {settingsOpen && (
        <SettingsDrawer
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
      <GroupChatModal
        isOpen={groupModalOpen}
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
              在右侧查看协同详情 ({action.totalCollabs} 个记录){" "}
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
              在右侧查看协同详情 <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsDrawer({
  settings,
  onChange,
  onClose,
  onClear,
}: {
  settings: UserSettings;
  onChange: (patch: Partial<UserSettings>) => void;
  onClose: () => void;
  onClear: () => void;
}) {
  return (
    <div className="drawer-layer">
      <button className="drawer-backdrop" onClick={onClose} />
      <aside className="builder-drawer settings-drawer">
        <div className="drawer-header">
          <h2>用户设置</h2>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">
          <div className="settings-section">
            <h3>外观</h3>
            <label className="settings-row">
              <span>主题</span>
              <Dropdown
                value={settings.theme}
                onChange={(value) => onChange({ theme: value as ThemeChoice })}
                options={[
                  { value: "system", label: "跟随系统" },
                  { value: "light", label: "浅色" },
                  { value: "dark", label: "深色" },
                ]}
              />
            </label>
          </div>
          <div className="settings-section">
            <h3>上下文与压缩阈值</h3>
            <label className="settings-row">
              <span>上下文窗口</span>
              <Dropdown
                value={String(settings.contextWindow)}
                onChange={(value) => onChange({ contextWindow: Number(value) })}
                options={CONTEXT_WINDOWS}
              />
            </label>
            <label className="settings-row">
              <span>压缩阈值</span>
              <Dropdown
                value={settings.compressionStrategy || "auto"}
                onChange={(value) =>
                  onChange({
                    compressionStrategy: value as CompressionStrategy,
                    autoCompress: value !== "off",
                  })
                }
                options={COMPRESSION_STRATEGIES}
              />
            </label>
            <label className="settings-row">
              <span>保留最近轮次</span>
              <Dropdown
                value={String(settings.keepRecentTurns ?? 4)}
                onChange={(value) =>
                  onChange({ keepRecentTurns: Number(value) })
                }
                options={[
                  { value: "0", label: "不限制" },
                  { value: "2", label: "2 轮" },
                  { value: "4", label: "4 轮" },
                  { value: "8", label: "8 轮" },
                ]}
              />
            </label>
            <Switch
              label="显示上下文圆环指示器"
              checked={settings.showContextMeter}
              onChange={(value) => onChange({ showContextMeter: value })}
            />
          </div>
          <div className="settings-section">
            <h3>会话</h3>
            <button className="secondary-button danger" onClick={onClear}>
              清空本地会话记录
            </button>
          </div>
        </div>
        <div className="drawer-footer">
          <span className="settings-note">AegisMesh · ACPs/AIP v2.2.0</span>
        </div>
      </aside>
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
        <div key={index} />
      ))}
    </div>
  );
}

export default App;
