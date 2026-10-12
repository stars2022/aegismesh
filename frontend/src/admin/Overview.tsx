import { Activity, ArrowRight, ChartNoAxesCombined } from "lucide-react";
import { EmptyState, MetricCard, ScoreBar, StatusDot } from "../components";
import type { Agent, DashboardData, Trace } from "../types";
import { stateNames, type View } from "./labels";
import { formatMs } from "../format";

export function Overview({
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

function PageSkeleton() {
  return (
    <div className="skeleton-grid">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flow-sweep" />
      ))}
    </div>
  );
}
