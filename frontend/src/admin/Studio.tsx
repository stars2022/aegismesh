import { useEffect, useRef, useState } from "react";
import {
  Braces,
  Check,
  CirclePlus,
  Copy,
  Eye,
  Pin,
  Radio,
  Download,
  Globe,
  RefreshCw,
  ScanSearch,
  Search,
  Shield,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import { alertDialog, confirmDialog } from "../dialog";
import { FlowMark, LoadingFlow } from "../LoadingFlow";
import { EmptyState, StatusDot, Switch } from "../components";
import type { Agent, Provider } from "../types";
import { AgentBuilder } from "./AgentBuilder";
import { AgentDesigner, type AgentDraft } from "./AgentDesigner";
import { NewAgentMenu, type CreationMode, type CreationRequest } from "./NewAgentMenu";
import { formatMs } from "../format";

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

export function Studio({
  agents,
  providers,
  onChanged,
  creationRequest,
  onCreationHandled,
}: {
  agents: Agent[];
  providers: Provider[];
  onChanged: () => Promise<void>;
  creationRequest?: CreationRequest | null;
  onCreationHandled?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<"all" | "leader" | "partner" | "adp">("all");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [designerOpen, setDesignerOpen] = useState(false);
  const [initialDraft, setInitialDraft] = useState<AgentDraft | undefined>();
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [selected, setSelected] = useState<Agent | null>(null);
  const handledRequest = useRef<CreationRequest | null>(null);
  const openCreation = (mode: CreationMode) => {
    setSelected(null);
    setInitialDraft(undefined);
    setDesignerOpen(mode === "ai");
    setBuilderOpen(mode === "manual");
  };
  useEffect(() => {
    if (creationRequest && creationRequest !== handledRequest.current) {
      handledRequest.current = creationRequest;
      openCreation(creationRequest.mode);
      onCreationHandled?.();
    }
  }, [creationRequest]);
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
      await alertDialog({ title: "无法删除", message: "系统必须至少保留一个协调型主智能体 (Leader)。" });
      return;
    }
    const confirmMsg = agent.role === "partner"
      ? `确定要删除智能体「${agent.name}」吗？`
      : `确定要删除智能体「${agent.name}」吗？该操作将解除相关协同配置。`;
    if (!(await confirmDialog({ title: "删除智能体", message: confirmMsg, confirmLabel: "删除", danger: true }))) {
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
            <NewAgentMenu onCreate={openCreation}/>
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
              ariaLabel="全网发现池"
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

      {!showAdpFeed && role !== "adp" && localFiltered.length === 0 && (
        <EmptyState>
          {agents.length === 0
            ? "还没有智能体，点击右上角“新建智能体”开始"
            : "没有匹配的智能体，换个关键词或筛选条件试试"}
        </EmptyState>
      )}

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

      {designerOpen && <AgentDesigner providers={providers} onClose={() => setDesignerOpen(false)} onDraft={draft => {
        setInitialDraft(draft);
        setSelected(null);
        setDesignerOpen(false);
        setBuilderOpen(true);
      }}/>}
      {builderOpen && (
        <AgentBuilder
          agent={selected}
          initialDraft={selected ? undefined : initialDraft}
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
