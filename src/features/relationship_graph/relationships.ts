import { create } from 'zustand';

import { extractText, extractionMethodFor } from '@/core/content/extract';
import { getDatabase } from '@/core/database/database';
import { categorize, mimeTypeFor } from '@/core/storage/fileTypes';
import { storage } from '@/core/storage/storage';
import type { FileCategory } from '@/core/storage/types';
import { getIndexedText } from '@/features/search/contentIndex';

import { identifiers, nameTokens, relate, type FileFeatures, type Reason } from './scoring';

export type GraphNode = {
  uri: string;
  parentUri: string;
  locationId: string | null;
  name: string;
  category: FileCategory;
  modifiedAt: number | null;
};

export type GraphEdge = { node: GraphNode; score: number; reasons: Reason[]; manual: boolean };

/** Graph navigation history survives leaving and returning to the screen. */
export const useGraphHistory = create<{ trail: GraphNode[]; push: (n: GraphNode) => void; back: () => void; reset: (n: GraphNode) => void }>()((set) => ({
  trail: [],
  push: (n) => set((s) => ({ trail: [...s.trail.filter((x) => x.uri !== n.uri), n].slice(-20) })),
  back: () => set((s) => ({ trail: s.trail.slice(0, -1) })),
  reset: (n) => set({ trail: [n] }),
}));

function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

const MAX_CANDIDATES = 150;
const MAX_EDGES = 12;

async function textFor(node: GraphNode, allowRead: boolean): Promise<string> {
  const indexed = await getIndexedText(node.uri);
  if (indexed) return indexed.text;
  if (!allowRead || !extractionMethodFor(node.name, mimeTypeFor(node.name))) return '';
  try {
    return (await extractText({ uri: node.uri, name: node.name, mimeType: mimeTypeFor(node.name), size: null }, { maxPdfPages: 3 })).text;
  } catch {
    return '';
  }
}

async function workspaceNames(uris: string[]): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (uris.length === 0) return map;
  const placeholders = uris.map(() => '?').join(',');
  const rows = await getDatabase().getAllAsync<{ uri: string; name: string }>(
    `SELECT i.uri AS uri, w.name AS name FROM workspace_items i JOIN workspaces w ON w.id = i.workspace_id WHERE i.uri IN (${placeholders})`,
    ...uris,
  );
  for (const row of rows) map.set(row.uri, (map.get(row.uri) ?? new Set()).add(row.name));
  return map;
}

/**
 * Finds files related to `center`, each with explained reasons. Candidates come from: manual links,
 * workspace co-members, documents in the content index that mention the same identifiers, and files
 * in the same folder. At most 12 are returned to keep the graph readable.
 */
export async function findRelated(center: GraphNode): Promise<GraphEdge[]> {
  const db = getDatabase();
  const candidates = new Map<string, GraphNode>();
  const add = (node: GraphNode) => {
    if (node.uri !== center.uri && candidates.size < MAX_CANDIDATES && !candidates.has(node.uri)) candidates.set(node.uri, node);
  };

  const links = await db.getAllAsync<{ a_uri: string; b_uri: string; kind: string; a_name: string; b_name: string; a_parent: string; b_parent: string; a_location: string | null; b_location: string | null }>(
    'SELECT * FROM relationships WHERE a_uri = ? OR b_uri = ?',
    center.uri,
    center.uri,
  );
  const manual = new Set<string>();
  const dismissed = new Set<string>();
  for (const link of links) {
    const otherIsB = link.a_uri === center.uri;
    const uri = otherIsB ? link.b_uri : link.a_uri;
    if (link.kind === 'dismissed') {
      dismissed.add(uri);
      continue;
    }
    manual.add(uri);
    const name = otherIsB ? link.b_name : link.a_name;
    add({ uri, name, parentUri: otherIsB ? link.b_parent : link.a_parent, locationId: otherIsB ? link.b_location : link.a_location, category: categorize(name, false, mimeTypeFor(name)), modifiedAt: null });
  }

  const coMembers = await db.getAllAsync<{ uri: string; name: string; parent_uri: string; location_id: string | null; is_directory: number }>(
    `SELECT DISTINCT i2.uri, i2.name, i2.parent_uri, i2.location_id, i2.is_directory FROM workspace_items i1
     JOIN workspace_items i2 ON i1.workspace_id = i2.workspace_id WHERE i1.uri = ? AND i2.uri != ?`,
    center.uri,
    center.uri,
  );
  coMembers.forEach((r) => add({ uri: r.uri, name: r.name, parentUri: r.parent_uri, locationId: r.location_id, category: categorize(r.name, r.is_directory === 1, mimeTypeFor(r.name)), modifiedAt: null }));

  const centerText = await textFor(center, true);
  const centerIds = identifiers(centerText);
  for (const id of [...centerIds].slice(0, 12)) {
    const rows = await db.getAllAsync<{ uri: string; name: string; parent_uri: string; location_id: string | null; modified_at: number | null }>(
      `SELECT c.uri, c.name, c.parent_uri, c.location_id, c.modified_at FROM content_fts f JOIN content_index c ON c.uri = f.uri
       WHERE content_fts MATCH ? LIMIT 20`,
      `"${id.replace(/"/g, '""')}"`,
    ).catch(() => []);
    rows.forEach((r) => add({ uri: r.uri, name: r.name, parentUri: r.parent_uri, locationId: r.location_id, category: categorize(r.name, false, mimeTypeFor(r.name)), modifiedAt: r.modified_at }));
  }

  if (center.parentUri) {
    const siblings = await storage.listChildren(center.parentUri).catch(() => []);
    siblings
      .filter((s) => !s.isDirectory)
      .slice(0, 300)
      .forEach((s) => add({ uri: s.uri, name: s.name, parentUri: center.parentUri, locationId: center.locationId, category: categorize(s.name, false, mimeTypeFor(s.name, s.mimeType)), modifiedAt: s.modifiedAt }));
  }

  const nodes = [...candidates.values()].filter((n) => !dismissed.has(n.uri));
  const workspaces = await workspaceNames([center.uri, ...nodes.map((n) => n.uri)]);
  const centerFeatures: FileFeatures = { uri: center.uri, name: center.name, parentUri: center.parentUri, modifiedAt: center.modifiedAt, nameTokens: nameTokens(center.name), identifiers: centerIds, workspaces: workspaces.get(center.uri) ?? new Set() };

  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    const text = await textFor(node, false);
    const features: FileFeatures = { uri: node.uri, name: node.name, parentUri: node.parentUri, modifiedAt: node.modifiedAt, nameTokens: nameTokens(node.name), identifiers: identifiers(text), workspaces: workspaces.get(node.uri) ?? new Set() };
    const isManual = manual.has(node.uri);
    const { score, reasons } = relate(centerFeatures, features, isManual);
    if (score >= 15) edges.push({ node, score, reasons, manual: isManual });
  }
  return edges.sort((a, b) => b.score - a.score).slice(0, MAX_EDGES);
}

async function upsert(a: GraphNode, b: GraphNode, kind: 'manual' | 'dismissed'): Promise<void> {
  const [first, second] = a.uri < b.uri ? [a, b] : [b, a];
  await getDatabase().runAsync(
    `INSERT OR REPLACE INTO relationships (a_uri, b_uri, kind, a_name, b_name, a_parent, b_parent, a_location, b_location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    first.uri,
    second.uri,
    kind,
    first.name,
    second.name,
    first.parentUri,
    second.parentUri,
    first.locationId,
    second.locationId,
    Date.now(),
  );
}

export const linkFiles = (a: GraphNode, b: GraphNode) => upsert(a, b, 'manual');
export const dismissSuggestion = (a: GraphNode, b: GraphNode) => upsert(a, b, 'dismissed');

export async function unlinkFiles(a: GraphNode, b: GraphNode): Promise<void> {
  const [x, y] = pair(a.uri, b.uri);
  await getDatabase().runAsync('DELETE FROM relationships WHERE a_uri = ? AND b_uri = ?', x, y);
}
