/**
 * Comparison algorithms for Change Radar. Pure functions, no I/O.
 */

export type DiffOp = { type: 'equal' | 'add' | 'remove'; left: number | null; right: number | null; text: string };

/** Myers O(ND) line diff. Falls back to a coarse result when inputs are too large to diff in memory. */
export function diffLines(left: string[], right: string[], maxCost = 4_000_000): DiffOp[] {
  // Trim common prefix and suffix first: most real edits are local.
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endL = left.length;
  let endR = right.length;
  while (endL > start && endR > start && left[endL - 1] === right[endR - 1]) {
    endL -= 1;
    endR -= 1;
  }
  const a = left.slice(start, endL);
  const b = right.slice(start, endR);
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ type: 'equal', left: i + 1, right: i + 1, text: left[i] ?? '' });

  const middle: DiffOp[] = [];
  const n = a.length;
  const m = b.length;
  if ((n + m) * (n + m) > maxCost) {
    a.forEach((text, i) => middle.push({ type: 'remove', left: start + i + 1, right: null, text }));
    b.forEach((text, j) => middle.push({ type: 'add', left: null, right: start + j + 1, text }));
  } else {
    const max = n + m;
    const offset = max;
    const v = new Int32Array(2 * max + 2);
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= max && !found; d += 1) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0)) ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) {
          x += 1;
          y += 1;
        }
        v[offset + k] = x;
        if (x >= n && y >= m) {
          found = true;
          break;
        }
      }
    }
    // Backtrack.
    let x = n;
    let y = m;
    const reversed: DiffOp[] = [];
    for (let d = trace.length - 1; d >= 0; d -= 1) {
      const vd = trace[d] as Int32Array;
      const k = x - y;
      const prevK = k === -d || (k !== d && (vd[offset + k - 1] ?? 0) < (vd[offset + k + 1] ?? 0)) ? k + 1 : k - 1;
      const prevX = vd[offset + prevK] ?? 0;
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        x -= 1;
        y -= 1;
        reversed.push({ type: 'equal', left: start + x + 1, right: start + y + 1, text: a[x] ?? '' });
      }
      if (d > 0) {
        if (x === prevX) {
          y -= 1;
          reversed.push({ type: 'add', left: null, right: start + y + 1, text: b[y] ?? '' });
        } else {
          x -= 1;
          reversed.push({ type: 'remove', left: start + x + 1, right: null, text: a[x] ?? '' });
        }
      }
    }
    middle.push(...reversed.reverse());
  }
  ops.push(...middle);
  for (let i = 0; i < left.length - endL; i += 1) ops.push({ type: 'equal', left: endL + i + 1, right: endR + i + 1, text: left[endL + i] ?? '' });
  return ops;
}

export type DiffSummary = { added: number; removed: number; unchanged: number };

export function summarize(ops: DiffOp[]): DiffSummary {
  return ops.reduce((s, op) => ({ added: s.added + (op.type === 'add' ? 1 : 0), removed: s.removed + (op.type === 'remove' ? 1 : 0), unchanged: s.unchanged + (op.type === 'equal' ? 1 : 0) }), { added: 0, removed: 0, unchanged: 0 });
}

/** Keeps `context` unchanged lines around each change and replaces long equal runs with a gap marker. */
export function withContext(ops: DiffOp[], context = 2): (DiffOp | { type: 'gap'; hidden: number })[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.type === 'equal') return;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j += 1) keep[j] = true;
  });
  const out: (DiffOp | { type: 'gap'; hidden: number })[] = [];
  let hidden = 0;
  ops.forEach((op, i) => {
    if (keep[i]) {
      if (hidden) out.push({ type: 'gap', hidden });
      hidden = 0;
      out.push(op);
    } else {
      hidden += 1;
    }
  });
  if (hidden) out.push({ type: 'gap', hidden });
  return out;
}

/** Word-level changes between two versions of one line, for inline highlighting. */
export function diffWords(before: string, after: string): { type: DiffOp['type']; text: string }[] {
  const tokenize = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];
  return diffLines(tokenize(before), tokenize(after), 250_000).map((op) => ({ type: op.type, text: op.text }));
}

// region JSON

export type JsonChange = { path: string; kind: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown };

export function diffJson(before: unknown, after: unknown, path = '$', out: JsonChange[] = [], limit = 1000): JsonChange[] {
  if (out.length >= limit) return out;
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i += 1) {
      const p = `${path}[${i}]`;
      if (i >= before.length) out.push({ path: p, kind: 'added', after: after[i] });
      else if (i >= after.length) out.push({ path: p, kind: 'removed', before: before[i] });
      else diffJson(before[i], after[i], p, out, limit);
    }
    return out;
  }
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const p = /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
      if (!(key in before)) out.push({ path: p, kind: 'added', after: after[key] });
      else if (!(key in after)) out.push({ path: p, kind: 'removed', before: before[key] });
      else diffJson(before[key], after[key], p, out, limit);
    }
    return out;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path, kind: 'changed', before, after });
  return out;
}

// endregion

// region CSV

/** RFC 4180 parser: quoted fields, escaped quotes, embedded commas and newlines. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export type CellChange = { cell: string; row: number; column: string; header: string | null; before: string; after: string };

export type CsvDiff = { changedCells: CellChange[]; addedRows: number[]; removedRows: number[]; headerChanged: boolean; columnsBefore: number; columnsAfter: number };

/** Cell-by-cell comparison by position. Rows are matched by line; inserted rows shift later rows. */
export function diffCsv(beforeText: string, afterText: string, limit = 2000): CsvDiff {
  const delimiter = (beforeText.split('\n')[0] ?? '').includes('\t') ? '\t' : beforeText.includes(';') && !beforeText.includes(',') ? ';' : ',';
  const before = parseCsv(beforeText, delimiter);
  const after = parseCsv(afterText, delimiter);
  const header = before[0] ?? [];
  const changedCells: CellChange[] = [];
  const rows = Math.min(before.length, after.length);
  for (let r = 0; r < rows && changedCells.length < limit; r += 1) {
    const a = before[r] ?? [];
    const b = after[r] ?? [];
    for (let c = 0; c < Math.max(a.length, b.length); c += 1) {
      if ((a[c] ?? '') !== (b[c] ?? '')) {
        changedCells.push({ cell: `${columnName(c)}${r + 1}`, row: r + 1, column: columnName(c), header: r === 0 ? null : (header[c] ?? null), before: a[c] ?? '', after: b[c] ?? '' });
      }
    }
  }
  return {
    changedCells,
    addedRows: after.length > before.length ? Array.from({ length: after.length - before.length }, (_, i) => before.length + i + 1) : [],
    removedRows: before.length > after.length ? Array.from({ length: before.length - after.length }, (_, i) => after.length + i + 1) : [],
    headerChanged: JSON.stringify(before[0] ?? []) !== JSON.stringify(after[0] ?? []),
    columnsBefore: before[0]?.length ?? 0,
    columnsAfter: after[0]?.length ?? 0,
  };
}

// endregion

// region Folder snapshots

export type SnapshotItem = { path: string; isDirectory: boolean; size: number | null; modifiedAt: number | null; sha256: string | null };

export type FolderChange =
  | { kind: 'added' | 'removed'; path: string; size: number | null }
  | { kind: 'modified'; path: string; sizeBefore: number | null; sizeAfter: number | null; basis: 'content' | 'size' | 'timestamp' }
  | { kind: 'renamed'; from: string; to: string; basis: 'content' | 'size-and-time' };

/**
 * Compares two folder states. "Modified" is decided by content hash when both sides have one,
 * otherwise by size, and only as a last resort by timestamp (reported as such).
 */
export function compareSnapshots(before: SnapshotItem[], after: SnapshotItem[]): FolderChange[] {
  const files = (items: SnapshotItem[]) => new Map(items.filter((i) => !i.isDirectory).map((i) => [i.path, i]));
  const a = files(before);
  const b = files(after);
  const changes: FolderChange[] = [];
  const removed: SnapshotItem[] = [];
  const added: SnapshotItem[] = [];
  for (const [path, old] of a) {
    const now = b.get(path);
    if (!now) {
      removed.push(old);
      continue;
    }
    if (old.sha256 && now.sha256) {
      if (old.sha256 !== now.sha256) changes.push({ kind: 'modified', path, sizeBefore: old.size, sizeAfter: now.size, basis: 'content' });
    } else if (old.size !== now.size) {
      changes.push({ kind: 'modified', path, sizeBefore: old.size, sizeAfter: now.size, basis: 'size' });
    } else if (old.modifiedAt !== now.modifiedAt) {
      changes.push({ kind: 'modified', path, sizeBefore: old.size, sizeAfter: now.size, basis: 'timestamp' });
    }
  }
  for (const [path, item] of b) if (!a.has(path)) added.push(item);
  // Pair removals and additions that are the same file under a new name.
  const unmatched = new Set(added);
  for (const old of removed) {
    const match =
      [...unmatched].find((n) => old.sha256 && n.sha256 === old.sha256) ??
      [...unmatched].find((n) => !old.sha256 && old.size !== null && n.size === old.size && n.modifiedAt === old.modifiedAt);
    if (match) {
      unmatched.delete(match);
      changes.push({ kind: 'renamed', from: old.path, to: match.path, basis: old.sha256 ? 'content' : 'size-and-time' });
    } else {
      changes.push({ kind: 'removed', path: old.path, size: old.size });
    }
  }
  for (const item of unmatched) changes.push({ kind: 'added', path: item.path, size: item.size });
  const order = { added: 0, removed: 1, renamed: 2, modified: 3 };
  return changes.sort((x, y) => order[x.kind] - order[y.kind]);
}

// endregion
