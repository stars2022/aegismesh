import test from "node:test";
import assert from "node:assert/strict";
import {
  toolNames,
  dispatchView,
  getToolSubtitle,
  buildTurnActions,
  partitionTurnActions,
} from "../src/conciseGrouping.ts";

test("empty turn returns no actions and no blocks", () => {
  assert.deepEqual(buildTurnActions(null), []);
  assert.deepEqual(partitionTurnActions([]), []);

  assert.deepEqual(buildTurnActions(undefined), []);
  assert.deepEqual(buildTurnActions({}), []);

  const emptyResult = { result_data: { tool_executions: [] } };
  assert.deepEqual(buildTurnActions(emptyResult), []);
  assert.deepEqual(partitionTurnActions(buildTurnActions(emptyResult)), []);
});

test("source reader has a localized label and source subtitle", () => {
  assert.equal(toolNames.read_web_page, "读取原文");
  assert.equal(getToolSubtitle({ url: "https://example.org/paper" }), "https://example.org/paper");
  const blocks = partitionTurnActions(buildTurnActions({ result_data: { tool_executions: [
    { name: "web_search", arguments: { query: "paper" }, output: {} },
    { name: "read_web_page", arguments: { url: "https://example.org/paper" }, output: {} },
  ] } }));
  assert.equal(blocks[0].summaryTitle, "联网搜索 · 读取原文");
});

test("single independent tool call is NOT summarized into a group", () => {
  const result = {
    result_data: {
      tool_executions: [
        {
          name: "web_search",
          arguments: { query: "Apple 最新发布会" },
          output: "搜索结果",
        },
      ],
    },
  };

  const actions = buildTurnActions(result);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "tool");
  assert.equal(actions[0].name, "web_search");

  const blocks = partitionTurnActions(actions);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "single_tool");
  assert.equal(blocks[0].action.name, "web_search");
  // 必须是单项，不得包装为带有动态汇总标题的 tool_group
  assert.equal("summaryTitle" in blocks[0], false);
});

test("consecutive tool calls ARE summarized with dynamic summary title", () => {
  const result = {
    result_data: {
      tool_executions: [
        {
          name: "web_search",
          arguments: { query: "天气" },
          output: "晴朗",
        },
        {
          name: "calculator",
          arguments: { expression: "25 * 4" },
          output: 100,
        },
      ],
    },
  };

  const actions = buildTurnActions(result);
  assert.equal(actions.length, 2);

  const blocks = partitionTurnActions(actions);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "tool_group");
  assert.equal(blocks[0].summaryTitle, "联网搜索 · 计算器");
  assert.equal(blocks[0].leadIconName, "web_search");
  assert.equal(blocks[0].tools.length, 2);
});

test("consecutive same tools show multiplier count in summary title", () => {
  const result = {
    result_data: {
      tool_executions: [
        { name: "web_search", arguments: { query: "A" }, output: "resA" },
        { name: "web_search", arguments: { query: "B" }, output: "resB" },
        { name: "calculator", arguments: { expression: "1+1" }, output: 2 },
      ],
    },
  };

  const actions = buildTurnActions(result);
  const blocks = partitionTurnActions(actions);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "tool_group");
  assert.equal(blocks[0].summaryTitle, "联网搜索 ×2 · 计算器");
  assert.equal(blocks[0].tools.length, 3);
});

test("independent agent creation is NOT grouped or summarized with tool calls", () => {
  const result = {
    result_data: {
      tool_executions: [
        {
          name: "dispatch_task",
          arguments: { agent: "sec-auditor", task: "分析系统日志" },
          output: {
            result: { agent: "安全审计专家", result: "发现 0 个漏洞" },
          },
        },
      ],
    },
  };

  const actions = buildTurnActions(result);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "agent");
  assert.equal(actions[0].name, "dispatch_task");
  assert.equal(actions[0].agentName, "安全审计专家");
  assert.equal(actions[0].task, "分析系统日志");

  const blocks = partitionTurnActions(actions);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "agent");
  assert.equal(blocks[0].action.agentName, "安全审计专家");
});

test("agent creation followed by single tool call has NO tool_group", () => {
  const result = {
    result_data: {
      tool_executions: [
        {
          name: "dispatch_task",
          arguments: { agent: "planner", task: "规划路线" },
          output: { result: { agent: "规划智能体", result: "规划完成" } },
        },
        {
          name: "current_time",
          arguments: {},
          output: "2026-09-20 13:00",
        },
      ],
    },
  };

  const actions = buildTurnActions(result);
  const blocks = partitionTurnActions(actions);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, "agent");
  assert.equal(blocks[1].kind, "single_tool");
  assert.equal(blocks[1].action.name, "current_time");
  // 两个均为独立项，无任何 tool_group 聚合
  assert.equal(blocks.some((b) => b.kind === "tool_group"), false);
});

test("tool calls separated by agent creation are NOT merged together", () => {
  const result = {
    result_data: {
      tool_executions: [
        { name: "web_search", arguments: { query: "A" }, output: "resA" },
        {
          name: "dispatch_task",
          arguments: { agent: "analyst", task: "分析" },
          output: { result: { agent: "分析员", result: "分析完成" } },
        },
        { name: "calculator", arguments: { expression: "2*2" }, output: 4 },
      ],
    },
  };

  const actions = buildTurnActions(result);
  const blocks = partitionTurnActions(actions);

  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].kind, "single_tool");
  assert.equal(blocks[0].action.name, "web_search");
  assert.equal(blocks[1].kind, "agent");
  assert.equal(blocks[2].kind, "single_tool");
  assert.equal(blocks[2].action.name, "calculator");
});

test("consecutive tools before and after agent creation form two distinct tool_groups", () => {
  const actions = [
    { kind: "tool", name: "web_search" },
    { kind: "tool", name: "calculator" },
    { kind: "agent", name: "dispatch_task", agentName: "专家", totalCollabs: 1 },
    { kind: "tool", name: "current_time" },
    { kind: "tool", name: "list_agents" },
  ];

  const blocks = partitionTurnActions(actions);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].kind, "tool_group");
  assert.equal(blocks[0].summaryTitle, "联网搜索 · 计算器");
  assert.equal(blocks[1].kind, "agent");
  assert.equal(blocks[2].kind, "tool_group");
  assert.equal(blocks[2].summaryTitle, "当前时间 · 查询执行者");
});

test("coexistence of direct tool executions AND collaborations: collaborations are NOT dropped", () => {
  const result = {
    result_data: {
      tool_executions: [
        { name: "web_search", arguments: { query: "漏洞预警" }, output: "结果" },
      ],
      collaborations: [
        {
          agent_id: "sec-expert",
          agent_name: "安全响应专家",
          task: "应急处置",
          result: "处置完毕",
        },
      ],
    },
  };

  const actions = buildTurnActions(result);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].kind, "tool");
  assert.equal(actions[0].name, "web_search");
  assert.equal(actions[1].kind, "agent");
  assert.equal(actions[1].agentName, "安全响应专家");

  const blocks = partitionTurnActions(actions);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, "single_tool");
  assert.equal(blocks[1].kind, "agent");
});

test("dispatch_task merges rich agentName and output from collaborations", () => {
  const result = {
    result_data: {
      tool_executions: [
        {
          name: "dispatch_task",
          arguments: { agent: "id-audit", task: "合规检测" },
          output: { result: "task-001" },
        },
      ],
      collaborations: [
        {
          agent_id: "id-audit",
          agent_name: "合规审计师",
          task: "合规检测",
          result: "合规率 100%",
        },
      ],
    },
  };

  const actions = buildTurnActions(result);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "agent");
  assert.equal(actions[0].agentName, "合规审计师");
  assert.equal(actions[0].task, "合规检测");
  assert.equal(actions[0].output, "合规率 100%");
});

test("broadcast mode extracts nested tool executions from contributions when direct is empty", () => {
  const result = {
    result_data: {
      tool_executions: [],
      collaborations: [
        { agent_id: "a1", agent_name: "侦测员", task: "环境扫描", result: "扫描完成" },
      ],
      contributions: [
        {
          agent_id: "a1",
          agent_name: "侦测员",
          text: "完成环境扫描",
          data: {
            tool_executions: [
              { name: "web_search", arguments: { query: "port scan" }, output: "ports" },
              { name: "calculator", arguments: { expression: "80+443" }, output: 523 },
            ],
          },
        },
      ],
    },
  };

  const actions = buildTurnActions(result);
  // 包含 1 个 agent 创建与 2 个子工具调用
  assert.equal(actions.length, 3);
  assert.equal(actions[0].kind, "agent");
  assert.equal(actions[0].agentName, "侦测员");
  assert.equal(actions[1].kind, "tool");
  assert.equal(actions[1].name, "web_search");
  assert.equal(actions[2].kind, "tool");
  assert.equal(actions[2].name, "calculator");

  const blocks = partitionTurnActions(actions);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, "agent");
  assert.equal(blocks[1].kind, "tool_group");
  assert.equal(blocks[1].summaryTitle, "联网搜索 · 计算器");
});

test("getToolSubtitle extracts and truncates varied parameters correctly", () => {
  assert.equal(getToolSubtitle(null), undefined);
  assert.equal(getToolSubtitle({}), undefined);
  assert.equal(getToolSubtitle({ query: "短查询" }), "短查询");
  assert.equal(getToolSubtitle({ expression: "1 + 2 * 3" }), "1 + 2 * 3");
  assert.equal(getToolSubtitle({ command: "kubectl get pods" }), "kubectl get pods");
  assert.equal(getToolSubtitle({ task_id: "task-abc-123" }), "task-abc-123");

  const longQuery = "a".repeat(50);
  const truncated = getToolSubtitle({ query: longQuery });
  assert.equal(truncated.length, 38); // 35 + '...'
  assert.ok(truncated.endsWith("..."));
});
