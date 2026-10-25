/**
 * Sensitive-data detectors. Checksums are used wherever a format has one (cards, Aadhaar, IBAN) to
 * avoid flagging random digit strings. Detection is never claimed to be complete.
 */
export type Confidence = 'high' | 'medium' | 'low';

export type FindingCategory =
  | 'payment-card'
  | 'national-id'
  | 'tax-id'
  | 'bank'
  | 'email'
  | 'phone'
  | 'secret'
  | 'date-of-birth'
  | 'ip-address'
  | 'location'
  | 'metadata'
  | 'hidden-content';

export type TextFinding = {
  category: FindingCategory;
  label: string;
  value: string;
  start: number;
  end: number;
  confidence: Confidence;
  explanation: string;
};

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Aadhaar numbers carry a Verhoeff check digit. */
export function verhoeffValid(digits: string): boolean {
  let c = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    const p = VERHOEFF_P[i % 8]?.[Number(reversed[i])] ?? 0;
    c = VERHOEFF_D[c]?.[p] ?? 0;
  }
  return c === 0;
}

/** IBAN mod-97 check. */
export function ibanValid(iban: string): boolean {
  const compact = iban.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

type Rule = {
  category: FindingCategory;
  label: string;
  pattern: RegExp;
  confidence: Confidence;
  explanation: string;
  validate?: (match: string) => boolean;
};

const digitsOnly = (s: string) => s.replace(/\D/g, '');

const RULES: Rule[] = [
  {
    category: 'payment-card',
    label: 'Payment card number',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    confidence: 'high',
    explanation: 'A number that passes the card checksum. Card numbers can be misused for fraud.',
    validate: (m) => {
      const d = digitsOnly(m);
      return d.length >= 13 && d.length <= 19 && /^[2-6]/.test(d) && luhnValid(d);
    },
  },
  {
    category: 'national-id',
    label: 'Aadhaar number',
    pattern: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
    confidence: 'high',
    explanation: 'A 12-digit number that passes the Aadhaar checksum. Treat it as a national identity number.',
    validate: (m) => verhoeffValid(digitsOnly(m)),
  },
  {
    category: 'tax-id',
    label: 'PAN (Indian tax ID)',
    pattern: /\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b/g,
    confidence: 'high',
    explanation: 'Matches the format of a Permanent Account Number used for tax.',
  },
  {
    category: 'national-id',
    label: 'US Social Security number',
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    confidence: 'medium',
    explanation: 'Matches the format of a US Social Security number.',
  },
  {
    category: 'national-id',
    label: 'Passport number',
    pattern: /\b(?:passport(?:\s*(?:no|number|#))?[:.\s]*)([A-Z][0-9]{7})\b/gi,
    confidence: 'medium',
    explanation: 'Looks like a passport number next to the word “passport”.',
  },
  {
    category: 'bank',
    label: 'IBAN',
    pattern: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g,
    confidence: 'high',
    explanation: 'An international bank account number that passes its checksum.',
    validate: ibanValid,
  },
  {
    category: 'bank',
    label: 'IFSC code',
    pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    confidence: 'medium',
    explanation: 'An Indian bank branch code; combined with an account number it identifies a bank account.',
  },
  {
    category: 'bank',
    label: 'Bank account number',
    pattern: /\b(?:a\/c|acct|account)(?:\s*(?:no|number|#))?[:.\s]*\d{9,18}\b/gi,
    confidence: 'medium',
    explanation: 'A long number labelled as an account number.',
  },
  {
    category: 'email',
    label: 'Email address',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    confidence: 'high',
    explanation: 'Email addresses identify people and can be used for spam or phishing.',
  },
  {
    category: 'phone',
    label: 'Phone number',
    pattern: /(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\b\d{2,5}[\s-]?\d{3,5}[\s-]?\d{3,5}\b/g,
    confidence: 'medium',
    explanation: 'Looks like a phone number.',
    validate: (m) => {
      const d = digitsOnly(m);
      return d.length >= 10 && d.length <= 13 && !/^(\d)\1+$/.test(d);
    },
  },
  {
    category: 'secret',
    label: 'Private key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g,
    confidence: 'high',
    explanation: 'A private cryptographic key. Anyone with it can impersonate its owner.',
  },
  {
    category: 'secret',
    label: 'Cloud access key',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    confidence: 'high',
    explanation: 'Looks like an AWS access key ID.',
  },
  {
    category: 'secret',
    label: 'Password',
    pattern: /\b(?:password|passwd|pwd|pin)\s*[:=]\s*\S{4,}/gi,
    confidence: 'medium',
    explanation: 'A value labelled as a password or PIN.',
  },
  {
    category: 'date-of-birth',
    label: 'Date of birth',
    pattern: /\b(?:d\.?o\.?b\.?|date of birth|born on)\s*[:.-]?\s*\d{1,2}[\s/.-]\w{2,9}[\s/.-]\d{2,4}\b/gi,
    confidence: 'medium',
    explanation: 'A date labelled as a date of birth.',
  },
  {
    category: 'ip-address',
    label: 'IP address',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    confidence: 'low',
    explanation: 'An IP address can reveal a network or approximate location.',
  },
];

/** Scans text and returns non-overlapping findings, strongest category first for overlaps. */
export function detectInText(text: string, maxFindings = 500): TextFinding[] {
  const findings: TextFinding[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        rule.pattern.lastIndex += 1;
        continue;
      }
      const value = match[0].trim();
      if (rule.validate && !rule.validate(value)) continue;
      const start = match.index + match[0].indexOf(value);
      findings.push({ category: rule.category, label: rule.label, value, start, end: start + value.length, confidence: rule.confidence, explanation: rule.explanation });
      if (findings.length > maxFindings * 2) break;
    }
  }
  // Earlier rules are more specific: drop later matches that overlap an accepted one.
  const accepted: TextFinding[] = [];
  for (const finding of findings) {
    if (accepted.some((a) => finding.start < a.end && a.start < finding.end)) continue;
    accepted.push(finding);
    if (accepted.length >= maxFindings) break;
  }
  return accepted.sort((a, b) => a.start - b.start);
}

/** Shows enough of a value to recognise it without displaying it in full. */
export function maskValue(value: string): string {
  if (value.length <= 4) return '•'.repeat(value.length);
  if (value.includes('@')) {
    const [user = '', domain = ''] = value.split('@');
    return `${user.slice(0, 1)}${'•'.repeat(Math.max(1, user.length - 1))}@${domain}`;
  }
  const visible = Math.min(4, Math.floor(value.length / 4));
  return `${value.slice(0, visible)}${'•'.repeat(value.length - visible * 2)}${value.slice(-visible)}`;
}

/** 1-based line number of an offset, for "Line 12" locations. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Replaces the given findings in text. Used for redacted copies of text-based files. */
export function redactText(text: string, findings: Pick<TextFinding, 'start' | 'end'>[]): string {
  const sorted = [...findings].sort((a, b) => b.start - a.start);
  let out = text;
  for (const finding of sorted) out = `${out.slice(0, finding.start)}[REDACTED]${out.slice(finding.end)}`;
  return out;
}
