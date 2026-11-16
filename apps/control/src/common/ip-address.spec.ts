import { normalizeIp } from './ip-address';

describe('normalizeIp', () => {
  it('löst IPv4-mapped IPv6 zu IPv4 auf', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('::FFFF:10.0.0.7')).toBe('10.0.0.7');
  });

  it('lässt IPv4 und echtes IPv6 unverändert', () => {
    expect(normalizeIp('203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('::1')).toBe('::1');
  });

  it('gibt für leere oder fehlende Werte null zurück', () => {
    expect(normalizeIp(null)).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
    expect(normalizeIp('  ')).toBeNull();
  });

  it('fasst eine ungültige mapped-Form nicht an', () => {
    expect(normalizeIp('::ffff:not-an-ip')).toBe('::ffff:not-an-ip');
  });
});
