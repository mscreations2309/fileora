/**
 * Minimal, defensive EXIF reader for JPEG files: only the tags relevant to privacy. The input is
 * untrusted; every offset is bounds-checked and parsing stops at the first inconsistency.
 */
export type ExifSummary = {
  make?: string;
  model?: string;
  software?: string;
  artist?: string;
  copyright?: string;
  dateTaken?: string;
  latitude?: number;
  longitude?: number;
  /** Other metadata blocks present (XMP, IPTC, comments). */
  otherBlocks: string[];
};

const TAGS: Record<number, keyof ExifSummary> = {
  0x010f: 'make',
  0x0110: 'model',
  0x0131: 'software',
  0x013b: 'artist',
  0x8298: 'copyright',
  0x9003: 'dateTaken',
};

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

export function readExif(bytes: Uint8Array): ExifSummary | null {
  if (!isJpeg(bytes)) return null;
  const summary: ExifSummary = { otherBlocks: [] };
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xda || marker === 0xd9) break;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (length < 2) break;
    const start = offset + 4;
    const end = Math.min(bytes.length, offset + 2 + length);
    if (marker === 0xe1) {
      const header = String.fromCharCode(...bytes.subarray(start, Math.min(start + 6, end)));
      if (header === 'Exif\u0000\u0000') parseTiff(bytes.subarray(start + 6, end), summary);
      else summary.otherBlocks.push('XMP metadata');
    } else if (marker === 0xed) {
      summary.otherBlocks.push('IPTC/Photoshop metadata');
    } else if (marker === 0xfe) {
      summary.otherBlocks.push('Comment');
    }
    offset += 2 + length;
  }
  return summary;
}

function parseTiff(tiff: Uint8Array, summary: ExifSummary): void {
  if (tiff.length < 8) return;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const u16 = (o: number) => (o + 2 > tiff.length ? 0 : little ? (tiff[o] ?? 0) | ((tiff[o + 1] ?? 0) << 8) : ((tiff[o] ?? 0) << 8) | (tiff[o + 1] ?? 0));
  const u32 = (o: number) =>
    o + 4 > tiff.length
      ? 0
      : little
        ? ((tiff[o] ?? 0) | ((tiff[o + 1] ?? 0) << 8) | ((tiff[o + 2] ?? 0) << 16) | ((tiff[o + 3] ?? 0) << 24)) >>> 0
        : (((tiff[o] ?? 0) << 24) | ((tiff[o + 1] ?? 0) << 16) | ((tiff[o + 2] ?? 0) << 8) | (tiff[o + 3] ?? 0)) >>> 0;
  const ascii = (o: number, count: number) => {
    let s = '';
    for (let i = 0; i < count && o + i < tiff.length; i += 1) {
      const c = tiff[o + i] ?? 0;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  };
  const rational = (o: number) => {
    const den = u32(o + 4);
    return den === 0 ? 0 : u32(o) / den;
  };
  const visited = new Set<number>();
  const readIfd = (ifd: number, handle: (tag: number, type: number, count: number, valueOffset: number) => void) => {
    if (ifd <= 0 || ifd + 2 > tiff.length || visited.has(ifd)) return;
    visited.add(ifd);
    const entries = Math.min(u16(ifd), 256);
    for (let i = 0; i < entries; i += 1) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > tiff.length) return;
      const type = u16(entry + 2);
      const count = u32(entry + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
      const valueOffset = count * size > 4 ? u32(entry + 8) : entry + 8;
      handle(u16(entry), type, count, valueOffset);
    }
  };
  let exifIfd = 0;
  let gpsIfd = 0;
  const general = (tag: number, type: number, count: number, valueOffset: number) => {
    const key = TAGS[tag];
    if (key && type === 2 && key !== 'otherBlocks') (summary as Record<string, unknown>)[key] = ascii(valueOffset, Math.min(count, 200));
    if (tag === 0x8769) exifIfd = u32(valueOffset);
    if (tag === 0x8825) gpsIfd = u32(valueOffset);
  };
  readIfd(u32(4), general);
  if (exifIfd) readIfd(exifIfd, general);
  if (gpsIfd) {
    let latRef = 'N';
    let lonRef = 'E';
    let lat: number[] | null = null;
    let lon: number[] | null = null;
    readIfd(gpsIfd, (tag, type, count, valueOffset) => {
      if (tag === 1) latRef = ascii(valueOffset, 2) || 'N';
      if (tag === 3) lonRef = ascii(valueOffset, 2) || 'E';
      if ((tag === 2 || tag === 4) && type === 5 && count >= 3) {
        const parts = [rational(valueOffset), rational(valueOffset + 8), rational(valueOffset + 16)];
        if (tag === 2) lat = parts;
        else lon = parts;
      }
    });
    const toDegrees = (p: number[]) => (p[0] ?? 0) + (p[1] ?? 0) / 60 + (p[2] ?? 0) / 3600;
    if (lat && lon) {
      const latitude = toDegrees(lat) * (latRef === 'S' ? -1 : 1);
      const longitude = toDegrees(lon) * (lonRef === 'W' ? -1 : 1);
      if (Number.isFinite(latitude) && Number.isFinite(longitude) && (latitude !== 0 || longitude !== 0)) {
        summary.latitude = Math.round(latitude * 1e5) / 1e5;
        summary.longitude = Math.round(longitude * 1e5) / 1e5;
      }
    }
  }
}
