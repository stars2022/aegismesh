import { formatMs } from "../format";

export type View =
  | "overview"
  | "studio"
  | "providers"
  | "routing"
  | "probes"
  | "traces"
  | "logs"
  | "accounts"
  | "quotas"
  | "access";

export const stateNames: Record<string, string> = {
  online: "在线",
  offline: "离线",
  unknown: "未知",
  degraded: "受限",
  healthy: "健康",
  completed: "已完成",
  failed: "失败",
  working: "运行中",
  closed: "正常",
  open: "暂停编排",
  "half-open": "正在测试模型稳定程度",
};
export const ATTEMPT_STATE_LABELS: Record<string, string> = {
  selected: "已选中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timeout: "超时",
};
export const transportNames: Record<string, string> = {
  provider: "模型服务",
  "aip-rpc": "AIP 直连",
  "openai-compatible": "兼容接口",
  "openai-responses": "Responses 接口",
  "anthropic-messages": "Messages 接口",
};
export const metricLabels: Record<string, string> = {
  skill: "匹配程度",
  reliability: "历史可靠性",
  feedback: "用户反馈",
  latency: "响应延迟",
  load: "实时负载",
  health: "健康状态",
  cost: "成本",
};

function formatDetailValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const traceDetailLabels: Record<string, string> = {
  agent_id: "智能体",
  agent_name: "智能体",
  candidate_count: "候选数",
  attempt: "第几次尝试",
  latency_ms: "耗时",
  task_id: "任务",
  tool_name: "工具",
  mode: "模式",
  reason: "原因",
  error: "错误",
};

export function formatTraceTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function summarizeTraceDetail(detail: Record<string, unknown>): string {
  const hiddenKeys = new Set([
    "prompt",
    "query",
    "result",
    "result_text",
    "response",
    "output",
    "arguments",
    "context",
  ]);
  const parts = Object.entries(detail)
    .filter(([key, value]) => !hiddenKeys.has(key) && value != null && typeof value !== "object")
    .slice(0, 3)
    .map(([key, value]) => {
      const formatted = key === "latency_ms" && typeof value === "number"
        ? formatMs(value)
        : formatDetailValue(value);
      return `${traceDetailLabels[key] || key}：${formatted}`;
    });
  return parts.join(" · ") || "阶段已完成";
}

export const eventNames: Record<string, string> = {
  REQUEST_ACCEPTED: "收到任务",
  CONTEXT_LOADED: "载入上下文",
  CANDIDATES_SCORED: "完成评分",
  AGENT_SELECTED: "选择智能体",
  PARTNER_FAILED: "执行失败",
  FAILOVER_STARTED: "开始迁移",
  TASK_COMPLETED: "任务完成",
  TASK_FAILED: "任务失败",
  NO_ELIGIBLE_AGENT: "无可用智能体",
  COLLABORATION_STARTED: "开始协作",
  COLLABORATION_COMPLETED: "协作完成",
  COORDINATION_STARTED: "开始协调",
  DISPATCH_STARTED: "派发子任务",
  SUBAGENT_TASK_RECEIVED: "子智能体接收任务",
  SUBAGENT_TOOL_CALLED: "子智能体调用工具",
  SUBAGENT_TOOL_COMPLETED: "子智能体工具完成",
  SUBAGENT_COMPLETED: "子智能体执行完成",
  SUBAGENT_FAILED: "子智能体执行失败",
  DISPATCH_COMPLETED: "子任务完成",
  COORDINATION_FALLBACK: "协调转广播",
};
