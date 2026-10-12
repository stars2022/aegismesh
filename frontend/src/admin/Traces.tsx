import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { EmptyState, StatusDot } from "../components";
import type { Trace } from "../types";
import { ATTEMPT_STATE_LABELS, eventNames, formatTraceTime, metricLabels, stateNames, summarizeTraceDetail } from "./labels";
import { MarkdownText } from "../chat/markdown";
import { formatMs } from "../format";

export function Traces({ traces }: { traces: Trace[] }) {
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
            aria-label="搜索运行记录"
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
