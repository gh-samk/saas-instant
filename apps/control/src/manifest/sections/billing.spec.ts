import { checkBilling, DEFAULT_RETENTION_YEARS } from './billing';

describe('Manifest billing: Rechtsform und Aufbewahrung', () => {
  it('Standard: keine Rechtsform, keine Aufbewahrungsangabe', () => {
    const error: string[] = [];
    const b = checkBilling({}, error);
    expect(error).toEqual([]);
    expect(b.issuer.legalForm).toBeNull();
    expect(b.retentionYears).toBeNull();
    expect(DEFAULT_RETENTION_YEARS).toBe(8);
  });

  it.each(['company', 'sole_proprietor', 'association'])(
    'akzeptiert legalForm %s',
    (legalForm) => {
      const error: string[] = [];
      const b = checkBilling({ issuer: { name: 'X', legalForm } }, error);
      expect(error).toEqual([]);
      expect(b.issuer.legalForm).toBe(legalForm);
    },
  );

  it('lehnt eine unbekannte Rechtsform mit Pfad ab', () => {
    const error: string[] = [];
    checkBilling({ issuer: { name: 'X', legalForm: 'gmbh' } }, error);
    expect(error.join('\n')).toContain('billing.issuer.legalForm');
  });

  it('liest retentionYears und prüft den Bereich', () => {
    const ok: string[] = [];
    expect(checkBilling({ retentionYears: 10 }, ok).retentionYears).toBe(10);
    expect(ok).toEqual([]);

    for (const bad of [0, 2.5, 31]) {
      const error: string[] = [];
      checkBilling({ retentionYears: bad }, error);
      expect(error.join('\n')).toContain('billing.retentionYears');
    }
  });
});
