import {
  bytesByCategory,
  exactDuplicates,
  exportStem,
  hammingDistance,
  oldDownloads,
  repeatedExports,
  similarImageGroups,
  sizeCandidates,
  type ScannedFile,
} from '../analysis';

function file(path: string, size: number, extra: Partial<ScannedFile> = {}): ScannedFile {
  const name = path.split('/').pop() ?? path;
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return {
    uri: `file:///root/${path}`,
    parentUri: `file:///root/${parent}`,
    locationId: 'loc',
    name,
    path,
    size,
    modifiedAt: 1000,
    category: 'document',
    extension: name.split('.').pop() ?? '',
    mimeType: null,
    ...extra,
  };
}

describe('duplicates', () => {
  it('only hashes files that share a size', () => {
    const groups = sizeCandidates([file('a.pdf', 10), file('b.pdf', 10), file('c.pdf', 11), file('empty.txt', 0), file('empty2.txt', 0)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('groups identical hashes, keeps the oldest first and counts reclaimable bytes', () => {
    const a = file('Download/a.pdf', 100, { modifiedAt: 5 });
    const b = file('Documents/a.pdf', 100, { modifiedAt: 1 });
    const c = file('x.pdf', 100);
    const groups = exactDuplicates([
      { file: a, sha256: 'h1' },
      { file: b, sha256: 'h1' },
      { file: c, sha256: 'h2' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.files[0]?.path).toBe('Documents/a.pdf');
    expect(groups[0]?.reclaimable).toBe(100);
  });
});

describe('similar images', () => {
  it('measures bit distance between hex hashes', () => {
    expect(hammingDistance('ff00', 'ff00')).toBe(0);
    expect(hammingDistance('ff00', 'fe01')).toBe(2);
  });

  it('clusters near hashes transitively', () => {
    const img = (n: string) => file(`DCIM/${n}.jpg`, 1, { category: 'image' });
    const groups = similarImageGroups([
      { file: img('1'), imageHash: '0000000000000000' },
      { file: img('2'), imageHash: '0000000000000003' },
      { file: img('3'), imageHash: '000000000000000f' },
      { file: img('far'), imageHash: 'ffffffffffffffff' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });
});

describe('repeated exports', () => {
  it('normalises copy suffixes', () => {
    expect(exportStem('Report (2).pdf')).toBe('report.pdf');
    expect(exportStem('report copy.pdf')).toBe('report.pdf');
    expect(exportStem('report-final-v2.pdf')).toBe('report.pdf');
    expect(exportStem('2024 budget.xlsx')).toBe('2024 budget.xlsx');
  });

  it('groups same-folder variants but ignores exact duplicates', () => {
    const files = [file('docs/report.pdf', 10), file('docs/report (1).pdf', 12), file('docs/report final.pdf', 14), file('other/report.pdf', 10)];
    const groups = repeatedExports(files, new Set([files[0]?.uri ?? '']));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });
});

describe('summaries', () => {
  it('finds old downloads only in download folders', () => {
    const now = 200 * 86_400_000;
    const old = oldDownloads([file('Download/old.zip', 5, { modifiedAt: 0 }), file('Download/new.zip', 5, { modifiedAt: now }), file('Docs/old.zip', 5, { modifiedAt: 0 })], now);
    expect(old.map((f) => f.path)).toEqual(['Download/old.zip']);
  });

  it('totals bytes per category', () => {
    const totals = bytesByCategory([file('a.jpg', 5, { category: 'image' }), file('b.jpg', 7, { category: 'image' }), file('c.pdf', 3)]);
    expect(totals[0]).toEqual({ category: 'image', bytes: 12, count: 2 });
  });
});
