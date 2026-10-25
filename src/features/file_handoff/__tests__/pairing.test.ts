import { buildPairingPayload, isEmulatorAddress, parsePairingParams, parsePairingText, rankAddresses } from '../pairing';

describe('pairing payloads', () => {
  it('round-trips hosts, port and a name with special characters', () => {
    const payload = buildPairingPayload({ hosts: ['192.168.1.20', '10.0.0.5'], port: 40123, name: 'Asha’s Pixel & Co' });
    expect(payload.startsWith('fileora://handoff?')).toBe(true);
    expect(parsePairingText(payload)).toEqual({ hosts: ['192.168.1.20', '10.0.0.5'], port: 40123, name: 'Asha’s Pixel & Co' });
  });

  it('accepts typed addresses', () => {
    expect(parsePairingText(' 192.168.1.20:40123 ')).toEqual({ hosts: ['192.168.1.20'], port: 40123 });
    expect(parsePairingText('192.168.1.20 40123')).toEqual({ hosts: ['192.168.1.20'], port: 40123 });
  });

  it('rejects malformed input', () => {
    expect(parsePairingText('192.168.1.300:40123')).toBeNull();
    expect(parsePairingText('192.168.1.20:70000')).toBeNull();
    expect(parsePairingText('https://example.com')).toBeNull();
    expect(parsePairingText('fileora://handoff?h=&p=1')).toBeNull();
    expect(parsePairingText('fileora://handoff?h=1.2.3.4;rm&p=80')).toBeNull();
    expect(parsePairingText('fileora://handoff?h=1.2.3.4&p=80&n=%E0%A4%A')).toEqual({ hosts: ['1.2.3.4'], port: 80, name: undefined });
  });

  it('parses deep-link route params', () => {
    expect(parsePairingParams({ h: '192.168.1.20', p: '40123', n: 'Pixel 8' })).toEqual({ hosts: ['192.168.1.20'], port: 40123, name: 'Pixel 8' });
    expect(parsePairingParams({ p: '40123' })).toBeNull();
  });

  it('puts reachable Wi-Fi addresses first and emulator addresses last', () => {
    expect(rankAddresses(['10.0.2.16', '10.1.1.4', '192.168.0.9', '172.20.1.2', '192.168.0.9'])).toEqual(['192.168.0.9', '172.20.1.2', '10.1.1.4', '10.0.2.16']);
    expect(isEmulatorAddress('10.0.2.16')).toBe(true);
    expect(isEmulatorAddress('10.0.20.16')).toBe(false);
  });
});
