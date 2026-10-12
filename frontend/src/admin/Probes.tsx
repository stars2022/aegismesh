import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Check, ChevronRight, Network, ScanSearch, X } from "lucide-react";
import { api } from "../api";
import { EmptyState, ScoreBar, StatusDot } from "../components";
import type { Agent, ProbeResult } from "../types";
import { stateNames, transportNames } from "./labels";

export function Probes({
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
