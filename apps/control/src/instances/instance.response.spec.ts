import type { Metric, Backup } from '.prisma/control-client';
import {
  invitationLinkFrom,
  daysBetween,
  toMetrics,
  toBackup,
} from './instance.response';
import { BACKUP_MISSING_AFTER_DAYS } from './instance.rules';

const TODAY = '2026-08-31';

function metric(
  day: string,
  values: Partial<Metric> = {},
): Metric {
  return {
    id: `k-${day}`,
    instanceId: 'i1',
    date: new Date(`${day}T00:00:00.000Z`),
    activePersons: 34,
    circles: 6,
    lastEntryAt: new Date('2026-08-19T00:00:00.000Z'),
    lastLoginAt: new Date('2026-08-28T00:00:00.000Z'),
    appVersion: '0.5.2',
    fetchSuccessful: true,
    errorKind: null,
    databaseState: 'erreichbar',
    ...values,
  } as Metric;
}

function backup(day: string, bytes = 2_400_000_000): Backup {
  return {
    id: `s-${day}`,
    instanceId: 'i1',
    date: new Date(`${day}T00:00:00.000Z`),
    sizeBytes: BigInt(bytes),
    createdAt: new Date(`${day}T02:00:00.000Z`),
  } as Backup;
}

describe('toMetrics — der feste 21-Tage-Vergleich', () => {
  it('nennt den Vergleichswert, sobald eine drei Wochen alte Zeile vorliegt', () => {
    const values = toMetrics(
      [
        metric('2026-08-31'),
        metric('2026-08-20', { activePersons: 30, circles: 5 }),
        metric('2026-08-10', { activePersons: 28, circles: 5 }),
      ],
      TODAY,
    );

    expect(values?.activePersons).toEqual({ current: 34, beforeThreeWeeks: 28 });
    expect(values?.circles).toEqual({ current: 6, beforeThreeWeeks: 5 });
  });

  it('lässt den Vergleich bei einer jungen Instanz WEG statt eine 0 zu erfinden', () => {
    const values = toMetrics([metric('2026-08-31'), metric('2026-08-29')], TODAY);

    expect(values?.activePersons.beforeThreeWeeks).toBeNull();
    expect(values?.circles.beforeThreeWeeks).toBeNull();
  });

  it('gibt null zurück, wenn es gar keine Zeile gibt', () => {
    expect(toMetrics([], TODAY)).toBeNull();
  });
});

describe('toMetrics — fehlgeschlagene Abfragen (E3-7)', () => {
  it('zählt die Tage seit der letzten ERFOLGREICHEN Abfrage', () => {
    const values = toMetrics(
      [
        metric('2026-08-31', { fetchSuccessful: false, errorKind: 'unreachable' }),
        metric('2026-08-30', { fetchSuccessful: false, errorKind: 'unreachable' }),
        metric('2026-08-28'),
      ],
      TODAY,
    );

    expect(values?.lastSuccessfulQueryAt).toBe('2026-08-28');
    expect(values?.sinceDaysFailed).toBe(3);
  });

  it('meldet 0, solange die letzte Abfrage erfolgreich war', () => {
    const values = toMetrics([metric('2026-08-31')], TODAY);
    expect(values?.sinceDaysFailed).toBe(0);
  });

  it('zeigt die ZULETZT GEMESSENEN Zahlen weiter, statt sie auf 0 zu setzen', () => {
    const values = toMetrics(
      [
        metric('2026-08-31', {
          fetchSuccessful: false,
          activePersons: null,
          circles: null,
          errorKind: 'timeout',
        }),
        metric('2026-08-28', { activePersons: 34 }),
      ],
      TODAY,
    );
    expect(values?.activePersons.current).toBe(34);
  });

  it('kommt mit einer Instanz zurecht, die noch nie geantwortet hat', () => {
    const values = toMetrics(
      [metric('2026-08-29', { fetchSuccessful: false, errorKind: 'no_token' })],
      TODAY,
    );
    expect(values?.lastSuccessfulQueryAt).toBeNull();
    expect(values?.sinceDaysFailed).toBe(2);
  });
});

describe('toBackup — die Stille ist das Signal', () => {
  it('nennt die letzte Sicherung samt Grösse', () => {
    const state = toBackup([backup('2026-08-31'), backup('2026-08-30')], TODAY);
    expect(state.last).toEqual({ date: '2026-08-31', sizeBytes: 2_400_000_000 });
    expect(state.missing).toBe(false);
  });

  it('meldet eine Instanz OHNE jede Sicherung als ausgeblieben', () => {
    expect(toBackup([], TODAY)).toEqual({ last: null, missing: true });
  });

  it('meldet eine zu alte Sicherung als ausgeblieben', () => {
    const toOld = toBackup([backup('2026-08-20')], TODAY);
    expect(toOld.missing).toBe(true);
  });

  it('lässt eine Sicherung genau an der Schwelle noch durchgehen', () => {
    // Die Schwelle darf nicht bei jedem verspäteten Lauf über Mitternacht
    // anschlagen — sonst wird der Alarm zur Gewohnheit (E3-18).
    expect(BACKUP_MISSING_AFTER_DAYS).toBe(2);
    expect(toBackup([backup('2026-08-29')], TODAY).missing).toBe(false);
    expect(toBackup([backup('2026-08-28')], TODAY).missing).toBe(true);
  });
});

describe('invitationLinkFrom — er trägt ein Geheimnis ([K4])', () => {
  it('gibt keinen Link mehr, sobald die Einrichtung vermerkt ist — auch ohne Kennzahlen', () => {
    // Der Fall vom 12.09.2026: eingerichtet am Vormittag, noch kein
    // Kennzahlenabruf. Vorher stand der Link bis 04:00 des Folgetags da.
    expect(
      invitationLinkFrom('active', null, 'frisch', 'example.com', TOKEN, true),
    ).toBeNull();
  });

  const valuesWith = (persons: number) =>
    toMetrics([metric('2026-08-31', { activePersons: persons })], TODAY);
  const TOKEN = 'a1b2c3'.repeat(10);

  it('zeigt den Einrichtungslink samt Geheimnis, solange er offen ist', () => {
    expect(
      invitationLinkFrom('active', valuesWith(0), 'musterverein', 'example.com', TOKEN, false),
    ).toBe(
      `https://musterverein.example.com/api/setup/start?token=${TOKEN}`,
    );
  });

  it('ist NICHT mehr erratbar — das war der ganze Befund', () => {
    const link = invitationLinkFrom('active', null, 'frisch', 'example.com', TOKEN, false);
    // Die alte Fassung war die Konstante `https://<sub>.example.com/setup`,
    // und `POST /api/setup` ist bis zum Abschluss unauthentifiziert: Wer die
    // frische Subdomain zuerst erreicht, wird Admin.
    expect(link).not.toBe('https://frisch.example.com/setup');
    expect(link).toContain('token=');
    expect(link).toContain(TOKEN);
  });

  it('kodiert das Geheimnis für die Adresszeile', () => {
    const link = invitationLinkFrom('active', null, 'x', 'example.com', 'a+b/c=d', false);
    expect(link).toContain('token=a%2Bb%2Fc%3Dd');
  });

  it('bietet GAR KEINEN Link an, wenn es kein Geheimnis gibt', () => {
    // Lieber kein Link als einer, der eine Eigenschaft behauptet, die er nicht
    // hat. Betrifft Instanzen von vor dieser Änderung.
    expect(invitationLinkFrom('active', null, 'alt', 'example.com', null, false)).toBeNull();
  });

  it('lässt ihn weg, sobald jemand die Einrichtung abgeschlossen hat', () => {
    expect(
      invitationLinkFrom('active', valuesWith(1), 'musterverein', 'example.com', TOKEN, false),
    ).toBeNull();
  });

  it('zeigt ihn nie bei einer Instanz, die nicht läuft', () => {
    expect(invitationLinkFrom('provisioning', null, 'x', 'example.com', TOKEN, false)).toBeNull();
    expect(invitationLinkFrom('archived', null, 'x', 'example.com', TOKEN, false)).toBeNull();
  });
});

describe('daysBetween', () => {
  it('zählt ganze Tage und wird nie negativ', () => {
    expect(daysBetween('2026-08-28', '2026-08-31')).toBe(3);
    expect(daysBetween('2026-08-31', '2026-08-31')).toBe(0);
    expect(daysBetween('2026-09-05', '2026-08-31')).toBe(0);
  });

  it('zählt über einen Monatswechsel richtig', () => {
    expect(daysBetween('2026-07-31', '2026-08-01')).toBe(1);
  });
});
