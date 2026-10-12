import { ArrowLeft, ArrowRight, Braces, ChevronRight, TerminalSquare, X } from "lucide-react";
import { api } from "../api";

export function ApiPage({ onBack }: { onBack?: () => void }) {
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
