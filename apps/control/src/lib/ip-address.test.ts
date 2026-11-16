import { describe, expect, it } from 'vitest';
import { displayIp } from './ip-address';

describe('displayIp', () => {
  it('zeigt IPv4-gemappte Adressen als IPv4', () => {
    expect(displayIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(displayIp('::FFFF:10.0.0.7')).toBe('10.0.0.7');
  });

  it('lässt IPv4, echtes IPv6 und Unbekanntes unverändert', () => {
    expect(displayIp('203.0.113.9')).toBe('203.0.113.9');
    expect(displayIp('::1')).toBe('::1');
    expect(displayIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('gibt bei leer oder fehlend null zurück', () => {
    expect(displayIp(null)).toBeNull();
    expect(displayIp(undefined)).toBeNull();
    expect(displayIp('  ')).toBeNull();
  });
});
