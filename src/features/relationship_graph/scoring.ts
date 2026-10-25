import { fold } from '@/features/search/ranking';

/**
 * Relationship scoring. Suggestions are evidence-based and every one carries its reasons; nothing is
 * presented as certain. Coincidental timestamps alone are never enough to suggest a relationship.
 */
export type FileFeatures = {
  uri: string;
  name: string;
  parentUri: string;
  modifiedAt: number | null;
  nameTokens: Set<string>;
  identifiers: Set<string>;
  workspaces: Set<string>;
};

export type Reason = { kind: 'manual' | 'workspace' | 'identifier' | 'name' | 'time'; text: string; weight: number };

const GENERIC = new Set([
  'img', 'image', 'photo', 'scan', 'scanned', 'document', 'doc', 'file', 'copy', 'final', 'new', 'old', 'draft', 'version', 'pdf', 'jpg', 'png',
  'screenshot', 'whatsapp', 'download', 'downloads', 'untitled', 'the', 'and', 'for', 'with', 'from', 'page', 'report', 'data',
]);

export function nameTokens(name: string): Set<string> {
  const stem = name.replace(/\.[^.]+$/, '');
  return new Set(
    fold(stem)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !GENERIC.has(t) && !/^\d+$/.test(t)),
  );
}

/** Distinctive identifiers: order/invoice/policy numbers and email addresses. */
export function identifiers(text: string, limit = 200): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z0-9][A-Z0-9/-]{4,24}[A-Z0-9]\b/gi)) {
    const token = match[0].toUpperCase();
    const digits = token.replace(/\D/g, '').length;
    // Needs several digits, and pure years or dates are too common to be meaningful.
    if (digits < 4 || /^(19|20)\d{2}$/.test(token) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(token)) continue;
    out.add(token);
    if (out.size >= limit) break;
  }
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
    out.add(match[0].toLowerCase());
    if (out.size >= limit) break;
  }
  return out;
}

const HOUR = 3_600_000;

export function relate(a: FileFeatures, b: FileFeatures, manual: boolean): { score: number; reasons: Reason[] } {
  const reasons: Reason[] = [];
  if (manual) reasons.push({ kind: 'manual', text: 'You linked these files', weight: 100 });
  const sharedWorkspaces = [...a.workspaces].filter((w) => b.workspaces.has(w));
  if (sharedWorkspaces.length) reasons.push({ kind: 'workspace', text: `Both are in the workspace “${sharedWorkspaces[0]}”`, weight: 40 });
  const sharedIds = [...a.identifiers].filter((id) => b.identifiers.has(id));
  if (sharedIds.length) reasons.push({ kind: 'identifier', text: `Both mention ${sharedIds.slice(0, 2).map((s) => `“${s}”`).join(' and ')}`, weight: 35 + Math.min(15, sharedIds.length * 5) });
  const sharedTokens = [...a.nameTokens].filter((t) => b.nameTokens.has(t));
  if (sharedTokens.length) reasons.push({ kind: 'name', text: `Names share “${sharedTokens.slice(0, 2).join('”, “')}”`, weight: 15 + Math.min(15, sharedTokens.length * 6) });
  if (a.modifiedAt !== null && b.modifiedAt !== null && a.parentUri === b.parentUri) {
    const gap = Math.abs(a.modifiedAt - b.modifiedAt);
    if (gap <= 48 * HOUR) {
      const hours = Math.max(1, Math.round(gap / HOUR));
      reasons.push({ kind: 'time', text: `Saved ${gap < HOUR ? 'within an hour' : `${hours} hours apart`} in the same folder`, weight: 8 });
    }
  }
  const score = reasons.reduce((s, r) => s + r.weight, 0);
  // Time proximity alone is coincidence, not evidence.
  const onlyTime = reasons.length === 1 && reasons[0]?.kind === 'time';
  return { score: onlyTime ? 0 : score, reasons };
}
