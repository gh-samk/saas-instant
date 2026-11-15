import {
  notificationRows,
  subjectFor,
  lockKeyFor,
  systemRow,
  submittedDetails,
} from './public.service';
import type { PublicInquiryDto } from './dto/inquiry.dto';

const demo: PublicInquiryDto = {
  inquiryKind: 'demo',
  email: 'gast@example.com',
  name: 'Gast',
};

const pilot: PublicInquiryDto = {
  inquiryKind: 'pilot',
  email: 'alex@example.com',
  name: 'Alex',
  company: 'Solawi Beispiel',
  kind: 'Solawi',
  size: '30 Menschen',
  message: 'Wir hätten Interesse.',
};

describe('systemRow', () => {
  it('ist EINE Zeile und nennt Art und Tag', () => {
    expect(systemRow('pilot', '2026-08-31', false)).toBe(
      'Pilot-Anfrage über das Formular, 31.08.2026',
    );
  });

  it('vermerkt die AGB-Zustimmung in Worten des Systems', () => {
    expect(systemRow('pilot', '2026-09-12', false, true)).toBe(
      'Pilot-Anfrage über das Formular, 12.09.2026 · AGB-Zustimmung erteilt',
    );
  });

  it('macht bei einer Dublette kenntlich, dass es die zweite Anfrage ist', () => {
    expect(systemRow('demo', '2026-08-31', true)).toBe(
      'Erneute Demo-Anfrage über das Formular, 31.08.2026',
    );
  });

  it('enthält KEINEN Fremdtext — auch nicht die Adresse ([K1])', () => {
    // Diese Notiz ist unveränderlich. Was unveränderlich ist, darf ein
    // Unbeteiligter nicht schreiben können.
    const row = systemRow('pilot', '2026-08-31', true);
    expect(row).not.toContain('@');
    expect(row).not.toContain(pilot.email);
    expect(row).not.toContain('Solawi Beispiel');
    expect(row.split('\n')).toHaveLength(1);
  });
});

describe('submittedDetails', () => {
  it('nennt jede Angabe eingefasst hinter einem Feldnamen des Systems', () => {
    const text = submittedDetails(pilot, pilot.email);
    expect(text).not.toBeNull();
    expect(text).toContain('Übermittelte Angaben aus dem Formular');
    expect(text).toContain('Organisation: „Solawi Beispiel“');
    expect(text).toContain('Nachricht: „Wir hätten Interesse.“');
  });

  it('macht aus mehrzeiligem Fremdtext EINE Zeile ([K1])', () => {
    const attack = {
      ...demo,
      message:
        'Nichts weiter.\nStatus gewechselt: Zahlend -> Beendet, 01.01.2026',
    };

    const text = submittedDetails(attack, attack.email);

    // Der Angriff hätte eine eigene Zeile gebraucht, die wie eine Systemzeile
    // aussieht. Es gibt genau so viele Zeilen wie Feldnamen.
    const rows = (text ?? '').split('\n');
    expect(rows).toHaveLength(4);
    expect(rows.some((z) => z.startsWith('Status gewechselt'))).toBe(false);
    expect(text).toContain(
      'Nachricht: „Nichts weiter. Status gewechselt: Zahlend -> Beendet, 01.01.2026“',
    );
  });

  it('lässt leere Angaben weg statt sie leer hinzuschreiben', () => {
    const text = submittedDetails(demo, demo.email);
    expect(text).not.toContain('Organisation:');
    expect(text).not.toContain('Nachricht:');
  });

  it('liefert nichts, wenn außer der Adresse nichts kam', () => {
    const only = { inquiryKind: 'demo' as const, email: 'gast@example.com' };
    // Die Adresse allein steht bereits am Datensatz.
    expect(submittedDetails(only, only.email)).toContain('E-Mail');
    expect(submittedDetails({ ...only, email: '' }, '')).toBeNull();
  });
});

describe('subjectFor', () => {
  it('unterscheidet Demo und Pilot', () => {
    expect(subjectFor('demo')).toBe('Neue Demo-Anfrage');
    expect(subjectFor('pilot', 'Solawi Beispiel')).toBe(
      'Pilotphase-Anfrage – Solawi Beispiel',
    );
  });
});

describe('notificationRows', () => {
  const URL = 'https://verwaltung.example/companies/org-1';

  it('verweist mit einer anklickbaren Adresse auf die Organisation', () => {
    // Vorher stand hier die nackte Kennung („Organisation org-1"), die man
    // von Hand in ein Suchfeld tippen musste.
    const rows = notificationRows(pilot, pilot.email, 'org-1', URL);
    expect(rows.join('\n')).toContain(URL);
    expect(rows.join('\n')).toContain('E-Mail: alex@example.com');
  });

  /**
   * Der Vorschautext im Postfach ist der Anfang des Textteils. Vorher war das
   * „Organisation: …" — eine Feldüberschrift statt einer Aussage.
   */
  it('beginnt mit einem Satz, der sagt, was passiert ist', () => {
    const demoRows = notificationRows(demo, demo.email, 'org-1', URL);
    expect(demoRows[0]).toContain('Demo');
    expect(demoRows[0]).toMatch(/\.$/);

    const pilotRows = notificationRows(pilot, pilot.email, 'org-1', URL);
    expect(pilotRows[0]).toContain('Pilotphase');
    expect(pilotRows[0]).not.toBe(demoRows[0]);
  });

  it('endet mit der Handlungsanweisung und dem Verweis', () => {
    const rows = notificationRows(pilot, pilot.email, 'org-1', URL);
    expect(rows[rows.length - 1]).toBe(URL);
    expect(rows[rows.length - 2]).toContain('Verwaltung');
  });

  /**
   * Leerzeilen trennen die Absätze des HTML-Teils (`htmlAusText`). ZWEI
   * hintereinander ergäben einen leeren Absatz — und genau das entsteht,
   * wenn bei einer Demo-Anfrage Organisation, Art und Größe alle fehlen.
   */
  it('erzeugt keine doppelten Leerzeilen, wenn Felder fehlen', () => {
    const short = notificationRows(
      { inquiryKind: 'demo', email: 'nur@example.com' },
      'nur@example.com',
      'org-1',
      URL,
    );
    for (let i = 1; i < short.length; i += 1) {
      expect(short[i] === '' && short[i - 1] === '').toBe(false);
    }
  });
});

describe('lockKeyFor', () => {
  it('ist für dieselbe Adresse derselbe — unabhängig von Schreibweise', () => {
    expect(lockKeyFor('Alex@Example.COM ')).toBe(
      lockKeyFor('alex@example.com'),
    );
  });

  it('ist für verschiedene Adressen verschieden', () => {
    expect(lockKeyFor('a@example.com')).not.toBe(
      lockKeyFor('b@example.com'),
    );
  });

  it('passt in einen 64-Bit-Wert, wie ihn Postgres verlangt', () => {
    const value = lockKeyFor('alex@example.com');
    expect(value).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(value).toBeLessThan(2n ** 63n);
  });
});

describe('Die Benachrichtigung sagt, was wirklich passiert ist (15.09.2026)', () => {
  const URL = 'https://verwaltung.example/companies/org-1';
  const first = (outcome: Parameters<typeof notificationRows>[4], dto = demo) =>
    notificationRows(dto, dto.email, 'org-1', URL, outcome)[0];

  it('behauptet den Versand nur, wenn er stattfand', () => {
    expect(first('credentials_sent')).toContain('automatisch hinausgegangen');
    for (const outcome of ['already_triggered', 'quota_exhausted', 'send_failed'] as const) {
      expect(first(outcome)).not.toContain('automatisch hinausgegangen');
    }
  });

  it('sagt bei Schutzgrenze und Fehlschlag, dass Handarbeit nötig ist', () => {
    expect(first('quota_exhausted')).toContain('von Hand');
    expect(first('send_failed')).toContain('von Hand');
    expect(first('send_failed', pilot)).toContain('selbst antworten');
  });

  it('endet in jedem Fall mit einem Punkt', () => {
    for (const dto of [demo, pilot]) {
      for (const outcome of [
        'credentials_sent',
        'confirmation_sent',
        'already_triggered',
        'quota_exhausted',
        'send_failed',
      ] as const) {
        expect(first(outcome, dto)).toMatch(/\.$/);
      }
    }
  });

  it('markiert Handarbeit schon im Betreff', () => {
    expect(subjectFor('demo', undefined, 'credentials_sent')).toBe('Neue Demo-Anfrage');
    expect(subjectFor('demo', undefined, 'send_failed')).toBe(
      'Neue Demo-Anfrage – bitte von Hand antworten',
    );
    expect(subjectFor('pilot', 'Solawi Beispiel', 'already_triggered')).toBe(
      'Pilotphase-Anfrage – Solawi Beispiel',
    );
  });
});

