/**
 * Finds dates in document text and classifies what each date means from the words around it.
 * Results are always suggestions for the user to confirm: OCR can misread digits and documents can
 * be ambiguous, so nothing here is presented as a fact.
 */
export type DateKind = 'expiry' | 'issue' | 'payment' | 'start' | 'birth' | 'created' | 'unknown';
export type DateConfidence = 'high' | 'medium' | 'low';

export type FoundDate = {
  /** ISO calendar date, YYYY-MM-DD, with no time zone (a calendar day where the document is read). */
  date: string;
  kind: DateKind;
  confidence: DateConfidence;
  /** The text the date was read from, with some context, for the user to verify. */
  source: string;
  /** Present when the digits could also be read the other way round (03/04 = 3 April or 4 March). */
  alternative: string | null;
  index: number;
};

export type DocumentCategory = 'insurance' | 'warranty' | 'certificate' | 'contract' | 'identification' | 'permit' | 'subscription' | 'other';

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const KIND_KEYWORDS: { kind: DateKind; words: RegExp }[] = [
  { kind: 'expiry', words: /(expir\w*(?:\s+(?:on|date))?|valid\s+(?:until|till|upto|up\s+to|thru|through)|renewal\s+(?:date|due)|due\s+for\s+renewal|end\s+date|policy\s+end|ends?\s+on|valid\s+to|date\s+of\s+expiry|best\s+before|use\s+by)\W*$/i },
  { kind: 'payment', words: /(payment\s+due|due\s+date|pay\s+by|amount\s+due|bill\s+due|last\s+date\s+(?:of|for)\s+payment)\W*$/i },
  { kind: 'issue', words: /(issued?(?:\s+on)?|date\s+of\s+issue|issue\s+date|invoice\s+date|dated|purchase\s+date|date\s+of\s+purchase)\W*$/i },
  { kind: 'start', words: /(valid\s+from|start\s+date|commencement|effective\s+(?:from|date)|starts?\s+on|policy\s+start|from)\W*$/i },
  { kind: 'birth', words: /(d\.?o\.?b\.?|date\s+of\s+birth|born(?:\s+on)?)\W*$/i },
  { kind: 'created', words: /(created|printed|generated|downloaded|last\s+updated|modified)(?:\s+on)?\W*$/i },
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function iso(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return null;
  const days = new Date(year, month, 0).getDate();
  if (day > days) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function fullYear(y: number): number {
  return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y;
}

const PATTERNS: { regex: RegExp; parse: (m: RegExpExecArray) => { date: string | null; alternative: string | null; ambiguous: boolean } }[] = [
  // 2027-01-31
  { regex: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, parse: (m) => ({ date: iso(Number(m[1]), Number(m[2]), Number(m[3])), alternative: null, ambiguous: false }) },
  // 14/10/2029, 14-10-29, 14.10.2029 (day first, as on Indian and European documents)
  {
    regex: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g,
    parse: (m) => {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const year = fullYear(Number(m[3]));
      const dayFirst = iso(year, b, a);
      const monthFirst = iso(year, a, b);
      if (dayFirst && monthFirst && a !== b) return { date: dayFirst, alternative: monthFirst, ambiguous: true };
      return { date: dayFirst ?? monthFirst, alternative: null, ambiguous: false };
    },
  },
  // 15 November 2026, 15th Nov, 2026
  {
    regex: /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g,
    parse: (m) => {
      const month = MONTHS[(m[2] ?? '').toLowerCase()];
      return { date: month ? iso(Number(m[3]), month, Number(m[1])) : null, alternative: null, ambiguous: false };
    },
  },
  // November 15, 2026 / Nov 15 2026
  {
    regex: /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g,
    parse: (m) => {
      const month = MONTHS[(m[1] ?? '').toLowerCase()];
      return { date: month ? iso(Number(m[3]), month, Number(m[2])) : null, alternative: null, ambiguous: false };
    },
  },
];

function classify(text: string, index: number): { kind: DateKind; strong: boolean } {
  const before = text.slice(Math.max(0, index - 48), index);
  const line = before.slice(before.lastIndexOf('\n') + 1);
  for (const { kind, words } of KIND_KEYWORDS) {
    if (words.test(line)) return { kind, strong: true };
  }
  // A keyword a little further back on the same line is weaker evidence.
  for (const { kind, words } of KIND_KEYWORDS) {
    const loose = new RegExp(words.source.replace(/\\W\*\$$/, ''), 'i');
    if (loose.test(line)) return { kind, strong: false };
  }
  return { kind: 'unknown', strong: false };
}

export function findDates(text: string, maxDates = 50): FoundDate[] {
  const found: FoundDate[] = [];
  const taken: [number, number][] = [];
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (taken.some(([s, e]) => start < e && s < end)) continue;
      const parsed = pattern.parse(match);
      if (!parsed.date) continue;
      taken.push([start, end]);
      const { kind, strong } = classify(text, start);
      const confidence: DateConfidence = parsed.ambiguous ? 'low' : strong ? 'high' : kind === 'unknown' ? 'low' : 'medium';
      const sourceStart = Math.max(0, text.lastIndexOf('\n', start - 1) + 1, start - 60);
      const lineEnd = text.indexOf('\n', end);
      const source = text.slice(sourceStart, lineEnd < 0 ? Math.min(text.length, end + 40) : Math.min(lineEnd, end + 40)).trim();
      found.push({ date: parsed.date, kind, confidence, source, alternative: parsed.alternative, index: start });
      if (found.length >= maxDates) return found.sort((a, b) => a.index - b.index);
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Expiry candidates only; issue, payment, start, birth and creation dates are never reported as expiry. */
export function expiryCandidates(text: string): FoundDate[] {
  return findDates(text).filter((d) => d.kind === 'expiry');
}

const CATEGORY_WORDS: { category: DocumentCategory; words: RegExp }[] = [
  { category: 'insurance', words: /\b(insurance|insured|policy\s+(?:no|number)|premium|insurer)\b/i },
  { category: 'warranty', words: /\b(warranty|guarantee)\b/i },
  { category: 'identification', words: /\b(passport|driving\s+licen[cs]e|aadhaar|identity\s+card|visa|voter\s+id)\b/i },
  { category: 'certificate', words: /\b(certificate|certification|certified)\b/i },
  { category: 'permit', words: /\b(permit|licen[cs]e|registration\s+certificate|puc|pollution)\b/i },
  { category: 'contract', words: /\b(agreement|contract|lease|tenancy)\b/i },
  { category: 'subscription', words: /\b(subscription|membership|service\s+plan|renewal)\b/i },
];

export function suggestCategory(text: string, name: string): DocumentCategory {
  const haystack = `${name}\n${text.slice(0, 4000)}`;
  return CATEGORY_WORDS.find((c) => c.words.test(haystack))?.category ?? 'other';
}

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  insurance: 'Insurance',
  warranty: 'Warranty',
  certificate: 'Certificate',
  contract: 'Contract',
  identification: 'ID document',
  permit: 'Permit or licence',
  subscription: 'Subscription',
  other: 'Other',
};

export const KIND_LABELS: Record<DateKind, string> = {
  expiry: 'Expiry or renewal',
  issue: 'Issue or purchase date',
  payment: 'Payment due date',
  start: 'Start date',
  birth: 'Date of birth',
  created: 'Created or printed',
  unknown: 'Unlabelled date',
};

/** Whole days from `today` to an ISO date, in local calendar days (time-zone safe). */
export function daysUntil(isoDate: string, today: Date = new Date()): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - start) / 86_400_000);
}

export function isValidIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return Boolean(m && iso(Number(m[1]), Number(m[2]), Number(m[3])));
}
