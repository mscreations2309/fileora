import { columnName, compareSnapshots, diffCsv, diffJson, diffLines, diffWords, parseCsv, summarize, withContext } from '../diff';

describe('diffLines', () => {
  it('finds minimal additions and removals', () => {
    const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'c', 'x', 'd']);
    expect(ops.map((o) => `${o.type[0]}${o.text}`)).toEqual(['ea', 'rb', 'ec', 'ax', 'ed']);
    expect(summarize(ops)).toEqual({ added: 1, removed: 1, unchanged: 3 });
  });

  it('numbers lines on both sides', () => {
    const ops = diffLines(['one', 'two'], ['zero', 'one', 'two']);
    expect(ops[0]).toEqual({ type: 'add', left: null, right: 1, text: 'zero' });
    expect(ops[2]).toEqual({ type: 'equal', left: 2, right: 3, text: 'two' });
  });

  it('handles identical and empty inputs', () => {
    expect(summarize(diffLines(['a'], ['a']))).toEqual({ added: 0, removed: 0, unchanged: 1 });
    expect(summarize(diffLines([], ['a', 'b']))).toEqual({ added: 2, removed: 0, unchanged: 0 });
  });

  it('collapses long unchanged runs', () => {
    const left = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const right = [...left];
    right[10] = 'changed';
    const view = withContext(diffLines(left, right), 1);
    expect(view.filter((v) => v.type === 'gap')).toHaveLength(2);
  });

  it('highlights changed words', () => {
    const words = diffWords('Quote: 45000 total', 'Quote: 52000 total');
    expect(words.filter((w) => w.type !== 'equal').map((w) => w.text)).toEqual(['45000', '52000']);
  });
});

describe('diffJson', () => {
  it('reports paths of added, removed and changed values', () => {
    const changes = diffJson({ a: 1, b: { c: [1, 2] }, d: 'x' }, { a: 2, b: { c: [1, 2, 3] }, e: true });
    expect(changes).toEqual([
      { path: '$.a', kind: 'changed', before: 1, after: 2 },
      { path: '$.b.c[2]', kind: 'added', after: 3 },
      { path: '$.d', kind: 'removed', before: 'x' },
      { path: '$.e', kind: 'added', after: true },
    ]);
  });
});

describe('CSV', () => {
  it('parses quoted fields', () => {
    expect(parseCsv('a,"b,c","d ""q"""\n1,2,3')).toEqual([
      ['a', 'b,c', 'd "q"'],
      ['1', '2', '3'],
    ]);
  });

  it('names columns like spreadsheets', () => {
    expect([0, 25, 26, 27, 701].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ']);
  });

  it('reports changed cells with headers and added rows', () => {
    const diff = diffCsv('item,price\npen,10\nbook,250\n', 'item,price\npen,12\nbook,250\nbag,900\n');
    expect(diff.changedCells).toEqual([{ cell: 'B2', row: 2, column: 'B', header: 'price', before: '10', after: '12' }]);
    expect(diff.addedRows).toEqual([4]);
    expect(diff.headerChanged).toBe(false);
  });
});

describe('compareSnapshots', () => {
  const item = (path: string, size: number, sha: string | null, modifiedAt = 1) => ({ path, isDirectory: false, size, modifiedAt, sha256: sha });

  it('uses content hashes, detects renames and ignores timestamp-only changes when hashed', () => {
    const changes = compareSnapshots(
      [item('a.txt', 1, 'h1'), item('b.txt', 2, 'h2'), item('c.txt', 3, 'h3'), item('d.txt', 4, 'h4', 1)],
      [item('a.txt', 1, 'h1'), item('b.txt', 2, 'hX'), item('renamed.txt', 3, 'h3'), item('d.txt', 4, 'h4', 99), item('new.txt', 5, 'h5')],
    );
    expect(changes).toEqual([
      { kind: 'added', path: 'new.txt', size: 5 },
      { kind: 'renamed', from: 'c.txt', to: 'renamed.txt', basis: 'content' },
      { kind: 'modified', path: 'b.txt', sizeBefore: 2, sizeAfter: 2, basis: 'content' },
    ]);
  });

  it('labels timestamp-only evidence when no hashes exist', () => {
    const changes = compareSnapshots([item('a', 1, null, 1)], [item('a', 1, null, 2)]);
    expect(changes).toEqual([{ kind: 'modified', path: 'a', sizeBefore: 1, sizeAfter: 1, basis: 'timestamp' }]);
  });
});
