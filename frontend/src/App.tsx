import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Bot,
  CirclePlus,
  Gauge,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  Play,
  RefreshCw,
  ScanSearch,
  Route,
  ServerCog,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";
import { api } from "./api";
import { FlowMark } from "./LoadingFlow";
import { StatusDot } from "./components";
import { SidebarToggle } from "./SidebarToggle";
import { AccountAdministration, QuotaAdministration } from "./AccountAdministration";
import type { Agent, DashboardData, Policy, ProbeResult, Provider, Trace } from "./types";
import { LogCenter } from "./LogCenter";
import { ErrorBoundary } from "./ErrorBoundary";
import { AccessControl } from "./admin/AccessControl";
import { Overview } from "./admin/Overview";
import { Probes } from "./admin/Probes";
import { Providers } from "./admin/Providers";
import { Routing } from "./admin/Routing";
import { Studio } from "./admin/Studio";
import { Traces } from "./admin/Traces";
import type { View } from "./admin/labels";

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
            <a className="primary-small is-quiet" href="/" aria-label="打开聊天" title="打开聊天">
              <Play size={15} />
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
          <ErrorBoundary key={view} label={navigation.find((item) => item.id === view)?.label || "当前页面"}>
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
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}

export default App;
