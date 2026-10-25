import { detectInText, ibanValid, lineOf, luhnValid, maskValue, redactText, verhoeffValid } from '../detectors';
import { readExif } from '../exif';

describe('checksums', () => {
  it('validates Luhn, Verhoeff and IBAN', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(verhoeffValid('234123412346')).toBe(true);
    expect(verhoeffValid('234123412345')).toBe(false);
    expect(ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(ibanValid('GB82 WEST 1234 5698 7654 33')).toBe(false);
  });
});

describe('detectInText', () => {
  const text = [
    'Name: Priya Sharma',
    'Email: priya.sharma@example.com  Phone: +91 98765 43210',
    'Card: 4111 1111 1111 1111 (exp 12/27)',
    'Aadhaar: 2341 2341 2346',
    'PAN: ABCPS1234K',
    'Order 1234567890123 is not a card',
    'password = hunter2!',
  ].join('\n');

  it('finds validated identifiers with categories', () => {
    const labels = detectInText(text).map((f) => f.label);
    expect(labels).toEqual(expect.arrayContaining(['Email address', 'Phone number', 'Payment card number', 'Aadhaar number', 'PAN (Indian tax ID)', 'Password']));
  });

  it('ignores digit strings that fail checksums', () => {
    const cards = detectInText(text).filter((f) => f.category === 'payment-card');
    expect(cards).toHaveLength(1);
    expect(detectInText('Aadhaar 2341 2341 2345').filter((f) => f.label === 'Aadhaar number')).toHaveLength(0);
  });

  it('does not report overlapping findings twice', () => {
    const findings = detectInText('Card 4111111111111111');
    expect(findings).toHaveLength(1);
  });

  it('reports line numbers and masks values', () => {
    const email = detectInText(text).find((f) => f.category === 'email');
    expect(email && lineOf(text, email.start)).toBe(2);
    expect(maskValue('priya.sharma@example.com')).toBe('p•••••••••••@example.com');
    expect(maskValue('4111111111111111')).toBe('4111••••••••1111');
  });

  it('redacts exactly the selected ranges', () => {
    const sample = 'mail a@b.co now';
    const findings = detectInText(sample);
    expect(redactText(sample, findings)).toBe('mail [REDACTED] now');
  });
});

describe('readExif', () => {
  function jpegWithExif(): Uint8Array {
    // Little-endian TIFF: IFD0 with Make ("Cam") and a GPS IFD pointer; GPS IFD with N 12°30'0", E 77°36'0".
    const tiff: number[] = [];
    const push16 = (v: number) => tiff.push(v & 0xff, (v >> 8) & 0xff);
    const push32 = (v: number) => tiff.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    tiff.push(0x49, 0x49); push16(42); push32(8);
    // IFD0 at 8: 2 entries
    push16(2);
    push16(0x010f); push16(2); push32(4); tiff.push(0x43, 0x61, 0x6d, 0x00); // Make "Cam"
    push16(0x8825); push16(4); push32(1); push32(38); // GPS IFD at 38
    push32(0);
    // GPS IFD at 38: 4 entries
    push16(4);
    push16(1); push16(2); push32(2); tiff.push(0x4e, 0, 0, 0); // N
    push16(2); push16(5); push32(3); push32(92); // lat rationals at 92
    push16(3); push16(2); push32(2); tiff.push(0x45, 0, 0, 0); // E
    push16(4); push16(5); push32(3); push32(116); // lon rationals at 116
    push32(0);
    while (tiff.length < 92) tiff.push(0);
    [12, 1, 30, 1, 0, 1].forEach(push32);
    [77, 1, 36, 1, 0, 1].forEach(push32);
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const length = payload.length + 2;
    return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...payload, 0xff, 0xda, 0, 2]);
  }

  it('reads camera and GPS position', () => {
    const exif = readExif(jpegWithExif());
    expect(exif?.make).toBe('Cam');
    expect(exif?.latitude).toBeCloseTo(12.5);
    expect(exif?.longitude).toBeCloseTo(77.6);
  });

  it('returns null for non-JPEG data and survives garbage', () => {
    expect(readExif(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 4, 1, 2, 0xff]))).toEqual({ otherBlocks: ['XMP metadata'] });
  });
});
