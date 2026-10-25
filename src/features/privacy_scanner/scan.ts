import { File, FileMode } from 'expo-file-system';
import { FileoraStorage } from 'fileora-storage';

import { extractText, extractionMethodFor, type Extraction, type ExtractionMethod } from '@/core/content/extract';
import { getDatabase } from '@/core/database/database';
import { FileoraError, toFileoraError } from '@/core/errors/FileoraError';
import { fromBase64, toBase64, utf8 } from '@/core/security/bytes';
import { extensionOf } from '@/core/storage/fileTypes';
import { storage } from '@/core/storage/storage';
import type { RawEntry } from '@/core/storage/types';
import { stableId } from '@/core/storage/uri';
import { nameKey, splitName, uniqueName } from '@/features/file_operations/conflicts';

import { detectInText, lineOf, maskValue, redactText, type Confidence, type FindingCategory } from './detectors';
import { readExif } from './exif';

export type PrivacyFinding = {
  key: string;
  category: FindingCategory;
  label: string;
  confidence: Confidence;
  explanation: string;
  location: string;
  preview: string;
  suggestion: string;
  source: 'text' | 'ocr' | 'metadata' | 'structure';
  start?: number;
  end?: number;
};

export type PrivacyReport = {
  file: { uri: string; parentUri: string; name: string; mimeType: string | null };
  findings: PrivacyFinding[];
  dismissedCount: number;
  checked: string[];
  limitations: string[];
  method: ExtractionMethod | null;
  canRedactText: boolean;
  canStripMetadata: boolean;
  text: string | null;
};

const SUGGESTIONS: Record<FindingCategory, string> = {
  'payment-card': 'Remove or mask the card number before sharing.',
  'national-id': 'Share identity numbers only with people who need them.',
  'tax-id': 'Share tax IDs only with people who need them.',
  bank: 'Check that the recipient needs your bank details.',
  email: 'Make sure you are comfortable sharing this address.',
  phone: 'Make sure you are comfortable sharing this number.',
  secret: 'Never share secrets. Change the password or key if it was already shared.',
  'date-of-birth': 'Dates of birth help identity theft; share only if needed.',
  'ip-address': 'Usually harmless, but can reveal network details.',
  location: 'Save a copy without metadata before sharing.',
  metadata: 'Remove document properties before sharing if names should stay private.',
  'hidden-content': 'Review hidden or tracked content before sharing.',
};

const PDF_PAGES = 20;

async function readHead(uri: string, length: number): Promise<Uint8Array> {
  if (FileoraStorage) return fromBase64(await FileoraStorage.readBytes(uri, 0, length));
  const handle = new File(uri).open(FileMode.ReadOnly);
  try {
    return handle.readBytesSync(length);
  } finally {
    handle.close();
  }
}

function textFindings(extraction: Extraction): PrivacyFinding[] {
  const source = extraction.method === 'pdf-ocr' || extraction.method === 'image-ocr' ? 'ocr' : 'text';
  return detectInText(extraction.text).map((f) => ({
    key: `${f.category}:${stableId('v', f.value)}`,
    category: f.category,
    label: f.label,
    confidence: source === 'ocr' && f.confidence === 'high' ? 'medium' : f.confidence,
    explanation: source === 'ocr' ? `${f.explanation} Found by text recognition, which can misread characters.` : f.explanation,
    location: extraction.method === 'text' ? `Line ${lineOf(extraction.text, f.start)}` : extraction.method === 'pdf-ocr' ? 'Page text' : extraction.method === 'image-ocr' ? 'Text in image' : 'Document text',
    preview: maskValue(f.value),
    suggestion: SUGGESTIONS[f.category],
    source,
    start: f.start,
    end: f.end,
  }));
}

/** Scans one file. Nothing leaves the device; the original is never modified. */
export async function scanForPrivacy(file: { uri: string; parentUri: string; name: string; mimeType: string | null; size: number | null }): Promise<PrivacyReport> {
  const findings: PrivacyFinding[] = [];
  const checked: string[] = [];
  const limitations = ['Detection looks for known patterns. It cannot find every kind of personal information.'];
  const method = extractionMethodFor(file.name, file.mimeType);
  let extraction: Extraction | null = null;
  const ext = extensionOf(file.name);

  if (method) {
    try {
      extraction = await extractText(file, { maxPdfPages: PDF_PAGES });
      checked.push(
        method === 'image-ocr' ? 'Text in the image (on-device recognition)' : method === 'pdf-ocr' ? `Text on ${extraction.pagesRead ?? 0} of ${extraction.pageCount ?? 0} pages (on-device recognition)` : 'Document text',
      );
      if (method === 'pdf-ocr' || method === 'image-ocr') limitations.push('Text recognition can miss or misread small, handwritten or low-contrast text.');
      if (extraction.truncated) limitations.push(method === 'pdf-ocr' ? `Only the first ${PDF_PAGES} pages were checked.` : 'Only the beginning of this large file was checked.');
      findings.push(...textFindings(extraction));
    } catch (error) {
      const failure = toFileoraError(error);
      limitations.push(failure.code === 'ERR_UNSUPPORTED' ? `The content could not be read: ${failure.message}.` : 'The content could not be read.');
    }
  } else {
    limitations.push('Fileora cannot read the content of this file type.');
  }

  const office = extraction?.office;
  if (office) {
    checked.push('Document properties', 'Hidden sheets, tracked changes and comments');
    const people = [office.metadata.creator, office.metadata.lastModifiedBy].filter((v): v is string => Boolean(v));
    for (const person of new Set(people)) {
      findings.push({ key: `metadata:author:${stableId('v', person)}`, category: 'metadata', label: 'Author name in document properties', confidence: 'high', explanation: `The file records “${person}” as an author or last editor.`, location: 'Document properties', preview: person, suggestion: SUGGESTIONS.metadata, source: 'metadata' });
    }
    if (office.metadata.Company) {
      findings.push({ key: `metadata:company`, category: 'metadata', label: 'Company name in document properties', confidence: 'high', explanation: `The file records the organisation “${office.metadata.Company}”.`, location: 'Document properties', preview: office.metadata.Company, suggestion: SUGGESTIONS.metadata, source: 'metadata' });
    }
    if (office.hiddenSheets.length) {
      findings.push({ key: 'hidden:sheets', category: 'hidden-content', label: `${office.hiddenSheets.length} hidden ${office.hiddenSheets.length === 1 ? 'sheet' : 'sheets'}`, confidence: 'high', explanation: `Hidden sheets (${office.hiddenSheets.join(', ')}) are invisible in normal view but anyone can unhide them.`, location: 'Workbook structure', preview: office.hiddenSheets.join(', '), suggestion: SUGGESTIONS['hidden-content'], source: 'structure' });
    }
    if (office.trackedInsertions + office.trackedDeletions > 0) {
      findings.push({ key: 'hidden:tracked', category: 'hidden-content', label: 'Tracked changes', confidence: 'high', explanation: `${office.trackedInsertions} insertions and ${office.trackedDeletions} deletions are still recorded. Deleted text can be recovered by the recipient.`, location: 'Document revisions', preview: `${office.trackedInsertions + office.trackedDeletions} changes`, suggestion: 'Accept or reject all changes before sharing.', source: 'structure' });
    }
    if (office.comments > 0) {
      findings.push({ key: 'hidden:comments', category: 'hidden-content', label: 'Comments', confidence: 'high', explanation: `${office.comments} comments are stored in the document.`, location: 'Document comments', preview: `${office.comments} comments`, suggestion: 'Delete comments that should not be shared.', source: 'structure' });
    }
  }

  let canStripMetadata = false;
  if (ext === 'jpg' || ext === 'jpeg') {
    try {
      const exif = readExif(await readHead(file.uri, 256 * 1024));
      checked.push('Photo metadata (EXIF)');
      if (exif) {
        if (exif.latitude !== undefined && exif.longitude !== undefined) {
          findings.push({ key: 'location:gps', category: 'location', label: 'GPS location', confidence: 'high', explanation: `The photo records where it was taken (${exif.latitude}, ${exif.longitude}).`, location: 'Photo metadata', preview: `${exif.latitude}, ${exif.longitude}`, suggestion: SUGGESTIONS.location, source: 'metadata' });
        }
        const device = [exif.make, exif.model].filter(Boolean).join(' ');
        if (device) findings.push({ key: 'metadata:device', category: 'metadata', label: 'Camera or phone model', confidence: 'high', explanation: `The photo records the device “${device}”.`, location: 'Photo metadata', preview: device, suggestion: SUGGESTIONS.location, source: 'metadata' });
        if (exif.artist) findings.push({ key: 'metadata:artist', category: 'metadata', label: 'Author name in photo', confidence: 'high', explanation: `The photo records “${exif.artist}” as its author.`, location: 'Photo metadata', preview: exif.artist, suggestion: SUGGESTIONS.location, source: 'metadata' });
        if (exif.dateTaken) findings.push({ key: 'metadata:date', category: 'metadata', label: 'Date and time taken', confidence: 'medium', explanation: `The photo records when it was taken (${exif.dateTaken}).`, location: 'Photo metadata', preview: exif.dateTaken, suggestion: SUGGESTIONS.location, source: 'metadata' });
        canStripMetadata = Boolean(FileoraStorage) && (findings.some((f) => f.source === 'metadata') || exif.otherBlocks.length > 0);
      }
    } catch {
      limitations.push('Photo metadata could not be read.');
    }
  }

  const dismissed = new Set(
    (await getDatabase().getAllAsync<{ finding_key: string }>('SELECT finding_key FROM privacy_dismissals WHERE uri = ?', file.uri)).map((r) => r.finding_key),
  );
  const visible = findings.filter((f) => !dismissed.has(f.key));
  const rank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  visible.sort((a, b) => rank[a.confidence] - rank[b.confidence]);

  return {
    file: { uri: file.uri, parentUri: file.parentUri, name: file.name, mimeType: file.mimeType },
    findings: visible,
    dismissedCount: findings.length - visible.length,
    checked,
    limitations,
    method,
    canRedactText: method === 'text' && extraction !== null && !extraction.truncated && Boolean(file.parentUri),
    canStripMetadata: canStripMetadata && Boolean(file.parentUri),
    text: method === 'text' ? (extraction?.text ?? null) : null,
  };
}

export async function dismissFinding(uri: string, key: string): Promise<void> {
  await getDatabase().runAsync('INSERT OR REPLACE INTO privacy_dismissals (uri, finding_key, created_at) VALUES (?, ?, ?)', uri, key, Date.now());
}

export async function restoreDismissed(uri: string): Promise<void> {
  await getDatabase().runAsync('DELETE FROM privacy_dismissals WHERE uri = ?', uri);
}

async function freeName(parentUri: string, desired: string): Promise<string> {
  const children = await storage.listChildren(parentUri);
  return uniqueName(desired, false, new Set(children.map((c) => nameKey(c.name))));
}

/**
 * Writes "<name> (redacted).<ext>" next to the original with the chosen values replaced, then reads
 * it back and verifies none of the redacted values remain. The original is not modified.
 */
export async function saveRedactedCopy(report: PrivacyReport, keys: Set<string>): Promise<RawEntry> {
  if (!report.canRedactText || report.text === null || !FileoraStorage) {
    throw new FileoraError('ERR_UNSUPPORTED', 'Redaction is only available for plain-text files');
  }
  const chosen = report.findings.filter((f) => keys.has(f.key) && f.start !== undefined && f.end !== undefined);
  if (chosen.length === 0) throw new FileoraError('ERR_UNSUPPORTED', 'Select at least one finding to redact');
  const text = report.text;
  const values = chosen.map((f) => text.slice(f.start, f.end));
  // Redact every occurrence of each chosen value, not only the first one detected.
  const ranges: { start: number; end: number }[] = [];
  for (const value of new Set(values)) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(value, from);
      if (at < 0) break;
      ranges.push({ start: at, end: at + value.length });
      from = at + value.length;
    }
  }
  const merged = ranges.sort((a, b) => a.start - b.start).filter((r, i, all) => i === 0 || r.start >= (all[i - 1]?.end ?? 0));
  const redacted = redactText(text, merged);
  const { base, extension } = splitName(report.file.name, false);
  const name = await freeName(report.file.parentUri, `${base} (redacted)${extension}`);
  const entry = await FileoraStorage.writeFile(report.file.parentUri, name, toBase64(utf8(redacted)), report.file.mimeType);
  const written = await FileoraStorage.readText(entry.uri, redacted.length * 4 + 16);
  if (values.some((value) => written.text.includes(value))) {
    await storage.delete(entry.uri).catch(() => undefined);
    throw new FileoraError('ERR_VERIFICATION_FAILED', 'The redacted copy still contained selected values, so it was deleted');
  }
  return entry;
}

/** Writes "<name> (no metadata).jpg" without EXIF/XMP/IPTC and verifies the result. */
export async function saveImageWithoutMetadata(report: PrivacyReport): Promise<RawEntry & { removedSegments: number }> {
  if (!report.canStripMetadata || !FileoraStorage) throw new FileoraError('ERR_UNSUPPORTED', 'Metadata removal is only available for JPEG photos');
  const { base, extension } = splitName(report.file.name, false);
  const name = await freeName(report.file.parentUri, `${base} (no metadata)${extension}`);
  const entry = await FileoraStorage.stripJpegMetadata(report.file.uri, report.file.parentUri, name);
  const check = readExif(await readHead(entry.uri, 256 * 1024));
  if (!check || check.make || check.model || check.latitude !== undefined || check.artist || check.dateTaken || check.otherBlocks.length) {
    await storage.delete(entry.uri).catch(() => undefined);
    throw new FileoraError('ERR_VERIFICATION_FAILED', 'Metadata was still present in the copy, so it was deleted');
  }
  return entry;
}
