import { foldWithMap, matchName } from '../ranking';

describe('matchName', () => {
  it('ranks exact > prefix > word-start > substring > all-words', () => {
    const exact = matchName('invoice.pdf', 'invoice');
    const prefix = matchName('invoice-laptop.pdf', 'invoice');
    const wordStart = matchName('laptop invoice.pdf', 'invoice');
    const substring = matchName('myinvoice.pdf', 'invoice');
    const words = matchName('laptop-2026-invoice.pdf', 'invoice laptop');
    const scores = [exact, prefix, wordStart, substring, words].map((m) => m?.score ?? -1);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(words?.reason).toBe('File name contains all words');
  });

  it('is accent- and case-insensitive with correct highlight ranges', () => {
    const match = matchName('Résumé Final.docx', 'resume');
    expect(match).not.toBeNull();
    expect(match?.ranges).toEqual([[0, 6]]);
  });

  it('returns null when a word is missing', () => {
    expect(matchName('car-insurance.pdf', 'car warranty')).toBeNull();
    expect(matchName('anything', '   ')).toBeNull();
  });

  it('maps folded indexes back to the original string', () => {
    expect(foldWithMap('Äb').map).toEqual([0, 1]);
  });
});
