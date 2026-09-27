import assert from 'node:assert/strict';
import test from 'node:test';
import { canvasReviewEdits, mergeCanvasContent, resolveCanvasReview } from '../src/canvasMerge.ts';

test('combines edits to separate canvas sections', () => {
  const base = '# 标题\n原始一\n原始二\n';
  const user = '# 标题\n用户一\n原始二\n';
  const agent = '# 标题\n原始一\n智能体二\n';
  assert.deepEqual(mergeCanvasContent(base, user, agent), {
    content: '# 标题\n用户一\n智能体二\n', conflicts: 0,
  });
});

test('keeps user text when both sides change the same line', () => {
  const base = '# 标题\n原始一\n原始二\n';
  const user = '# 标题\n用户一\n原始二\n';
  const agent = '# 标题\n智能体一\n原始二\n';
  assert.deepEqual(mergeCanvasContent(base, user, agent), {
    content: user, conflicts: 1,
  });
});

test('does not lose user text when agent replaces the whole document', () => {
  const base = '# 标题\n正文\n';
  const user = '# 用户标题\n正文\n';
  const agent = '# 智能体新稿\n不同内容\n';
  const merged = mergeCanvasContent(base, user, agent);
  assert.match(merged.content, /用户标题/);
  assert.ok(merged.conflicts > 0);
});

test('review defaults can preserve an overlapping user edit while showing the agent proposal', () => {
  const base = '# 标题\n原始一\n原始二\n';
  const user = '# 标题\n用户一\n原始二\n';
  const agent = '# 标题\n智能体一\n智能体二\n';
  const edits = canvasReviewEdits(base, user, agent);
  assert.equal(edits.length, 2);
  assert.equal(edits[0].conflictsWithUser, true);
  assert.equal(edits[1].conflictsWithUser, false);
  assert.equal(resolveCanvasReview(base, user, agent, [false, false]), user);
  assert.equal(resolveCanvasReview(base, user, agent, [true, true]), agent);
  assert.equal(resolveCanvasReview(base, user, agent, [false, true]), '# 标题\n用户一\n智能体二\n');
});

test('accepting an independent agent change keeps a separate user change', () => {
  const base = '# 标题\n原始一\n原始二\n';
  const user = '# 标题\n用户一\n原始二\n';
  const agent = '# 标题\n原始一\n智能体二\n';
  assert.equal(resolveCanvasReview(base, user, agent, [true]), '# 标题\n用户一\n智能体二\n');
});

test('accepting one overlapping line does not discard adjacent manual lines', () => {
  const base = '甲\n乙\n丙';
  const user = '用户甲\n用户乙\n丙';
  const agent = '甲\n智能体乙\n丙';
  assert.equal(resolveCanvasReview(base, user, agent, [true]), '用户甲\n智能体乙\n丙');
});
