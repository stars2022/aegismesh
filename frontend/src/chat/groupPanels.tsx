import { useEffect, useState } from "react";
import {
  Activity,
  Bot,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  GitBranch,
  Layers,
  Plus,
  Minus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { Conversation, ChatMessage, GroupConfig } from "../historyDocument";
import type { Agent, BlackboardMessage } from "../types";
import { MarkdownText } from "./markdown";
import { formatRelative } from "../format";

export function BlackboardPanel({
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
        <p>群聊中的方案、数据表格和分析报告会集中保存在这里，便于成员查看和继续协作。</p>
      </div>
    );
  }

  return (
    <div className="blackboard-panel">
      {/* Display recorded delivery state, not an unverified certification. */}
      <div className="blackboard-standard-banner">
        <div className="bb-std-badge-row">
          <span className="bb-std-tag">共享交付物</span>
          <span className="bb-std-code">成员协作</span>
          <span className="bb-std-code">来源可查看</span>
        </div>
        <span className="bb-std-desc">
          汇集各成员交付内容 · 请结合原始来源核对结论
        </span>
      </div>

      <div className="blackboard-header">
        <div className="bb-header-title">
          <Layers size={15} />
          <strong>协作黑板资产库</strong>
          <span className="bb-count-pill">{deliverables.length} 份交付物</span>
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
          const artId = item.id;
          const handleCopy = () => {
            navigator.clipboard.writeText(item.content);
            setCopiedId(item.id);
            setTimeout(() => setCopiedId(null), 2000);
          };

          return (
            <article key={item.id} className="blackboard-card">
              <header className="blackboard-card-header" onClick={() => toggleExpand(item.id)}>
                <div className="bb-card-meta">
                  <span className="bb-card-tag">协作成果</span>
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

              {/* Actual source metadata; no inferred review or compliance status. */}
              <div className="bb-card-audit-bar">
                <span className="bb-audit-chip">记录: {artId}</span>
                <span className="bb-audit-chip">来源: {item.sender_name || item.sender_id}</span>
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

export function GroupCollaborationPanel({
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
            <Sparkles size={14} style={{ color: "var(--accent-bright)" }} />
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
          <GitBranch size={14} style={{ color: "var(--accent)" }} />
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

export function GroupMembersPanel({
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

export function GroupSettingsDrawer({
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
