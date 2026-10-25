import type { FileCategory } from '@/core/storage/types';

import { fold } from './ranking';

/**
 * Turns a natural-language request ("PDFs mentioning payment due last month") into search terms,
 * related words and filters. This is deterministic, on-device query understanding — not a language
 * model — and every interpretation is surfaced to the user so nothing is a hidden guess.
 */
export type ParsedQuery = {
  original: string;
  terms: string[];
  /** Related words used to find approximate matches, per term. */
  related: Record<string, string[]>;
  categories: FileCategory[];
  extensions: string[];
  modifiedAfter: number | null;
  modifiedBefore: number | null;
  /** "latest version of …": prefer the most recently modified match. */
  preferLatest: boolean;
  /** Plain-language description of each interpretation, e.g. "Only PDF files". */
  interpretations: string[];
};

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'about', 'from', 'my', 'me', 'i',
  'find', 'show', 'get', 'search', 'look', 'looking', 'where', 'is', 'are', 'was', 'that', 'which', 'any', 'all',
  'file', 'files', 'mentioning', 'mention', 'mentions', 'containing', 'contains', 'contain', 'related', 'regarding',
  'modified', 'changed', 'edited', 'created', 'made', 'saved', 'have', 'has', 'had', 'did', 'do', 'it', 'its', 'some',
  'version', 'copy',
]);

const TYPE_WORDS: Record<string, { categories?: FileCategory[]; extensions?: string[]; label: string; keepTerm?: boolean }> = {
  pdf: { extensions: ['pdf'], label: 'PDF files' },
  pdfs: { extensions: ['pdf'], label: 'PDF files' },
  screenshot: { categories: ['image'], label: 'Images', keepTerm: true },
  screenshots: { categories: ['image'], label: 'Images', keepTerm: true },
  photo: { categories: ['image'], label: 'Images' },
  photos: { categories: ['image'], label: 'Images' },
  image: { categories: ['image'], label: 'Images' },
  images: { categories: ['image'], label: 'Images' },
  picture: { categories: ['image'], label: 'Images' },
  pictures: { categories: ['image'], label: 'Images' },
  scan: { categories: ['image', 'document'], label: 'Scans and documents' },
  scans: { categories: ['image', 'document'], label: 'Scans and documents' },
  video: { categories: ['video'], label: 'Videos' },
  videos: { categories: ['video'], label: 'Videos' },
  song: { categories: ['audio'], label: 'Audio' },
  songs: { categories: ['audio'], label: 'Audio' },
  audio: { categories: ['audio'], label: 'Audio' },
  document: { categories: ['document'], label: 'Documents' },
  documents: { categories: ['document'], label: 'Documents' },
  doc: { categories: ['document'], label: 'Documents' },
  docs: { categories: ['document'], label: 'Documents' },
  spreadsheet: { extensions: ['xlsx', 'xls', 'csv', 'ods'], label: 'Spreadsheets' },
  spreadsheets: { extensions: ['xlsx', 'xls', 'csv', 'ods'], label: 'Spreadsheets' },
  excel: { extensions: ['xlsx', 'xls'], label: 'Spreadsheets' },
  presentation: { extensions: ['pptx', 'ppt', 'odp', 'key'], label: 'Presentations' },
  presentations: { extensions: ['pptx', 'ppt', 'odp', 'key'], label: 'Presentations' },
  archive: { categories: ['archive'], label: 'Archives' },
  archives: { categories: ['archive'], label: 'Archives' },
  zip: { categories: ['archive'], label: 'Archives' },
};

/** Related words for common personal-document topics. Matches through these are labelled approximate. */
const RELATED_WORDS: Record<string, string[]> = {
  invoice: ['bill', 'receipt', 'tax invoice', 'gst'],
  bill: ['invoice', 'receipt', 'amount due'],
  receipt: ['invoice', 'bill', 'payment', 'paid'],
  payment: ['paid', 'pay', 'amount', 'transaction'],
  due: ['due date', 'payable', 'deadline'],
  car: ['vehicle', 'automobile', 'motor', 'registration'],
  vehicle: ['car', 'automobile', 'motor'],
  laptop: ['notebook', 'computer', 'macbook', 'thinkpad'],
  phone: ['mobile', 'smartphone', 'iphone'],
  insurance: ['policy', 'premium', 'insured', 'cover'],
  policy: ['insurance', 'premium'],
  warranty: ['guarantee', 'warranty card'],
  contract: ['agreement', 'terms'],
  agreement: ['contract'],
  proposal: ['quote', 'quotation', 'estimate', 'pitch'],
  order: ['order number', 'order id', 'purchase'],
  tax: ['gst', 'itr', 'income tax', 'vat'],
  identity: ['passport', 'aadhaar', 'license', 'pan card'],
  passport: ['visa', 'identity'],
  resume: ['cv', 'curriculum vitae'],
  cv: ['resume'],
  salary: ['payslip', 'payroll', 'compensation'],
  bank: ['statement', 'account'],
  rent: ['lease', 'rental', 'tenancy'],
  medical: ['prescription', 'hospital', 'clinic', 'report'],
  ticket: ['boarding pass', 'booking', 'itinerary', 'pnr'],
  travel: ['ticket', 'booking', 'itinerary', 'hotel', 'flight'],
  purchase: ['order', 'invoice', 'receipt'],
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

type DateRange = { after: number; before: number | null; label: string };

function dateRange(words: string[], now: Date): { range: DateRange | null; consumed: Set<number> } {
  const consumed = new Set<number>();
  const today = startOfDay(now);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const next = words[i + 1];
    const mark = (...indexes: number[]) => indexes.forEach((index) => consumed.add(index));
    if (word === 'today') {
      mark(i);
      return { range: { after: today.getTime(), before: null, label: 'Modified today' }, consumed };
    }
    if (word === 'yesterday') {
      mark(i);
      const start = new Date(today);
      start.setDate(start.getDate() - 1);
      return { range: { after: start.getTime(), before: today.getTime(), label: 'Modified yesterday' }, consumed };
    }
    if ((word === 'this' || word === 'last' || word === 'past') && next && ['week', 'month', 'year'].includes(next)) {
      mark(i, i + 1);
      const unit = next as 'week' | 'month' | 'year';
      if (word === 'this') {
        const start = unit === 'week' ? new Date(today.getTime() - today.getDay() * 86_400_000) : unit === 'month' ? new Date(today.getFullYear(), today.getMonth(), 1) : new Date(today.getFullYear(), 0, 1);
        return { range: { after: start.getTime(), before: null, label: `Modified this ${unit}` }, consumed };
      }
      if (word === 'past') {
        const days = unit === 'week' ? 7 : unit === 'month' ? 30 : 365;
        return { range: { after: today.getTime() - days * 86_400_000, before: null, label: `Modified in the past ${unit}` }, consumed };
      }
      if (unit === 'week') {
        const thisWeek = new Date(today.getTime() - today.getDay() * 86_400_000);
        return { range: { after: thisWeek.getTime() - 7 * 86_400_000, before: thisWeek.getTime(), label: 'Modified last week' }, consumed };
      }
      if (unit === 'month') {
        const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const end = new Date(today.getFullYear(), today.getMonth(), 1);
        return { range: { after: start.getTime(), before: end.getTime(), label: 'Modified last month' }, consumed };
      }
      const start = new Date(today.getFullYear() - 1, 0, 1);
      const end = new Date(today.getFullYear(), 0, 1);
      return { range: { after: start.getTime(), before: end.getTime(), label: 'Modified last year' }, consumed };
    }
    const month = word ? MONTHS.indexOf(word) : -1;
    if (month >= 0) {
      mark(i);
      const yearWord = next && /^\d{4}$/.test(next) ? Number(next) : null;
      if (yearWord !== null) mark(i + 1);
      const year = yearWord ?? (month <= today.getMonth() ? today.getFullYear() : today.getFullYear() - 1);
      const start = new Date(year, month, 1);
      return { range: { after: start.getTime(), before: new Date(year, month + 1, 1).getTime(), label: `Modified in ${MONTHS[month]} ${year}` }, consumed };
    }
    if (word && /^(19|20)\d{2}$/.test(word) && (words[i - 1] === 'in' || words[i - 1] === 'from' || words[i - 1] === 'during')) {
      mark(i);
      const year = Number(word);
      return { range: { after: new Date(year, 0, 1).getTime(), before: new Date(year + 1, 0, 1).getTime(), label: `Modified in ${year}` }, consumed };
    }
  }
  return { range: null, consumed };
}

export function parseQuery(input: string, now: Date = new Date()): ParsedQuery {
  const words = fold(input)
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter(Boolean);
  const { range, consumed } = dateRange(words, now);
  const categories = new Set<FileCategory>();
  const extensions = new Set<string>();
  const interpretations: string[] = [];
  const terms: string[] = [];
  let preferLatest = false;
  for (const [index, word] of words.entries()) {
    if (consumed.has(index)) continue;
    if (word === 'latest' || word === 'newest' || word === 'recent' || word === 'last') {
      preferLatest = true;
      continue;
    }
    const type = TYPE_WORDS[word];
    if (type) {
      type.categories?.forEach((c) => categories.add(c));
      type.extensions?.forEach((e) => extensions.add(e));
      if (!interpretations.includes(`Only ${type.label.toLowerCase()}`)) interpretations.push(`Only ${type.label.toLowerCase()}`);
      if (type.keepTerm) terms.push(word.replace(/s$/, ''));
      continue;
    }
    if (STOP_WORDS.has(word) || word.length < 2) continue;
    if (!terms.includes(word)) terms.push(word);
  }
  if (range) interpretations.push(range.label);
  if (preferLatest) interpretations.push('Newest first');
  const related: Record<string, string[]> = {};
  for (const term of terms) {
    const base = RELATED_WORDS[term] ?? RELATED_WORDS[term.replace(/s$/, '')];
    if (base) related[term] = base;
  }
  return {
    original: input,
    terms,
    related,
    categories: [...categories],
    extensions: [...extensions],
    modifiedAfter: range?.after ?? null,
    modifiedBefore: range?.before ?? null,
    preferLatest,
    interpretations,
  };
}

function quote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * FTS5 query: every term must match (exact prefix or one of its related words). Exact-only variant
 * is used first so precise matches rank above approximate ones.
 */
export function toFtsQuery(parsed: ParsedQuery, includeRelated: boolean): string | null {
  if (parsed.terms.length === 0) return null;
  return parsed.terms
    .map((term) => {
      const options = [`${quote(term)}*`];
      if (includeRelated) for (const word of parsed.related[term] ?? []) options.push(quote(word));
      return options.length === 1 ? options[0] : `(${options.join(' OR ')})`;
    })
    .join(' AND ');
}

/** Explains why a document matched, separating exact matches from related-word matches. */
export function explainMatch(parsed: ParsedQuery, haystack: string): { exact: string[]; related: string[] } {
  const text = fold(haystack);
  const exact: string[] = [];
  const related: string[] = [];
  for (const term of parsed.terms) {
    if (text.includes(term)) {
      exact.push(term);
      continue;
    }
    const hit = (parsed.related[term] ?? []).find((word) => text.includes(word));
    if (hit) related.push(hit);
  }
  return { exact, related };
}
