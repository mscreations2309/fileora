import { randomUUID } from 'expo-crypto';
import { FileoraStorage } from 'fileora-storage';

import { extractText, extractionMethodFor } from '@/core/content/extract';
import { getDatabase } from '@/core/database/database';
import { FileoraError } from '@/core/errors/FileoraError';
import { formatBytes, formatDateTime } from '@/core/format/format';
import { extensionOf, mimeTypeFor } from '@/core/storage/fileTypes';
import { storage } from '@/core/storage/storage';
import type { RawEntry } from '@/core/storage/types';
import { hammingDistance } from '@/features/storage_detective/analysis';

import { diffCsv, diffJson, diffLines, summarize, type CsvDiff, type DiffOp, type DiffSummary, type JsonChange } from './diff';

export type CompareSide = { uri: string; name: string; size: number | null; modifiedAt: number | null; sha256: string };

export type Comparison =
  | { kind: 'identical'; left: CompareSide; right: CompareSide }
  | { kind: 'text'; left: CompareSide; right: CompareSide; ops: DiffOp[]; summary: DiffSummary; note: string | null }
  | { kind: 'json'; left: CompareSide; right: CompareSide; changes: JsonChange[]; ops: DiffOp[] }
  | { kind: 'csv'; left: CompareSide; right: CompareSide; diff: CsvDiff }
  | { kind: 'image'; left: CompareSide; right: CompareSide; distance: number | null }
  | { kind: 'binary'; left: CompareSide; right: CompareSide };

const TEXT_LIMIT_LINES = 20_000;

async function side(entry: RawEntry): Promise<CompareSide> {
  return { uri: entry.uri, name: entry.name, size: entry.size, modifiedAt: entry.modifiedAt, sha256: await storage.hash(entry.uri) };
}

async function textOf(entry: RawEntry, maxPdfPages: number): Promise<{ text: string; ocr: boolean; truncated: boolean }> {
  const result = await extractText({ uri: entry.uri, name: entry.name, mimeType: mimeTypeFor(entry.name, entry.mimeType), size: entry.size }, { maxPdfPages });
  return { text: result.text, ocr: result.method === 'pdf-ocr' || result.method === 'image-ocr', truncated: result.truncated };
}

/** Compares two files by content. Equality is decided by SHA-256, never by timestamps. */
export async function compareFiles(leftUri: string, rightUri: string): Promise<Comparison> {
  const [leftRaw, rightRaw] = await Promise.all([storage.stat(leftUri), storage.stat(rightUri)]);
  if (!leftRaw || !rightRaw) throw new FileoraError('ERR_NOT_FOUND', 'One of the files is no longer available');
  if (leftRaw.isDirectory || rightRaw.isDirectory) throw new FileoraError('ERR_UNSUPPORTED', 'Use a folder snapshot to compare folders');
  const [left, right] = await Promise.all([side(leftRaw), side(rightRaw)]);
  let result: Comparison;
  if (left.sha256 === right.sha256) {
    result = { kind: 'identical', left, right };
  } else {
    const ext = extensionOf(leftRaw.name);
    const otherExt = extensionOf(rightRaw.name);
    const method = extractionMethodFor(leftRaw.name, mimeTypeFor(leftRaw.name, leftRaw.mimeType));
    const isImage = method === 'image-ocr';
    if (ext === 'json' && otherExt === 'json') {
      const [a, b] = await Promise.all([textOf(leftRaw, 0), textOf(rightRaw, 0)]);
      let changes: JsonChange[] = [];
      try {
        changes = diffJson(JSON.parse(a.text), JSON.parse(b.text));
      } catch {
        changes = [];
      }
      result = { kind: 'json', left, right, changes, ops: diffLines(a.text.split('\n').slice(0, TEXT_LIMIT_LINES), b.text.split('\n').slice(0, TEXT_LIMIT_LINES)) };
    } else if ((ext === 'csv' || ext === 'tsv') && (otherExt === 'csv' || otherExt === 'tsv')) {
      const [a, b] = await Promise.all([textOf(leftRaw, 0), textOf(rightRaw, 0)]);
      result = { kind: 'csv', left, right, diff: diffCsv(a.text, b.text) };
    } else if (isImage && FileoraStorage) {
      let distance: number | null = null;
      try {
        const [ha, hb] = await Promise.all([FileoraStorage.imageHash(leftRaw.uri), FileoraStorage.imageHash(rightRaw.uri)]);
        distance = hammingDistance(ha, hb);
      } catch {
        distance = null;
      }
      result = { kind: 'image', left, right, distance };
    } else if (method && !isImage) {
      const [a, b] = await Promise.all([textOf(leftRaw, 20), textOf(rightRaw, 20)]);
      const notes: string[] = [];
      if (a.ocr || b.ocr) notes.push('Text was read with on-device recognition, which can misread characters; small differences may be recognition errors.');
      if (a.truncated || b.truncated) notes.push('Only the first part of a long document was compared.');
      if (method === 'office') notes.push('Formatting, images and layout are not compared — only text.');
      const ops = diffLines(a.text.split('\n').slice(0, TEXT_LIMIT_LINES), b.text.split('\n').slice(0, TEXT_LIMIT_LINES));
      result = { kind: 'text', left, right, ops, summary: summarize(ops), note: notes.join(' ') || null };
    } else {
      result = { kind: 'binary', left, right };
    }
  }
  await recordComparison(result);
  return result;
}

export function describeComparison(c: Comparison): string {
  switch (c.kind) {
    case 'identical':
      return 'Identical content';
    case 'text':
      return c.summary.added + c.summary.removed === 0 ? 'Same text, different file data' : `${c.summary.added} lines added, ${c.summary.removed} removed`;
    case 'json':
      return `${c.changes.length} value${c.changes.length === 1 ? '' : 's'} changed`;
    case 'csv':
      return `${c.diff.changedCells.length} cells changed, ${c.diff.addedRows.length} rows added, ${c.diff.removedRows.length} removed`;
    case 'image':
      return c.distance === null ? 'Different images' : c.distance <= 5 ? 'Visually almost identical' : c.distance <= 12 ? 'Visually similar' : 'Visually different';
    case 'binary':
      return 'Different content';
  }
}

async function recordComparison(c: Comparison): Promise<void> {
  await getDatabase().runAsync(
    'INSERT INTO comparisons (id, kind, left_name, right_name, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    randomUUID(),
    c.kind,
    c.left.name,
    c.right.name,
    describeComparison(c),
    Date.now(),
  );
}

export async function recentComparisons(limit = 20): Promise<{ id: string; kind: string; leftName: string; rightName: string; summary: string; createdAt: number }[]> {
  const rows = await getDatabase().getAllAsync<{ id: string; kind: string; left_name: string; right_name: string; summary: string; created_at: number }>('SELECT * FROM comparisons ORDER BY created_at DESC LIMIT ?', limit);
  return rows.map((r) => ({ id: r.id, kind: r.kind, leftName: r.left_name, rightName: r.right_name, summary: r.summary, createdAt: r.created_at }));
}

/** Plain-text report for sharing. */
export function comparisonReport(c: Comparison): string {
  const lines = [
    'Fileora change report',
    `Generated: ${formatDateTime(Date.now())}`,
    '',
    `Before: ${c.left.name} · ${formatBytes(c.left.size)} · modified ${formatDateTime(c.left.modifiedAt)} · SHA-256 ${c.left.sha256}`,
    `After:  ${c.right.name} · ${formatBytes(c.right.size)} · modified ${formatDateTime(c.right.modifiedAt)} · SHA-256 ${c.right.sha256}`,
    '',
    `Result: ${describeComparison(c)}`,
    '',
  ];
  if (c.kind === 'text' || c.kind === 'json') {
    if (c.kind === 'json') for (const change of c.changes) lines.push(`${change.kind.toUpperCase()} ${change.path}: ${JSON.stringify(change.before) ?? ''} -> ${JSON.stringify(change.after) ?? ''}`);
    else if (c.note) lines.push(`Note: ${c.note}`, '');
    if (c.kind === 'text') for (const op of c.ops) if (op.type !== 'equal') lines.push(`${op.type === 'add' ? '+' : '-'} ${op.type === 'add' ? op.right : op.left}: ${op.text}`);
  } else if (c.kind === 'csv') {
    for (const cell of c.diff.changedCells) lines.push(`${cell.cell}${cell.header ? ` (${cell.header})` : ''}: "${cell.before}" -> "${cell.after}"`);
    if (c.diff.addedRows.length) lines.push(`Rows added: ${c.diff.addedRows.join(', ')}`);
    if (c.diff.removedRows.length) lines.push(`Rows removed: ${c.diff.removedRows.join(', ')}`);
  }
  return lines.join('\n');
}
