import { identifiers, nameTokens, relate, type FileFeatures } from '../scoring';

function features(name: string, extra: Partial<FileFeatures> = {}): FileFeatures {
  return { uri: `file:///${name}`, name, parentUri: 'file:///docs', modifiedAt: 0, nameTokens: nameTokens(name), identifiers: new Set(), workspaces: new Set(), ...extra };
}

describe('feature extraction', () => {
  it('keeps distinctive name words only', () => {
    expect([...nameTokens('IMG_2026 ThinkPad-invoice copy.pdf')]).toEqual(['thinkpad', 'invoice']);
  });

  it('extracts identifiers but not years or dates', () => {
    const ids = identifiers('Invoice INV-2026-0412 for order 405-1234567, paid 2026, due 15/11/2026. Mail priya@example.com');
    expect([...ids]).toEqual(expect.arrayContaining(['INV-2026-0412', '405-1234567', 'priya@example.com']));
    expect(ids.has('2026')).toBe(false);
    expect(ids.has('15/11/2026')).toBe(false);
  });
});

describe('relate', () => {
  it('explains shared identifiers and names', () => {
    const a = features('thinkpad-invoice.pdf', { identifiers: new Set(['INV-2026-0412']) });
    const b = features('payment receipt.png', { identifiers: new Set(['INV-2026-0412']), modifiedAt: 2 * 3_600_000 });
    const { score, reasons } = relate(a, b, false);
    expect(score).toBeGreaterThan(40);
    expect(reasons.map((r) => r.kind)).toEqual(['identifier', 'time']);
    expect(reasons[0]?.text).toBe('Both mention “INV-2026-0412”');
  });

  it('never suggests a relationship from timing alone', () => {
    const { score, reasons } = relate(features('a.jpg'), features('b.pdf', { modifiedAt: 60_000 }), false);
    expect(reasons.map((r) => r.kind)).toEqual(['time']);
    expect(score).toBe(0);
  });

  it('ranks manual links highest', () => {
    expect(relate(features('x.txt'), features('y.txt', { parentUri: 'other' }), true).score).toBeGreaterThanOrEqual(100);
  });
});
