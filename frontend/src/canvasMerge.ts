export type CanvasReviewEdit = { start: number; end: number; before: string[]; after: string[]; conflictsWithUser: boolean };
type Edit = { start: number; end: number; lines: string[] };

function uniqueAnchors(base: string[], changed: string[]): Array<[number, number]> {
  const positions = (lines: string[]) => {
    const found = new Map<string, number>();
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      found.set(line, found.has(line) ? -1 : index);
    });
    return found;
  };
  const left = positions(base), right = positions(changed);
  const candidates: Array<[number, number]> = [];
  for (const [line, index] of left) {
    const other = right.get(line);
    if (index >= 0 && other !== undefined && other >= 0) candidates.push([index, other]);
  }
  candidates.sort((a, b) => a[0] - b[0]);
  const tails: number[] = [], previous: number[] = [];
  candidates.forEach(([, position], index) => {
    let low = 0, high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (candidates[tails[middle]][1] < position) low = middle + 1;
      else high = middle;
    }
    previous[index] = low ? tails[low - 1] : -1;
    tails[low] = index;
  });
  const anchors: Array<[number, number]> = [];
  for (let index = tails[tails.length - 1]; index !== undefined && index >= 0; index = previous[index]) {
    anchors.push(candidates[index]);
  }
  return anchors.reverse();
}

function smallEditsFrom(base: string[], changed: string[], offset: number): Edit[] {
  const table = Array.from({ length: base.length + 1 }, () => new Uint16Array(changed.length + 1));
  for (let i = base.length - 1; i >= 0; i--) for (let j = changed.length - 1; j >= 0; j--)
    table[i][j] = base[i] === changed[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const edits: Edit[] = [];
  let i = 0, j = 0;
  while (i < base.length || j < changed.length) {
    if (i < base.length && j < changed.length && base[i] === changed[j]) { i++; j++; continue; }
    const start = i;
    const lines: string[] = [];
    while (i < base.length || j < changed.length) {
      if (i < base.length && j < changed.length && base[i] === changed[j]) break;
      if (j < changed.length && (i === base.length || table[i][j + 1] >= table[i + 1][j])) lines.push(changed[j++]);
      else i++;
    }
    if (i - start > 1 && lines.length === i - start) {
      for (let offset = 0; offset < lines.length; offset++) {
        if (base[start + offset] !== lines[offset]) edits.push({ start: start + offset, end: start + offset + 1, lines: [lines[offset]] });
      }
    } else edits.push({ start, end: i, lines });
  }
  return edits.map((edit) => ({ ...edit, start: edit.start + offset, end: edit.end + offset }));
}

function rawEditsFrom(base: string[], changed: string[], offset = 0): Edit[] {
  let start = 0;
  while (start < Math.min(base.length, changed.length) && base[start] === changed[start]) start++;
  let tail = 0;
  while (tail < Math.min(base.length - start, changed.length - start) &&
    base[base.length - 1 - tail] === changed[changed.length - 1 - tail]) tail++;
  const left = base.slice(start, base.length - tail);
  const right = changed.slice(start, changed.length - tail);
  if (!left.length && !right.length) return [];
  if (!left.length || !right.length) return [{ start: offset + start, end: offset + start + left.length, lines: right }];
  if (left.length * right.length <= 90_000) return smallEditsFrom(left, right, offset + start);

  // Anchor unchanged unique lines instead of treating a long document as one
  // replacement from its first changed paragraph to its final appended line.
  const anchors = uniqueAnchors(left, right);
  if (!anchors.length) return [{ start: offset + start, end: offset + start + left.length, lines: right }];
  const edits: Edit[] = [];
  let leftCursor = 0, rightCursor = 0;
  for (const [leftIndex, rightIndex] of anchors) {
    edits.push(...rawEditsFrom(left.slice(leftCursor, leftIndex), right.slice(rightCursor, rightIndex), offset + start + leftCursor));
    leftCursor = leftIndex + 1;
    rightCursor = rightIndex + 1;
  }
  edits.push(...rawEditsFrom(left.slice(leftCursor), right.slice(rightCursor), offset + start + leftCursor));
  return edits;
}

function editsFrom(base: string[], changed: string[]): Edit[] {
  const edits = rawEditsFrom(base, changed);
  const grouped: Edit[] = [];
  for (const edit of edits) {
    const previous = grouped[grouped.length - 1];
    const gap = previous && base.slice(previous.end, edit.start);
    if (previous && gap.length > 0 && gap.every((line) => !line.trim()) &&
        (previous.start === previous.end || edit.start === edit.end || previous.lines.length === 0 || edit.lines.length === 0)) {
      previous.end = edit.end;
      previous.lines.push(...gap, ...edit.lines);
    } else grouped.push({ ...edit, lines: [...edit.lines] });
  }
  return grouped;
}

function overlaps(a: Edit, b: Edit): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

/** Soft wraps and ordinary prose whitespace do not change the rendered Markdown. */
export function visiblyEqualMarkdown(before: string, after: string): boolean {
  if (before === after) return true;
  const collapseProse = (value: string) => value.replace(/\s+/g, " ").trim()
    .replace(/([\u3400-\u9fff，。；：！？、）】]) (?=[\u3400-\u9fff（【])/g, "$1");
  const comparable = (value: string): string | null => {
    const normalized = value.replace(/\r\n?/g, "\n");
    // Preserve code, hard breaks, and structural Markdown differences.
    if (/(?: {2,}|\\)\n|`|^\s*(?:#{1,6}\s|>\s?|\|)/m.test(normalized)) return null;
    const lines = normalized.replace(/^\n+|\n+$/g, "").split("\n");
    const listMarker = lines[0]?.match(/^(\s*)(\d+[.)]|[-+*])\s+/);
    if (listMarker) {
      if (lines.slice(1).some((line) => /^\s*(?:\d+[.)]|[-+*])\s+/.test(line))) return null;
      const body = collapseProse([lines[0].slice(listMarker[0].length), ...lines.slice(1)].join(" "));
      return `list:${listMarker[1].length}:${listMarker[2]}:${body}`;
    }
    if (lines.some((line) => /^\s*(?:\d+[.)]|[-+*])\s+/.test(line))) return null;
    return normalized.trim().split(/\n\s*\n/).map(collapseProse).join("\n\n");
  };
  const left = comparable(before);
  return left !== null && left === comparable(after);
}

function reviewableAgentEdits(base: string[], agent: string[]): Edit[] {
  return editsFrom(base, agent).filter((edit) =>
    !visiblyEqualMarkdown(base.slice(edit.start, edit.end).join("\n"), edit.lines.join("\n"))
  );
}

/** Merge an agent update into an unsaved local draft. On overlap, user text wins. */
export function mergeCanvasContent(base: string, user: string, agent: string): { content: string; conflicts: number } {
  if (user === base) return { content: agent, conflicts: 0 };
  if (agent === base) return { content: user, conflicts: 0 };
  const baseLines = base.split("\n");
  const userEdits = editsFrom(baseLines, user.split("\n"));
  const agentEdits = editsFrom(baseLines, agent.split("\n"));
  let conflicts = 0;
  const safeAgentEdits = agentEdits.filter((edit) => {
    const collision = userEdits.some((userEdit) => overlaps(edit, userEdit));
    if (collision) conflicts++;
    return !collision;
  });
  const all = [...userEdits, ...safeAgentEdits].sort((a, b) => a.start - b.start);
  const result: string[] = [];
  let cursor = 0;
  for (const edit of all) {
    result.push(...baseLines.slice(cursor, edit.start), ...edit.lines);
    cursor = edit.end;
  }
  result.push(...baseLines.slice(cursor));
  return { content: result.join("\n"), conflicts };
}

export function canvasReviewEdits(base: string, user: string, agent: string): CanvasReviewEdit[] {
  const baseLines = base.split("\n");
  const userEdits = editsFrom(baseLines, user.split("\n"));
  return reviewableAgentEdits(baseLines, agent.split("\n")).map((edit) => ({
    start: edit.start,
    end: edit.end,
    before: baseLines.slice(edit.start, edit.end),
    after: edit.lines,
    conflictsWithUser: userEdits.some((userEdit) => overlaps(edit, userEdit)),
  }));
}

/** Apply explicit per-change decisions. Unselected changes keep the user's draft. */
export function resolveCanvasReview(base: string, user: string, agent: string, accepted: boolean[]): string {
  const baseLines = base.split("\n");
  const userEdits = editsFrom(baseLines, user.split("\n"));
  const agentEdits = reviewableAgentEdits(baseLines, agent.split("\n")).filter((_, index) => accepted[index]);
  const safeUserEdits = userEdits.filter((edit) => !agentEdits.some((agentEdit) => overlaps(edit, agentEdit)));
  const all = [...safeUserEdits, ...agentEdits].sort((a, b) => a.start - b.start);
  const result: string[] = [];
  let cursor = 0;
  for (const edit of all) {
    result.push(...baseLines.slice(cursor, edit.start), ...edit.lines);
    cursor = edit.end;
  }
  result.push(...baseLines.slice(cursor));
  return result.join("\n");
}
