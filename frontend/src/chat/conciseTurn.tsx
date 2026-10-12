import { useEffect, useMemo, useState } from "react";
import { Activity, Bot, Braces, ChevronRight, Clock, FileText, ScanSearch, Search, TerminalSquare } from "lucide-react";
import type { ChatResult } from "../types";
import { buildTurnActions, getToolSubtitle, partitionTurnActions, toolNames, type TurnAction } from "../conciseGrouping";
import type { LiveSubagentState } from "./collaboration";

export function formatRunDuration(ms: number) {
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

export function TurnClock({ start }: { start: number }) {
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

export function ConciseTurn({
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

export function LiveSubagentRow({
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
