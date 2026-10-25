import { insideRoots, laptopName, nameProblem, visibleEntries } from '../remoteRules';

describe('Fileora Web rules', () => {
  it('hides partial and hidden files and sorts folders first', () => {
    const entries = [
      { name: 'b.txt', isDirectory: false },
      { name: '.fileora-partial-123', isDirectory: false },
      { name: '.secret', isDirectory: false, isHidden: true },
      { name: 'Photos', isDirectory: true },
      { name: 'a10.txt', isDirectory: false },
      { name: 'a9.txt', isDirectory: false },
    ];
    expect(visibleEntries(entries, false).map((e) => e.name)).toEqual(['Photos', 'a9.txt', 'a10.txt', 'b.txt']);
    expect(visibleEntries(entries, true).map((e) => e.name)).toContain('.secret');
    expect(visibleEntries(entries, true).map((e) => e.name)).not.toContain('.fileora-partial-123');
  });

  it('validates names', () => {
    expect(nameProblem('Report 2026.pdf')).toBeNull();
    expect(nameProblem('  ')).toBe('Enter a name');
    expect(nameProblem('..')).toBe('That name is reserved');
    expect(nameProblem('a/b')).not.toBeNull();
    expect(nameProblem('what?.txt')).not.toBeNull();
  });

  it('keeps laptops inside the user’s locations and out of excluded folders', () => {
    const roots = ['file:///storage/emulated/0', 'content://com.android.externalstorage.documents/tree/primary%3AWork'];
    expect(insideRoots('file:///storage/emulated/0/Download/a.pdf', roots)).toBe(true);
    expect(insideRoots('file:///storage/emulated/0', roots)).toBe(true);
    expect(insideRoots('file:///storage/emulated/01/x', roots)).toBe(false);
    expect(insideRoots('file:///data/user/0/com.fileora.app/files/vault/x', roots)).toBe(false);
    expect(insideRoots('content://com.android.externalstorage.documents/tree/primary%3AWork%2Fnotes.txt', roots)).toBe(true);
    expect(insideRoots('file:///storage/emulated/0/Android/data/com.fileora.app/files/trash/x', roots, ['file:///storage/emulated/0/Android/data/com.fileora.app/files/trash'])).toBe(false);
  });

  it('names laptops from the user agent', () => {
    expect(laptopName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36')).toBe('Windows · Chrome');
    expect(laptopName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe('Mac · Safari');
  });
});
