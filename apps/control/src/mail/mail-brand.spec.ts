import { displayName } from './mail-brand';

describe('displayName', () => {
  it('hängt Verwaltung an, wenn der Name nicht darauf endet', () => {
    expect(displayName('Beispielprodukt')).toBe('Beispielprodukt Verwaltung');
    expect(displayName('Beispielprodukt', '-')).toBe('Beispielprodukt-Verwaltung');
  });

  it('verdoppelt Verwaltung nicht', () => {
    expect(displayName('SAAS Verwaltung')).toBe('SAAS Verwaltung');
    expect(displayName('SAAS Verwaltung', '-')).toBe('SAAS Verwaltung');
    expect(displayName(' Foo-Verwaltung ')).toBe('Foo-Verwaltung');
  });
});
