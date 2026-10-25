import { daysUntil, expiryCandidates, findDates, isValidIsoDate, suggestCategory } from '../dateExtraction';

const INVOICE = [
  'TAX INVOICE',
  'Invoice date: 12/10/2026',
  'Payment due date: 15 November 2026',
  'Warranty valid until 14/10/2029',
].join('\n');

describe('findDates', () => {
  it('classifies dates by their labels', () => {
    const dates = findDates(INVOICE);
    expect(dates.map((d) => [d.date, d.kind])).toEqual([
      ['2026-10-12', 'issue'],
      ['2026-11-15', 'payment'],
      ['2029-10-14', 'expiry'],
    ]);
  });

  it('never reports issue or payment dates as expiry', () => {
    expect(expiryCandidates(INVOICE).map((d) => d.date)).toEqual(['2029-10-14']);
  });

  it('reads ISO and month-name formats', () => {
    expect(findDates('Policy expires on 2027-01-31')[0]).toMatchObject({ date: '2027-01-31', kind: 'expiry', confidence: 'high' });
    expect(findDates('Valid till Jan 5, 2028')[0]).toMatchObject({ date: '2028-01-05', kind: 'expiry' });
    expect(findDates('Date of expiry: 3rd March 2030')[0]).toMatchObject({ date: '2030-03-03', kind: 'expiry' });
  });

  it('flags day/month ambiguity instead of guessing silently', () => {
    const [date] = findDates('Expiry: 03/04/2027');
    expect(date).toMatchObject({ date: '2027-04-03', alternative: '2027-03-04', confidence: 'low' });
  });

  it('rejects impossible dates', () => {
    expect(findDates('Expires 31/02/2027')).toHaveLength(0);
    expect(findDates('Expires 2027-13-01')).toHaveLength(0);
  });

  it('keeps the source text for verification', () => {
    expect(findDates(INVOICE)[2]?.source).toContain('Warranty valid until');
  });

  it('distinguishes dates of birth', () => {
    expect(findDates('DOB: 01/02/1990')[0]?.kind).toBe('birth');
  });
});

describe('helpers', () => {
  it('suggests a category', () => {
    expect(suggestCategory('Car insurance policy\nPremium paid', 'policy.pdf')).toBe('insurance');
    expect(suggestCategory(INVOICE, 'invoice.txt')).toBe('warranty');
  });

  it('counts calendar days independent of time of day', () => {
    expect(daysUntil('2026-10-26', new Date(2026, 9, 25, 23, 59))).toBe(1);
    expect(daysUntil('2026-10-25', new Date(2026, 9, 25, 0, 1))).toBe(0);
    expect(daysUntil('2026-10-20', new Date(2026, 9, 25))).toBe(-5);
  });

  it('validates ISO dates', () => {
    expect(isValidIsoDate('2027-02-28')).toBe(true);
    expect(isValidIsoDate('2027-02-29')).toBe(false);
    expect(isValidIsoDate('28/02/2027')).toBe(false);
  });
});
