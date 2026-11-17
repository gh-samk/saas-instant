import { statusLabelOf } from './status-label';

describe('statusLabelOf', () => {
  it('kennt die fünf aktuellen Status', () => {
    expect(
      ['inquiry', 'trial', 'paying', 'exempt', 'ended'].map(statusLabelOf),
    ).toEqual(['Anfrage', 'Testphase', 'Zahlend', 'Beitragsbefreit', 'Beendet']);
  });

  it('liest die Altwerte aus alten Audit-Einträgen mit ihren damaligen Namen', () => {
    expect(
      [
        'demo',
        'pilot_approved',
        'pilot_running',
        'review_pending',
        'dormant',
      ].map(statusLabelOf),
    ).toEqual([
      'Demo',
      'Pilot beschlossen',
      'Pilot läuft',
      'Überprüfung offen',
      'Ruhend',
    ]);
  });

  it('lässt Unbekanntes unverändert stehen', () => {
    expect(statusLabelOf('irgendwas')).toBe('irgendwas');
  });
});
