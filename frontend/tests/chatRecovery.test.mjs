import assert from "node:assert/strict";
import test from "node:test";
import { hasCompletedTaskMessage, upsertRecoveredAssistant } from "../src/chatRecovery.ts";

test("completed task is recognized after reload", () => {
  const messages = [{ role: "assistant", text: "完成", taskId: "task-1" }];
  assert.equal(hasCompletedTaskMessage(messages, "task-1"), true);
  assert.equal(hasCompletedTaskMessage(messages, "task-2"), false);
});

test("replaying a task updates its existing message instead of duplicating it", () => {
  const messages = [{ role: "assistant", text: "旧文本", taskId: "task-1", streaming: true }];
  const next = upsertRecoveredAssistant(messages, {
    role: "assistant", text: "完整文本", taskId: "task-1", streaming: false,
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].text, "完整文本");
});

test("legacy completed message is matched by invocation id", () => {
  const messages = [{ role: "assistant", text: "完整文本", result: { invocation_id: "inv-1" } }];
  const next = upsertRecoveredAssistant(messages, {
    role: "assistant", text: "完整文本", taskId: "task-1",
    result: { invocation_id: "inv-1" },
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].taskId, "task-1");
});

test("an older replay delta cannot overwrite a completed answer", () => {
  const messages = [{ role: "assistant", text: "完成", taskId: "task-1", streaming: false }];
  const next = upsertRecoveredAssistant(messages, {
    role: "assistant", text: "开", taskId: "task-1", streaming: true,
  });
  assert.equal(next, messages);
});

test("restart notice replaces a partial answer and stays idempotent", () => {
  const partial = [{ role: "user", text: "开始" }, { role: "assistant", text: "前半段", streaming: false }];
  const notice = {
    role: "assistant", text: "前半段\n\n[服务重启中断]",
    recoveryInvocationId: "inv-1", streaming: false,
  };
  const once = upsertRecoveredAssistant(partial, notice);
  const twice = upsertRecoveredAssistant(once, notice);
  assert.equal(once.length, 2);
  assert.equal(twice.length, 2);
  assert.equal(twice[1].text, notice.text);
});
