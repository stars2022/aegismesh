import assert from 'node:assert/strict';
import test from 'node:test';
import { canvasReviewEdits, mergeCanvasContent, resolveCanvasReview, visiblyEqualMarkdown } from '../src/canvasMerge.ts';

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

test('soft-wrapped prose is not presented as an agent edit', () => {
  const before = '[1] KIM H D. Do long-term institutional investors foster corporate innovation?[J].\nAccounting & Finance, 2019, 59(2): 1163-1195.';
  const after = '[1] KIM H D. Do long-term institutional investors foster corporate innovation?[J]. Accounting & Finance, 2019, 59(2): 1163-1195.';
  assert.equal(visiblyEqualMarkdown(before, after), true);
  assert.deepEqual(canvasReviewEdits(before, before, after), []);
  assert.equal(resolveCanvasReview(before, before, after, []), before);
});

test('a rewrapped numbered reference with the same bold label is not a change', () => {
  const before = '1. **[14]—[43] 参考文献条目缺失：** 上传材料末尾截断，\n需补充原文。';
  const after = '1. **[14]—[43] 参考文献条目缺失：** 上传材料末尾截断，需补充原文。';
  assert.equal(visiblyEqualMarkdown(before, after), true);
  assert.deepEqual(canvasReviewEdits(before, before, after), []);
});

test('visible Markdown formatting and paragraph changes still require review', () => {
  assert.equal(visiblyEqualMarkdown('普通文本', '**普通文本**'), false);
  assert.equal(visiblyEqualMarkdown('第一段\n\n第二段', '第一段 第二段'), false);
  assert.equal(canvasReviewEdits('普通文本', '普通文本', '**普通文本**').length, 1);
});

test('long documents keep a final insertion separate from earlier formatting noise', () => {
  const lines = Array.from({ length: 450 }, (_, index) => `第 ${index + 1} 段：唯一的正文内容 ${index + 1}`);
  const base = lines.join('\n');
  const agentLines = [...lines];
  agentLines[12] = '第 13 段：唯一的正文内容  13';
  agentLines.push('最后新增的段落');
  const agent = agentLines.join('\n');
  const edits = canvasReviewEdits(base, base, agent);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].start, lines.length);
  assert.deepEqual(edits[0].after, ['最后新增的段落']);
  assert.equal(resolveCanvasReview(base, base, agent, [true]), base + '\n最后新增的段落');
});

test('long documents preserve independent local edits and still show the final insertion', () => {
  const lines = Array.from({ length: 450 }, (_, index) => `段落 ${index}: 内容 ${index}`);
  const base = lines.join('\n');
  const userLines = [...lines];
  userLines[14] = '用户手写内容';
  const agentLines = [...lines];
  agentLines[14] = '智能体的冲突建议';
  agentLines.push('末尾新增');
  const edits = canvasReviewEdits(base, userLines.join('\n'), agentLines.join('\n'));
  assert.equal(edits.length, 2);
  assert.equal(edits[0].conflictsWithUser, true);
  assert.equal(edits[1].conflictsWithUser, false);
  assert.equal(resolveCanvasReview(base, userLines.join('\n'), agentLines.join('\n'), [false, true]), userLines.join('\n') + '\n末尾新增');
});
