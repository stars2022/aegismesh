import type { ChatResult } from "./types";

export const toolNames: Record<string, string> = {
  dispatch_task: "智能体已创建",
  list_agents: "查询执行者",
  check_subagent_status: "查询智能体状态",
  web_search: "联网搜索",
  read_web_page: "读取原文",
  calculator: "计算器",
  current_time: "当前时间",
  prepare_dispatch_context: "审核派发参考资料",
};

export function dispatchView(output: unknown): { agent: string; text: string } {
  if (!output) return { agent: "执行智能体", text: "未返回结果" };
  let current: unknown = output;
  if (typeof current === "string") {
    try {
      const parsed = JSON.parse(current);
      if (parsed && typeof parsed === "object") {
        current = parsed;
      }
    } catch {
      return { agent: "执行智能体", text: current as string };
    }
  }
  if (typeof current !== "object" || current === null) {
    return { agent: "执行智能体", text: String(current) };
  }

  const raw = current as Record<string, unknown>;
  const inner = (raw.result && typeof raw.result === "object" ? raw.result : raw) as Record<string, unknown>;

  const agent =
    (typeof inner.agent === "string" && inner.agent.trim()) ||
    (typeof inner.agent_name === "string" && inner.agent_name.trim()) ||
    (typeof inner.agent_id === "string" && inner.agent_id.trim()) ||
    (typeof raw.agent === "string" && raw.agent.trim()) ||
    (typeof raw.agent_name === "string" && raw.agent_name.trim()) ||
    (typeof raw.agent_id === "string" && raw.agent_id.trim()) ||
    "执行智能体";

  let text = "未返回结果";
  if (typeof raw.error === "string" && raw.error.trim()) {
    text = raw.error;
  } else if (typeof inner.error === "string" && inner.error.trim()) {
    text = inner.error;
  } else if (typeof inner.result === "string" && inner.result.trim()) {
    text = inner.result;
  } else if (typeof raw.result === "string" && raw.result.trim()) {
    text = raw.result;
  } else if (typeof inner.text === "string" && inner.text.trim()) {
    text = inner.text;
  } else if (typeof raw.text === "string" && raw.text.trim()) {
    text = raw.text;
  } else if (inner.result && typeof inner.result === "object") {
    text = JSON.stringify(inner.result);
  }

  return { agent, text };
}

export function getToolSubtitle(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const val =
    a.task ||
    a.query ||
    a.expression ||
    a.command ||
    a.url ||
    a.path ||
    a.task_id ||
    a.action ||
    a.name;
  if (!val) return undefined;
  const s = String(val).trim();
  return s.length > 35 ? s.slice(0, 35) + "..." : s;
}

export type TurnAction =
  | {
      kind: "agent";
      name: string;
      agentName: string;
      task?: string;
      arguments?: Record<string, unknown>;
      output?: unknown;
      totalCollabs: number;
      callChain?: string[];
      depth?: number;
    }
  | {
      kind: "tool";
      name: string;
      arguments?: Record<string, unknown>;
      output?: unknown;
    };

export type TurnActionBlock =
  | {
      kind: "agent";
      action: Extract<TurnAction, { kind: "agent" }>;
    }
  | {
      kind: "single_tool";
      action: Extract<TurnAction, { kind: "tool" }>;
    }
  | {
      kind: "tool_group";
      tools: Extract<TurnAction, { kind: "tool" }>[];
      summaryTitle: string;
      leadIconName: string;
    };

export function buildTurnActions(
  result: ChatResult | null | undefined,
): TurnAction[] {
  if (!result || !result.result_data) return [];

  const direct = result.result_data.tool_executions?.length ? result.result_data.tool_executions :
    (result.result_data.runtime_tools || []).map(t => ({ name: t.name, arguments: t.arguments || {}, output: t.output_preview }));
  const contributions = result.result_data.contributions || [];
  const collabs = result.result_data.collaborations || [];
  const totalCollabs = Math.max(contributions.length, collabs.length);

  const actions: TurnAction[] = [];
  const handledCollabs = new Set<Record<string, unknown>>();
  const handledCollabIds = new Set<string>();
  const handledTaskIds = new Set<string>();

  // 1. 遍历直接执行序列 (Leader 调用的工具或平台分派的 dispatch_task)
  if (direct.length > 0) {
    for (const item of direct) {
      if (item.name === "dispatch_task") {
        const view = dispatchView(item.output);
        const rawArgs =
          typeof item.arguments === "object" && item.arguments !== null
            ? (item.arguments as Record<string, unknown>)
            : {};
        const task = (rawArgs.task as string | undefined) || undefined;
        const agentArg = (rawArgs.agent as string | undefined) || undefined;

        const rawOut = (typeof item.output === "string"
          ? (() => { try { return JSON.parse(item.output as string); } catch { return {}; } })()
          : (item.output || {})) as Record<string, any>;
        const outTaskId =
          rawOut?.task_id ||
          rawOut?.result?.task_id ||
          (typeof rawOut?.result === "string" && (rawOut.result.startsWith("subtask_") || rawOut.result.startsWith("task-"))
            ? rawOut.result
            : undefined);

        // 尝试从 collaborations 丰富智能体名称与输出
        const matchingCollab = collabs.find(
          (c) =>
            !handledCollabs.has(c as any) &&
            ((outTaskId && c.task_id === outTaskId) ||
              (c.task_id && typeof (rawOut?.result) === "string" && c.task_id === rawOut.result) ||
              (agentArg && (c.agent_id === agentArg || c.agent_name === agentArg)) ||
              (view.agent && view.agent !== "执行智能体" && (c.agent_name === view.agent || c.agent_id === view.agent)) ||
              (task && c.task && (c.task === task || c.task.includes(task) || task.includes(c.task)))),
        );

        if (matchingCollab) {
          handledCollabs.add(matchingCollab as any);
          if (matchingCollab.agent_id) handledCollabIds.add(matchingCollab.agent_id);
          if (matchingCollab.agent_name) handledCollabIds.add(matchingCollab.agent_name);
          if (matchingCollab.task_id) handledTaskIds.add(matchingCollab.task_id);
        }
        if (outTaskId) handledTaskIds.add(outTaskId);
        if (agentArg) handledCollabIds.add(agentArg);

        const viewAgent =
          view.agent && view.agent !== "执行智能体" ? view.agent : undefined;
        const agentName =
          matchingCollab?.agent_name || viewAgent || agentArg || view.agent;
        const finalTask = matchingCollab?.task || task;
        const finalOutput =
          matchingCollab?.result || matchingCollab?.error || item.output;

        actions.push({
          kind: "agent",
          name: "dispatch_task",
          agentName,
          task: finalTask,
          arguments: item.arguments,
          output: finalOutput,
          totalCollabs,
          callChain: matchingCollab?.call_chain,
          depth: matchingCollab?.depth,
        });
      } else {
        actions.push({
          kind: "tool",
          name: item.name,
          arguments: item.arguments,
          output: item.output,
        });
      }
    }
  }

  // 2. 补充分派记录中未包含的协同智能体（如广播协作或异步背景智能体）
  for (const c of collabs) {
    if (handledCollabs.has(c as any)) continue;
    if (c.task_id && handledTaskIds.has(c.task_id)) continue;
    if (c.agent_id && handledCollabIds.has(c.agent_id)) continue;
    if (c.agent_name && handledCollabIds.has(c.agent_name)) continue;

    actions.push({
      kind: "agent",
      name: "dispatch_task",
      agentName: c.agent_name || c.agent_id || "协同智能体",
      task: c.task,
      output: c.result || c.error,
      totalCollabs,
      callChain: c.call_chain,
      depth: c.depth,
    });
    handledCollabs.add(c as any);
    if (c.agent_id) handledCollabIds.add(c.agent_id);
    if (c.agent_name) handledCollabIds.add(c.agent_name);
    if (c.task_id) handledTaskIds.add(c.task_id);
  }

  // 3. 若无 collaborations 则回退检查 contributions 中的智能体
  if (collabs.length === 0 && contributions.length > 0) {
    for (const c of contributions) {
      if (c.agent_id && handledCollabIds.has(c.agent_id)) continue;
      actions.push({
        kind: "agent",
        name: "dispatch_task",
        agentName: c.agent_name || c.agent_id || "协同智能体",
        task: "协同任务",
        output: c.text,
        totalCollabs,
      });
      if (c.agent_id) handledCollabIds.add(c.agent_id);
    }
  }

  // 4. 若无 direct 工具调用，从 contributions 中提取子智能体执行的嵌套工具调用
  if (direct.length === 0 && contributions.length > 0) {
    for (const c of contributions) {
      const subTools = (
        c.data as { tool_executions?: typeof direct } | undefined
      )?.tool_executions;
      if (Array.isArray(subTools)) {
        for (const subItem of subTools) {
          if (subItem.name !== "dispatch_task") {
            actions.push({
              kind: "tool",
              name: subItem.name,
              arguments: subItem.arguments,
              output: subItem.output,
            });
          }
        }
      }
    }
  }

  return actions;
}

export function partitionTurnActions(actions: TurnAction[]): TurnActionBlock[] {
  const blocks: TurnActionBlock[] = [];
  for (let i = 0; i < actions.length; ) {
    const action = actions[i];
    if (action.kind === "agent") {
      // 智能体创建为独立项，不参与工具调用动态汇总
      blocks.push({
        kind: "agent",
        action,
      });
      i += 1;
      continue;
    }

    // 收集连续的工具调用
    const tools: Extract<TurnAction, { kind: "tool" }>[] = [];
    while (i < actions.length && actions[i].kind === "tool") {
      tools.push(actions[i] as Extract<TurnAction, { kind: "tool" }>);
      i += 1;
    }

    if (tools.length > 1) {
      // 连续的工具调用才生成动态汇总标题并聚合为组
      const counts = new Map<string, number>();
      tools.forEach((t) => counts.set(t.name, (counts.get(t.name) || 0) + 1));
      const summaryParts: string[] = [];
      counts.forEach((count, name) => {
        const label = toolNames[name] || name;
        summaryParts.push(`${label}${count > 1 ? ` ×${count}` : ""}`);
      });
      blocks.push({
        kind: "tool_group",
        tools,
        summaryTitle: summaryParts.join(" · "),
        leadIconName: tools[0].name,
      });
    } else if (tools.length === 1) {
      // 独立的工具调用不汇总，保持独立展示
      blocks.push({
        kind: "single_tool",
        action: tools[0],
      });
    }
  }
  return blocks;
}
