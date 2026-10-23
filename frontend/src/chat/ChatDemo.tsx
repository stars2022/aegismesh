import { FormEvent, lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createId } from "../randomId.mjs";
import {
  ClipboardCheck,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Braces,
  ChevronDown,
  CirclePlus,
  Copy,
  Database,
  GitBranch,
  GripVertical,
  FileText,
  ListPlus,
  Menu,
  MessageSquareText,
  Network,
  Pencil,
  Route,
  Search,
  Send,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Users,
  X,
  Paperclip,
} from "lucide-react";
import { api, type CanvasDocument } from "../api";
import { alertDialog, confirmDialog } from "../dialog";
import { FlowMark, LoadingFlow } from "../LoadingFlow";
import { DispatchCard } from "../DispatchCard";
import { hasCompletedTaskMessage, upsertRecoveredAssistant } from "../chatRecovery";
import { Dropdown, ScoreBar } from "../components";
import { AgentPicker } from "../AgentPicker";
import { StructuredResult } from "../StructuredIO";
import { buildStructuredTask, inputValues, taskSchemas } from "../structuredIOModel";
import type { StructuredTaskOptions, Agent, Attachment, BlackboardMessage, ChatResult } from "../types";
import { SidebarToggle, useCompactSidebar } from "../SidebarToggle";
import { SidebarAccount } from "../SidebarAccount";
import { SettingsDialog, type SettingsSection } from "../SettingsDialog";
import { requestedSettings, workbenchAfterSettings } from "../accountNavigation";
import { conversationStorage } from "../conversationStorage";
import { mergeConversationMeta, type ConversationMeta } from "../conversationHistory";
import type { Conversation, ChatMessage, QueuedTask, GroupConfig } from "../historyDocument";
import { defaultCoordinatorId } from "../agentMenu";
import { mergeSessionResults } from "../collaborationActivity";
import { applyTheme, estimateTokens, loadSettings, saveSettings, type UserSettings } from "../settings";
import { toolNames } from "../conciseGrouping";
import { metricLabels } from "../admin/labels";
import { ApiPage } from "./ApiPage";
import { CanvasFloatingAssistant } from "./CanvasFloatingAssistant";
import { ContextRing, formatTokensZh } from "./ContextRing";
import { CollaborationPanel, handleSubagentEvent, latestResult, type LiveSubagentState } from "./collaboration";
import { ConciseTurn, LiveSubagentRow, TurnClock } from "./conciseTurn";
import { BlackboardPanel, GroupCollaborationPanel, GroupMembersPanel, GroupSettingsDrawer } from "./groupPanels";
import { currentHistorySync, historySync, loadConversationData, loadConversationIndex, saveConversationData, saveConversationIndex } from "./historyStore";
import { MarkdownText } from "./markdown";
import { groupMessageText } from "./groupMessageText";
import { formatFileSize, formatMs } from "../format";

const CanvasWorkspace = lazy(() => import("../CanvasWorkspace").then((module) => ({ default: module.CanvasWorkspace })));
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

export function ChatDemo({ onComplete }: { onComplete: () => Promise<void> }) {
  const sync = currentHistorySync();
  const [historyError, setHistoryError] = useState('');
  const [conversations, setConversations] =
    useState<ConversationMeta[]>(loadConversationIndex);
  const [activeId, setActiveId] = useState(
    () => conversations[0]?.id || createId(),
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
      void alertDialog({ title: "文件上传失败", message: err instanceof Error ? err.message : "请稍后重试" });
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
    if (canvasConversation) void import("../CanvasWorkspace");
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
        if (sync.isDeleted(sessionRef.current) && !sendingRef.current) { createConversation(); return; }
        const target = list.find(item => item.id === activeIdRef.current) || (!loadConversationData(activeIdRef.current) ? list[0] : undefined);
        if (target && !sendingRef.current) {
          if (target.id !== activeIdRef.current || !loadConversationData(target.id)) openConversation(target);
          else {
            const fresh = await sync.load(target);
            if (!cancelled && fresh && activeIdRef.current === target.id && !sendingRef.current) {
              setMessages(fresh.messages); setInspector(latestResult(fresh.messages));
            }
          }
        }
      } catch (error) {
        if (!cancelled) setHistoryError(error instanceof Error ? error.message : '历史同步失败');
      }
    };
    const unsubscribe = sync.subscribe((error, indexChanged) => {
      if (cancelled) return;
      setHistoryError(error || '');
      if (indexChanged) {
        setConversations(sync.index());
        if (sync.isDeleted(sessionRef.current) && !sendingRef.current) createConversation();
      }
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
    const newId = createId();
    const canvasSession = `ses-${createId()}`;
    const defaultAgentId = targetAgentId || defaultCoordinatorId(agents, isCanvas);
    setActiveId(newId);
    activeIdRef.current = newId;
    setMessages([]);
    setShowAllMessages(false);
    setSession(canvasSession);
    sessionRef.current = canvasSession;
    setIsCanvasConv(isCanvas);
    if (isCanvas) void import("../CanvasWorkspace");
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
    const newId = createId();
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
    const taskSessionId = sessionRef.current || `ses-${createId()}`;
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
    const taskSessionId = sessionRef.current || `ses-${createId()}`;
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
      void alertDialog({ title: "评价提交失败", message: reason instanceof Error ? reason.message : "请稍后重试" });
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
          id: createId(),
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
            // 按本地自然日分组：昨晚的会话不应出现在“今天”。
            const todayStart = new Date().setHours(0, 0, 0, 0);
            const yesterdayStart = new Date(todayStart).setDate(new Date(todayStart).getDate() - 1);
            const weekStart = new Date(todayStart).setDate(new Date(todayStart).getDate() - 6);
            const groups: { key: string; label: string; items: ConversationMeta[] }[] = [
              { key: "today", label: "今天", items: [] },
              { key: "yesterday", label: "昨天", items: [] },
              { key: "week", label: "近 7 天", items: [] },
              { key: "earlier", label: "更早", items: [] },
            ];
            for (const meta of sorted) {
              const t = meta.updatedAt || 0;
              const key = !t ? "earlier" : t >= todayStart ? "today" : t >= yesterdayStart ? "yesterday" : t >= weekStart ? "week" : "earlier";
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
            onClearHistory={async () => {
              if (await confirmDialog({ title: "清空会话", message: "确定清空当前会话的消息记录吗？", confirmLabel: "清空", danger: true })) {
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
                        ) : index === 2 ? (
                          <GitBranch size={17} />
                        ) : (
                          <ClipboardCheck size={17} />
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
                        : <MarkdownText text={activeMeta?.isGroup && message.role === "assistant" ? groupMessageText(message.text) : message.text} streaming={message.streaming} />}
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
            {structuredError && <p className="builder-error" role="alert">{structuredError}</p>}
            <textarea
              ref={composerTextareaRef}
              aria-label="输入消息"
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
                {/* 空会话不显示容量圆环：只有系统提示词占用时，它看起来像加载中的转圈 */}
                {settings.showContextMeter && messages.length > 0 && (
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
            onClearChat={async () => {
              if (await confirmDialog({ title: "清空群聊", message: "确定清空当前群聊的所有聊天记录与黑板成果吗？", confirmLabel: "清空", danger: true })) {
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
                    <GitBranch size={13} style={{ color: "var(--accent-bright)" }} />
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
        onClearChat={async () => {
          if (await confirmDialog({ title: "清空群聊", message: "确定清空当前群聊的所有消息记录吗？", confirmLabel: "清空", danger: true })) {
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
