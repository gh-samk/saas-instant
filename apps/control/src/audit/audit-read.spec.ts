import { SECURITY_ACTIONS, SECURITY_TEXTS } from './audit-read';

describe('Sicherheitsprotokoll: Klartexte', () => {
  it('hinterlegt für jede Protokollaktion einen deutschen Klartext', () => {
    const missing = SECURITY_ACTIONS.filter((action) => !SECURITY_TEXTS[action]);
    expect(missing).toEqual([]);
  });

  it('beschriftet die Tresor-Aktionen lesbar, nicht mit der Kennung', () => {
    expect(SECURITY_TEXTS['vault.initialized']).toBe('Datenverschlüsselung eingerichtet');
    for (const action of SECURITY_ACTIONS.filter((a) => a.startsWith('vault.'))) {
      expect(SECURITY_TEXTS[action]).not.toContain('vault.');
    }
  });
});
