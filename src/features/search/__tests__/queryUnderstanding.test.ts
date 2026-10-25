import { explainMatch, parseQuery, toFtsQuery } from '../queryUnderstanding';

const NOW = new Date(2026, 9, 25, 12, 0, 0); // 25 Oct 2026

describe('parseQuery', () => {
  it('extracts terms, type filters and related words', () => {
    const parsed = parseQuery('Show PDFs mentioning payment due', NOW);
    expect(parsed.terms).toEqual(['payment', 'due']);
    expect(parsed.extensions).toEqual(['pdf']);
    expect(parsed.related.payment).toContain('paid');
    expect(parsed.interpretations).toContain('Only pdf files');
  });

  it('understands relative dates', () => {
    const parsed = parseQuery('documents I modified last month', NOW);
    expect(parsed.terms).toEqual([]);
    expect(parsed.categories).toEqual(['document']);
    expect(new Date(parsed.modifiedAfter ?? 0)).toEqual(new Date(2026, 8, 1));
    expect(new Date(parsed.modifiedBefore ?? 0)).toEqual(new Date(2026, 9, 1));
  });

  it('understands month names and years', () => {
    const march = parseQuery('receipts from march', NOW);
    expect(new Date(march.modifiedAfter ?? 0)).toEqual(new Date(2026, 2, 1));
    const year = parseQuery('tax files in 2024', NOW);
    expect(new Date(year.modifiedAfter ?? 0)).toEqual(new Date(2024, 0, 1));
    expect(year.terms).toEqual(['tax']);
  });

  it('keeps screenshot as a term and recognises "latest"', () => {
    const parsed = parseQuery('find the latest screenshots containing an order number', NOW);
    expect(parsed.categories).toEqual(['image']);
    expect(parsed.terms).toEqual(['screenshot', 'order', 'number']);
    expect(parsed.preferLatest).toBe(true);
  });

  it('is accent-insensitive', () => {
    expect(parseQuery('Résumé', NOW).terms).toEqual(['resume']);
  });
});

describe('toFtsQuery', () => {
  it('requires every term and escapes quotes', () => {
    const parsed = parseQuery('invoice laptop', NOW);
    expect(toFtsQuery(parsed, false)).toBe('"invoice"* AND "laptop"*');
    expect(toFtsQuery(parsed, true)).toContain('"bill"');
    expect(toFtsQuery({ ...parsed, terms: ['a"b'], related: {} }, false)).toBe('"a""b"*');
  });

  it('returns null without terms', () => {
    expect(toFtsQuery(parseQuery('pdfs from last week', NOW), true)).toBeNull();
  });
});

describe('explainMatch', () => {
  it('separates exact and related matches', () => {
    const parsed = parseQuery('invoice laptop', NOW);
    expect(explainMatch(parsed, 'Tax Bill for ThinkPad laptop')).toEqual({ exact: ['laptop'], related: ['bill'] });
  });
});
