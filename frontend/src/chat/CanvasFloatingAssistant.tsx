import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowRight,
  GitBranch,
  FileText,
  Maximize2,
  MessageSquare,
  Minus,
  Minimize2,
  Download,
  Route,
  Send,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
  X,
  Paperclip,
} from "lucide-react";
import type { CanvasDocument } from "../api";
import { FlowMark } from "../LoadingFlow";
import { DispatchCard } from "../DispatchCard";
import { ScoreBar } from "../components";
import { AgentPicker } from "../AgentPicker";
import type { ChatMessage } from "../historyDocument";
import type { Agent, Attachment, BlackboardMessage, ChatResult } from "../types";
import { toolNames } from "../conciseGrouping";
import { metricLabels } from "../admin/labels";
import { CollaborationPanel, type LiveSubagentState } from "./collaboration";
import { MarkdownText } from "./markdown";
import { formatMs } from "../format";

export function CanvasFloatingAssistant({
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
                  <GitBranch size={13} style={{ color: "var(--accent-bright)" }} />
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
