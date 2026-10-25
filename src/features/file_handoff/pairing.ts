/**
 * Smart Handoff pairing payloads. The receiver shows these as a QR code; the sender scans it (or types
 * an address). The payload only tells the sender where to connect — authentication still happens through
 * the 6-digit code both devices show after the encrypted handshake, so a forged QR code cannot silently
 * redirect a transfer.
 */

export type HandoffTarget = { hosts: string[]; port: number; name?: string };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function validHost(host: string): boolean {
  const ip = IPV4.exec(host);
  if (ip) return ip.slice(1).every((part) => Number(part) <= 255);
  return HOSTNAME.test(host);
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** The Android emulator's private network (10.0.2.0/24) is only reachable from its own host computer. */
export function isEmulatorAddress(host: string): boolean {
  return host.startsWith('10.0.2.');
}

/**
 * Orders addresses so the ones other devices are most likely to reach come first: home/office Wi-Fi
 * ranges, then other private ranges, with emulator-only addresses last.
 */
export function rankAddresses(addresses: string[]): string[] {
  const score = (host: string) => (isEmulatorAddress(host) ? 3 : host.startsWith('192.168.') ? 0 : /^172\.(1[6-9]|2\d|3[01])\./.test(host) ? 1 : 2);
  return [...new Set(addresses)].sort((a, b) => score(a) - score(b));
}

export function buildPairingPayload(target: HandoffTarget): string {
  const params = [`h=${target.hosts.join(',')}`, `p=${target.port}`];
  if (target.name) params.push(`n=${encodeURIComponent(target.name)}`);
  return `fileora://handoff?${params.join('&')}`;
}

function fromParams(get: (key: string) => string | undefined): HandoffTarget | null {
  const hosts = (get('h') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const port = Number(get('p'));
  if (hosts.length === 0 || hosts.length > 8 || !hosts.every(validHost) || !validPort(port)) return null;
  const rawName = get('n');
  let name: string | undefined;
  try {
    name = rawName ? decodeURIComponent(rawName).slice(0, 80) : undefined;
  } catch {
    name = undefined;
  }
  return { hosts, port, name };
}

/** Parses route params from a `fileora://handoff?...` deep link (e.g. scanned with the system camera). */
export function parsePairingParams(params: { h?: string | string[]; p?: string | string[]; n?: string | string[] }): HandoffTarget | null {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  // Route params arrive already decoded; re-encode the name so fromParams can decode it uniformly.
  return fromParams((key) => {
    const value = first(params[key as 'h' | 'p' | 'n']);
    return key === 'n' && value !== undefined ? encodeURIComponent(value) : value;
  });
}

/** Accepts a scanned pairing QR code or a typed `host:port` address. */
export function parsePairingText(text: string): HandoffTarget | null {
  const trimmed = text.trim();
  if (trimmed.toLowerCase().startsWith('fileora://handoff?')) {
    const query = trimmed.slice(trimmed.indexOf('?') + 1);
    const values = new Map<string, string>();
    for (const part of query.split('&')) {
      const eq = part.indexOf('=');
      if (eq > 0 && !values.has(part.slice(0, eq))) values.set(part.slice(0, eq), part.slice(eq + 1));
    }
    return fromParams((key) => values.get(key));
  }
  const match = /^([A-Za-z0-9.-]+)\s*[: ]\s*(\d{1,5})$/.exec(trimmed);
  if (!match) return null;
  const host = match[1] ?? '';
  const port = Number(match[2]);
  return validHost(host) && validPort(port) ? { hosts: [host], port } : null;
}
