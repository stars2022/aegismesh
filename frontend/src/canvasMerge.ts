export type CanvasReviewEdit = { start: number; end: number; before: string[]; after: string[]; conflictsWithUser: boolean };
type Edit = { start: number; end: number; lines: string[] };

function editsFrom(base: string[], changed: string[]): Edit[] {
  // Large documents fall back to one conservative hunk, so conflicts never
  // silently overwrite a user's draft just to keep the diff fast.
  if (base.length * changed.length > 90_000) {
    let start = 0;
    while (start < Math.min(base.length, changed.length) && base[start] === changed[start]) start++;
    let tail = 0;
    while (tail < Math.min(base.length - start, changed.length - start) && base[base.length - 1 - tail] === changed[changed.length - 1 - tail]) tail++;
    return start === base.length && start === changed.length ? [] : [{ start, end: base.length - tail, lines: changed.slice(start, changed.length - tail) }];
  }
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
  return editsFrom(baseLines, agent.split("\n")).map((edit) => ({
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
  const agentEdits = editsFrom(baseLines, agent.split("\n")).filter((_, index) => accepted[index]);
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
