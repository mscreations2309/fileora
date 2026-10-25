import { equalBytes, fromBase64, fromRecoveryCode, toBase64, toRecoveryCode } from '../bytes';

describe('base64', () => {
  it('round-trips arbitrary bytes and matches the standard encoding', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(toBase64(new TextEncoder().encode('Fileora'))).toBe('RmlsZW9yYQ==');
  });
});

describe('recovery codes', () => {
  it('round-trips 20 random bytes through grouped base32', () => {
    const bytes = new Uint8Array(20).map((_, i) => (i * 37 + 11) & 0xff);
    const code = toRecoveryCode(bytes);
    expect(code).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    expect(fromRecoveryCode(code)).toEqual(bytes);
  });

  it('tolerates lowercase, spaces and confusable letters', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const code = toRecoveryCode(bytes).toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o');
    expect(fromRecoveryCode(code)).toEqual(bytes);
  });

  it('rejects invalid characters', () => {
    expect(fromRecoveryCode('ABCD-!!!!')).toBeNull();
  });
});

describe('equalBytes', () => {
  it('compares contents', () => {
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(equalBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
