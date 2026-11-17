import { noteText } from './status-change';
import { differences, changeText } from './company.service';
import type { CompanyResponse } from './company.response';

describe('noteText', () => {
  const basis = {
    companyId: 'o1',
    action: 'company.status.changed' as const,
    actor: 'sam',
    userId: null,
  };

  it('schreibt den Wechsel mit deutschen Bezeichnungen und Tagesdatum', () => {
    expect(
      noteText(
        {
          ...basis,
          fromStatus: 'inquiry',
          afterStatus: 'trial',
          introduction: 'Status gewechselt',
        },
        '2026-08-31',
      ),
    ).toBe('Status gewechselt: Anfrage → Testphase, 31.08.2026');
  });

  it('hängt den Grund an, wenn der Zeitplan gehandelt hat', () => {
    expect(
      noteText(
        {
          ...basis,
          fromStatus: 'trial',
          afterStatus: 'paying',
          introduction: 'Status automatisch gewechselt',
          reason: '14 Tage nach dem Instanzstart',
        },
        '2026-08-31',
      ),
    ).toBe(
      'Status automatisch gewechselt: Testphase → Zahlend, 31.08.2026 ' +
        '(14 Tage nach dem Instanzstart)',
    );
  });
});

describe('wechseltext (Ansprechpartnerin)', () => {
  it('nennt den Wortlaut aus dem Auftragsdokument', () => {
    expect(changeText('Anna Berg', 'Tim Roth', '2027-03-12')).toBe(
      'Ansprechpartnerin gewechselt: Anna Berg → Tim Roth, 12.03.2027',
    );
  });

  it('behauptet keinen Wechsel, wenn es vorher keine gab', () => {
    expect(changeText(null, 'Tim Roth', '2027-03-12')).toBe(
      'Ansprechpartnerin gesetzt: Tim Roth, 12.03.2027',
    );
    expect(changeText('   ', 'Tim Roth', '2027-03-12')).toBe(
      'Ansprechpartnerin gesetzt: Tim Roth, 12.03.2027',
    );
  });
});

describe('differences', () => {
  const base = {
    id: 'o1',
    name: 'Solawi',
    city: 'Kassel',
    updatedAt: '2026-08-31T10:00:00.000Z',
  } as unknown as CompanyResponse;

  it('nennt nur die tatsächlich geänderten Felder', () => {
    const after = {
      ...base,
      city: 'Marburg',
      updatedAt: '2026-08-31T11:00:00.000Z',
    } as unknown as CompanyResponse;

    expect(differences(base, after)).toEqual({
      old: { city: 'Kassel' },
      newValue: { city: 'Marburg' },
    });
  });

  it('meldet nichts, wenn sich nur der technische Zeitstempel bewegt hat', () => {
    const after = {
      ...base,
      updatedAt: '2026-08-31T11:00:00.000Z',
    } as unknown as CompanyResponse;

    expect(differences(base, after)).toEqual({ old: {}, newValue: {} });
  });
});
