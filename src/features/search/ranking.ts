/**
 * Filename match scoring. Matching is case- and accent-insensitive ("resume" finds "Résumé").
 * Higher scores rank first; ranges are [start, end) offsets into the original name for highlighting.
 */

export type NameMatch = {
  score: number;
  ranges: [number, number][];
  /** Human explanation shown under the result. */
  reason: string;
};

/** Lowercases and strips diacritics while keeping a 1:1 index map back to the original string. */
export function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    // Strip combining diacritical marks (U+0300–U+036F) after NFD decomposition.
    const base = (text[i] ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const char of base) {
      folded += char;
      map.push(i);
    }
  }
  return { folded, map };
}

export function fold(text: string): string {
  return foldWithMap(text).folded;
}

function tokenize(query: string): string[] {
  return fold(query)
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

function isWordStart(folded: string, index: number): boolean {
  if (index === 0) return true;
  const prev = folded[index - 1] ?? '';
  return /[\s_\-.()[\]]/.test(prev);
}

function toOriginalRange(map: number[], start: number, length: number): [number, number] {
  const first = map[start] ?? 0;
  const last = map[start + length - 1] ?? first;
  return [first, last + 1];
}

export function matchName(name: string, query: string): NameMatch | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const { folded, map } = foldWithMap(name);
  const whole = fold(trimmed);
  const dot = folded.lastIndexOf('.');
  const stem = dot > 0 ? folded.slice(0, dot) : folded;

  if (folded === whole || stem === whole) {
    return { score: 1000, ranges: [toOriginalRange(map, 0, whole.length)], reason: 'Exact file name' };
  }
  const index = folded.indexOf(whole);
  if (index === 0) {
    return { score: 800 - folded.length, ranges: [toOriginalRange(map, 0, whole.length)], reason: 'File name starts with your search' };
  }
  if (index > 0) {
    const wordStart = isWordStart(folded, index);
    return {
      score: (wordStart ? 600 : 400) - folded.length,
      ranges: [toOriginalRange(map, index, whole.length)],
      reason: 'File name contains your search',
    };
  }
  // Every word of the query appears somewhere in the name, in any order.
  const tokens = tokenize(trimmed);
  if (tokens.length < 2) return null;
  const ranges: [number, number][] = [];
  let wordStarts = 0;
  for (const token of tokens) {
    const at = folded.indexOf(token);
    if (at < 0) return null;
    if (isWordStart(folded, at)) wordStarts += 1;
    ranges.push(toOriginalRange(map, at, token.length));
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return { score: 200 + wordStarts * 20 - folded.length, ranges, reason: 'File name contains all words' };
}
