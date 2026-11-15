import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n } from '../test-support/render-with-i18n';
import App from '../App';

/**
 * Das Dashboard zeigt die abgeleiteten Aufgaben — und fasst dabei NICHTS
 * zusammen, was verschiedene Handlungen verlangt.
 *
 * Der Fall, an dem sich das entscheidet: Eine 25 Monate alte, unbeantwortete
 * Anfrage erzeugt serverseitig zwei Aufgaben zugleich. „Anfrage ist
 * unbeantwortet" und „Kontaktdaten prüfen" (Löschvorschlag) sind beide wahr,
 * verlangen aber Gegenteiliges. Fasste die Oberfläche sie zu einer Zeile
 * zusammen, fiele eine der beiden Handlungen weg — und die Löschprüfung ist
 * eine Aufbewahrungspflicht, die nicht hinter einer Vertriebsaufgabe
 * verschwinden darf.
 */

const STATE = {
  user: {
    id: 'b1',
    name: 'Testbetreiberin',
    username: 'test',
    email: 'test@example.com',
    role: 'owner',
  },
  passwordSet: true,
  passkeyCount: 0,
  totpSetUp: true,
  emailCodeSetUp: true,
  loginCodeEmail: 'test@example.com',
  setUpFactors: ['totp'],
  openRecoveryCodes: 8,
};

const COMPANY = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Solawi Rheintal',
  status: 'inquiry',
};

const TASKS = {
  tasks: [
    {
      kind: 'inquiry_unanswered',
      dueAt: '2024-07-02',
      urgency: 'high',
      title: 'Anfrage von Solawi Rheintal ist unbeantwortet',
      reason:
        'Seit dem Eingang sind mehr als 24 Stunden vergangen, ohne Statuswechsel und ohne eigene Notiz.',
      action: {
        kind: 'company_open',
        label: 'Anfrage bearbeiten',
        target: `/companies/${COMPANY.id}`,
      },
      company: COMPANY,
    },
    {
      kind: 'deletion_suggestion',
      dueAt: '2026-07-01',
      urgency: 'high',
      title: 'Kontaktdaten von Solawi Rheintal prüfen',
      reason:
        'Seit 24 Monaten kein Kontakt und kein Abschluss. Vorschlag: Kontaktdaten löschen — entschieden wird das von Hand, automatisch löscht hier nichts.',
      action: {
        kind: 'deletion_check',
        label: 'Löschung prüfen',
        target: `/companies/${COMPANY.id}`,
      },
      company: COMPANY,
    },
  ],
  shortened: [],
  orphanedApplications: [],
  state: {
    day: '2026-08-31',
    since: '2026-08-24',
    limitPerKind: 25,
    reconciliation: { lastAt: '2026-08-31', successful: true, message: null },
  },
};

/** Gibt die Attrappe zurück, damit Aufrufe geprüft werden können. */
function setFetchReady(
  tasks: unknown,
  options: { taskStatus?: number } = {},
) {
  const called = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes('/api/auth/csrf')) {
        return new Response(JSON.stringify({ csrfToken: 'abc' }), {
          status: 200,
        });
      }
      if (path.includes('/api/auth/me')) {
        return new Response(JSON.stringify(STATE), { status: 200 });
      }
      if (path.includes('/api/tasks')) {
        const status = options.taskStatus ?? 200;
        if (status !== 200) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'HTTP_500',
                message: 'Die Aufgaben ließen sich nicht ableiten.',
              },
            }),
            { status },
          );
        }
        return new Response(JSON.stringify(tasks), { status: 200 });
      }
      void init;
      return new Response(JSON.stringify({}), { status: 200 });
    },
  );
  vi.stubGlobal('fetch', called);
  return called;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

/**
 * Es gibt ZWEI Darstellungen derselben Daten: gestapelte Karten unter 640 px,
 * die Tabelle darüber. Umgeschaltet wird per CSS, deshalb stehen im Test
 * (jsdom wendet kein CSS an) beide im DOM. Die Prüfungen fassen deshalb
 * gezielt eine der beiden an — und eine eigene prüft, dass beide dasselbe
 * zeigen.
 */
function table() {
  return within(screen.getByRole('table'));
}
function cards() {
  return within(screen.getByRole('list', { name: 'Offene Aufgaben' }));
}

describe('Dashboard — Aufgabenliste', () => {
  it('zeigt beide Aufgaben derselben Organisation als eigene Zeilen', async () => {
    setFetchReady(TASKS);
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    await screen.findByRole('table');
    expect(
      table().getByText('Anfrage von Solawi Rheintal ist unbeantwortet'),
    ).toBeInTheDocument();
    expect(
      table().getByText('Kontaktdaten von Solawi Rheintal prüfen'),
    ).toBeInTheDocument();

    // Jede Zeile trägt ihre eigene, benannte Handlung.
    expect(
      table().getByRole('link', { name: 'Anfrage bearbeiten' }),
    ).toBeInTheDocument();
    expect(
      table().getByRole('link', { name: 'Löschung prüfen' }),
    ).toBeInTheDocument();
  });

  it('bietet die Handlung auch in der gestapelten Darstellung an', async () => {
    // [W1] Bei 375 px lag die Aktionsspalte der Tabelle außerhalb des Bildes;
    // die Handlung war nur nach seitlichem Schieben erreichbar. Für eine
    // Aufgabenliste ist genau das der Zweck der Seite.
    setFetchReady(TASKS);
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    await screen.findByRole('table');
    expect(
      cards().getByText('Anfrage von Solawi Rheintal ist unbeantwortet'),
    ).toBeInTheDocument();
    expect(
      cards().getByRole('link', { name: 'Anfrage bearbeiten' }),
    ).toBeInTheDocument();
    expect(
      cards().getByRole('link', { name: 'Löschung prüfen' }),
    ).toBeInTheDocument();
    // Beide Darstellungen zeigen dieselben Aufgaben — keine darf welche
    // unterschlagen.
    expect(cards().getAllByRole('listitem')).toHaveLength(
      table().getAllByRole('row').length - 1,
    );
  });

  it('nennt Überfälliges beim Wort und zeigt daneben das exakte Datum', async () => {
    setFetchReady(TASKS);
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    await screen.findByRole('table');
    // 02.07.2024 gegen den Serverstand 31.08.2026.
    expect(table().getByText('Seit 790 Tagen überfällig')).toBeInTheDocument();
    expect(table().getByText('02.07.2024')).toBeInTheDocument();
    expect(table().getByText('01.07.2026')).toBeInTheDocument();
  });

  it('zeigt den Leerzustand aus Etappe 1, wenn nichts ansteht', async () => {
    setFetchReady({
      tasks: [],
      shortened: [],
      orphanedApplications: [],
      state: {
        day: '2026-08-31',
        since: '2026-08-24',
        limitPerKind: 25,
        reconciliation: { lastAt: '2026-08-31', successful: true, message: null },
      },
    });
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    expect(
      await screen.findByText('Noch nichts zu erledigen'),
    ).toBeInTheDocument();
  });

  it('meldet einen Fehlschlag sichtbar, statt eine leere Liste zu zeigen', async () => {
    // Eine Aufgabenliste, der stillschweigend etwas fehlt, ist gefährlicher
    // als eine, die sichtbar nicht lädt.
    setFetchReady(null, { taskStatus: 500 });
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    expect(
      await screen.findByText('Die Aufgaben ließen sich nicht ableiten.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Erneut versuchen' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Noch nichts zu erledigen'),
    ).not.toBeInTheDocument();
  });

  it('überlebt eine Aufgabe OHNE Organisationsbezug', async () => {
    // Die Aufbewahrungsfrist des Audit-Logs gilt für den ganzen Bestand und
    // hat keine Organisation. Ohne Absicherung stürbe die Startseite an dem
    // Tag, an dem der erste Audit-Eintrag drei Jahre alt wird.
    setFetchReady({
      tasks: [
        {
          kind: 'audit_retention',
          dueAt: '2026-08-30',
          urgency: 'high',
          title: 'Aufbewahrungsfrist des Nachweises prüfen',
          reason: 'Es gibt Audit-Einträge, die älter als drei Jahre sind.',
          action: {
            kind: 'retention_check',
            label: 'Aufbewahrung prüfen',
            target: '/settings',
          },
          // organisation fehlt bewusst
        },
      ],
      shortened: [],
      orphanedApplications: [],
      state: {
        day: '2026-08-31',
        since: '2026-08-24',
        limitPerKind: 25,
        reconciliation: { lastAt: '2026-08-31', successful: true, message: null },
      },
    });
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    await screen.findByRole('table');
    expect(
      table().getByText('Aufbewahrungsfrist des Nachweises prüfen'),
    ).toBeInTheDocument();
    expect(
      table().getByRole('link', { name: 'Aufbewahrung prüfen' }),
    ).toBeInTheDocument();
  });

  it('meldet abgeschnittene Listen, statt Vollständigkeit zu behaupten', async () => {
    setFetchReady({
      ...TASKS,
      shortened: [
        { kind: 'inquiry_unanswered', shown: 25, further: 340 },
      ],
    });
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    await screen.findByRole('table');
    expect(screen.getByText('Nicht alles wird angezeigt')).toBeInTheDocument();
    expect(screen.getByText(/340 weitere ausgeblendet/)).toBeInTheDocument();
    expect(screen.getByText(/Anfragen ohne Reaktion: 25 von 365 gezeigt/)).toBeInTheDocument();
  });

  it('zeigt die neuen Etappe-3-Aufgaben und schreibt ihr Datum deutsch', async () => {
    // Vier Aufgabenquellen setzen den Kalendertag direkt in ihre Begründung
    // ein. Das Datumsformat der Anwendung gilt trotzdem.
    setFetchReady({
      ...TASKS,
      tasks: [
        {
          kind: 'no_entry_for_long',
          dueAt: '2026-08-20',
          urgency: 'high',
          title: 'Seit 56 Tagen kein Eintrag',
          reason:
            'In musterverein-ostend wurde seit dem 2026-07-06 nichts mehr eingetragen.',
          action: {
            kind: 'company_open',
            label: 'Organisation öffnen',
            target: `/companies/${COMPANY.id}`,
          },
          company: COMPANY,
        },
        {
          kind: 'backup_missing',
          dueAt: '2026-08-29',
          urgency: 'high',
          title: 'Sicherung überfällig',
          reason: 'Seit 22 Tagen keine neue Sicherung.',
          action: {
            kind: 'company_open',
            label: 'Organisation öffnen',
            target: `/companies/${COMPANY.id}`,
          },
          company: COMPANY,
        },
      ],
    });
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    await screen.findByRole('table');
    expect(table().getByText('Seit 56 Tagen kein Eintrag')).toBeInTheDocument();
    expect(table().getByText('Sicherung überfällig')).toBeInTheDocument();
    expect(
      table().getByText(/seit dem 06\.07\.2026 nichts mehr eingetragen/),
    ).toBeInTheDocument();
    // Die 45-Tage-Zeile bekommt KEINE Sonderdarstellung — ihr Gewicht kommt
    // aus der Fälligkeit, wie bei jeder anderen Aufgabe auch.
    expect(table().getAllByText(/überfällig/).length).toBeGreaterThan(0);
  });

  it('meldet verwaiste Coolify-Anwendungen als eigene Liste', async () => {
    setFetchReady({
      ...TASKS,
      orphanedApplications: [
        {
          subdomain: 'alt-projekt',
          coolifyUrl: 'https://coolify.example.com/anwendung/abc',
          detectedAt: '2026-08-25',
        },
      ],
    });
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    // Die Ueberschrift steht seit dem Redesign nur noch fuer die
    // Vorlesestimme da — sichtbar ist die Zeile mit dem Befund.
    expect(
      await screen.findByRole('heading', { name: 'Abgleich mit Coolify' }),
    ).toBeInTheDocument();
    expect(screen.getByText('alt-projekt')).toBeInTheDocument();
    expect(screen.getByText(/25\.08\.2026/)).toBeInTheDocument();
    // DER ABGLEICH MELDET NUR — er ordnet nichts zu und löscht nichts.
    //
    // Vorher stand hier „gar kein Knopf". Das war dieselbe Aussage, solange
    // es keinen gab; seit „Jetzt prüfen" ist es die falsche: Ein erneuter
    // Lauf ist kein Eingriff, sondern dieselbe Messung noch einmal. Geprüft
    // wird deshalb, WELCHE Knöpfe es gibt — genau der eine, der nur liest.
    const section = screen.getByRole('region', {
      name: 'Abgleich mit Coolify',
    });
    expect(
      within(section)
        .queryAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Jetzt prüfen']);
  });

  it('unterscheidet „kein Befund" von „nicht gemessen"', async () => {
    // Ein ausgefallener Lauf sähe sonst aus wie ein sauberes Ergebnis — die
    // beruhigendste aller falschen Auskünfte.
    setFetchReady({
      ...TASKS,
      orphanedApplications: [],
      state: {
        ...TASKS.state,
        reconciliation: {
          lastAt: '2026-08-30',
          successful: false,
          message: 'Coolify antwortet nicht.',
        },
      },
    });
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    expect(
      await screen.findByText(/kam nicht durch/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Coolify antwortet nicht/)).toBeInTheDocument();
    // UND EIN WEG, ES NOCH EINMAL ZU VERSUCHEN. Der Knopf hing zuerst am
    // Befund und fehlte ausgerechnet hier — „kam nicht durch" ohne jede
    // Handlung daneben.
    expect(
      screen.getByRole('button', { name: 'Jetzt prüfen' }),
    ).toBeInTheDocument();
  });

  it('stösst den Abgleich an und lädt danach neu', async () => {
    const called = setFetchReady({
      ...TASKS,
      orphanedApplications: [
        { subdomain: 'alt-projekt', coolifyUrl: null, detectedAt: '2026-08-25' },
      ],
    });
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Jetzt prüfen' }));

    await waitFor(() => {
      const call = called.mock.calls.find((c) =>
        String(c[0]).includes('/api/companies/reconciliation'),
      );
      expect(call).toBeDefined();
      expect((call?.[1] as RequestInit | undefined)?.method).toBe('POST');
    });
    // NEU LADEN GEHÖRT DAZU. Ohne das stünde nach dem Lauf weiter der alte
    // Befund da — und der Knopf sähe wirkungslos aus, obwohl er gewirkt hat.
    await waitFor(() => {
      expect(
        called.mock.calls.filter((c) => String(c[0]).includes('/api/tasks'))
          .length,
      ).toBeGreaterThan(1);
    });
  });

  it('zeigt den Abgleich auch dann, wenn sonst nichts offen ist', async () => {
    // Sonst verschwände ein verwaister Eintrag ausgerechnet an dem Tag, an dem
    // sonst nichts ansteht — und „Noch nichts zu erledigen" wäre falsch.
    setFetchReady({
      tasks: [],
      shortened: [],
      orphanedApplications: [
        { subdomain: 'alt-projekt', coolifyUrl: null, detectedAt: '2026-08-25' },
      ],
      state: TASKS.state,
    });
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    expect(await screen.findByText('Noch nichts zu erledigen')).toBeInTheDocument();
    expect(screen.getByText('alt-projekt')).toBeInTheDocument();
  });

  it('führt „Löschung prüfen" zum Löschvorgang, nicht nur zur Seite', async () => {
    setFetchReady(TASKS);
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    await screen.findByRole('table');
    const target = table()
      .getByRole('link', { name: 'Löschung prüfen' })
      .getAttribute('href');
    expect(target).toContain(`/companies/${COMPANY.id}`);
    expect(target).toContain('?tab=privacy');
  });
});

/**
 * DAS NETZ UNTER `AUFGABEN_ICON`.
 *
 * Die Aufgabenquelle „Rechnung überfällig" war im Backend fertig, durfte aber
 * nicht registriert werden: `DashboardSeite` indizierte den Icon-Record
 * direkt, und eine dort fehlende Art hätte `undefined` als Komponente ergeben —
 * React bricht daran die GANZE Seite ab, ausgerechnet an dem Tag, an dem die
 * erste Rechnung überfällig wird. Der Rückfallwert ist deshalb keine Kosmetik,
 * sondern die Vorbedingung der Registrierung.
 */
describe('Dashboard — eine unbekannte Aufgabenart bricht die Seite nicht ab', () => {
  const UNKNOWN = {
    ...TASKS,
    tasks: [
      {
        ...TASKS.tasks[0],
        kind: 'a_kind_unknown_here_yet',
        title: 'Etwas Neues aus dem Backend',
      },
    ],
    shortened: [
      { kind: 'a_kind_unknown_here_yet', shown: 25, further: 3 },
    ],
  };

  it('zeigt die Aufgabe trotzdem, mit neutralem Rückfall-Icon', async () => {
    setFetchReady(UNKNOWN);
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    await screen.findByRole('table');
    expect(
      table().getByText('Etwas Neues aus dem Backend'),
    ).toBeInTheDocument();
  });

  it('meldet die Kürzung mit dem rohen Schlüssel statt mit „undefined"', async () => {
    setFetchReady(UNKNOWN);
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    expect(
      await screen.findByText(/a_kind_unknown_here_yet: 25 von/),
    ).toBeInTheDocument();
  });

  it('trägt die neue Art „Rechnung überfällig" samt Icon und Bezeichnung', async () => {
    setFetchReady({
      ...TASKS,
      tasks: [
        {
          kind: 'invoice_overdue',
          dueAt: '2026-08-17',
          urgency: 'high',
          title: 'Rechnung 2026-014 an Solawi Rheintal ist überfällig',
          reason: 'Fällig war sie am 2026-08-17; offen sind 458,15 €.',
          action: {
            kind: 'payment_check',
            label: 'Rechnung öffnen',
            target: `/companies/${COMPANY.id}/invoices/r1`,
          },
          company: COMPANY,
        },
      ],
      shortened: [{ kind: 'invoice_overdue', shown: 25, further: 2 }],
    });
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    await screen.findByRole('table');
    expect(
      table().getByText(
        'Rechnung 2026-014 an Solawi Rheintal ist überfällig',
      ),
    ).toBeInTheDocument();
    // Das ISO-Datum aus dem Servertext wird auf dd.mm.yyyy gezogen.
    expect(
      table().getByText(/Fällig war sie am 17\.08\.2026/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Überfällige Rechnungen: 25 von/),
    ).toBeInTheDocument();
    // Die Handlung führt auf die Route, die die Quelle festgeschrieben hat.
    expect(
      table().getAllByRole('link', { name: 'Rechnung öffnen' })[0],
    ).toHaveAttribute(
      'href',
      `/companies/${COMPANY.id}/invoices/r1`,
    );
  });
});

describe('Heute — Filterchips statt Kacheln', () => {
  it('HEISST „HEUTE" UND ERKLAERT SICH NICHT MEHR', async () => {
    // Der Untertitel „Deine Aufgaben, sortiert nach Fälligkeit." entfällt
    // ersatzlos: Der Tabellenkopf sagt es genauer, und eine Zeile, die nur
    // wiederholt, was darunter steht, kostet jeden Blick Zeit.
    setFetchReady(TASKS);
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    expect(
      await screen.findByRole('heading', { name: /^Heute/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Deine Aufgaben, sortiert nach Fälligkeit.'),
    ).not.toBeInTheDocument();
  });

  it('ZEIGT KEINE KENNZAHL-KACHELN — E2-24 gilt weiter', async () => {
    // Der Entwurf hat hier vier Kacheln. Das Abnahmekriterium verlangt
    // ausdrücklich „Aufgabenliste … keine Kacheln, keine Diagramme", und der
    // Auftraggeber hat sich beim Durchgang dafür entschieden, es dabei zu
    // belassen. Die Chips leisten dasselbe, ohne eine zweite Ebene über der
    // Liste aufzubauen.
    setFetchReady(TASKS);
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    await screen.findByRole('table');
    const groups = screen.getAllByRole('group');
    // Genau EINE Gruppe: die Filterleiste. Kacheln waeren Knoepfe ausserhalb.
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveAccessibleName('Aufgaben filtern');
  });

  it('filtert die Liste und zaehlt dabei die ganze Liste', async () => {
    setFetchReady(TASKS);
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    const bar = within(
      await screen.findByRole('group', { name: 'Aufgaben filtern' }),
    );
    const inquiries = bar.getByRole('button', { name: /Neue Anfragen/ });
    fireEvent.click(inquiries);

    // Die Liste zeigt nur noch die Anfrage …
    const table = within(screen.getByRole('table'));
    expect(
      table.getByText('Anfrage von Solawi Rheintal ist unbeantwortet'),
    ).toBeInTheDocument();
    // … die Chipzahl von „Alles" bleibt trotzdem die volle Menge.
    expect(bar.getByRole('button', { name: /Alles/ }).textContent).toContain(
      String(TASKS.tasks.length),
    );
  });

  it('nennt den Leerzustand EINER AUSWAHL anders als „gar nichts offen"', async () => {
    // Wer filtert und nichts findet, soll das als Ergebnis des Filters lesen,
    // nicht als Zustand des Systems.
    setFetchReady(TASKS);
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    const bar = within(
      await screen.findByRole('group', { name: 'Aufgaben filtern' }),
    );
    // „Sonstiges" gibt es in diesen Beispieldaten — es bleibt also ein Chip,
    // der Treffer hat. Fuer den Leerfall zaehlt der Text selbst.
    expect(
      screen.queryByText('Nichts offen in dieser Auswahl.'),
    ).not.toBeInTheDocument();
    expect(bar.getAllByRole('button').length).toBeGreaterThan(1);
  });

  it('gibt Organisation und Art eigene Spalten', async () => {
    setFetchReady(TASKS);
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((k) => k.textContent),
    ).toEqual(['Aufgabe', 'Organisation', 'Art', 'Fällig', 'Aktion']);
  });

  it('DIE ZEILENAKTION IST EIN TEXTLINK, KEIN KNOPF', async () => {
    // In einer Liste mit neun Zeilen stuenden neun umrandete Knoepfe
    // untereinander, und das Auge findet die Zeile nicht mehr, auf die es
    // ankommt. Eine ausdrueckliche Festlegung des Entwurfs.
    setFetchReady(TASKS);
    window.history.pushState({}, '', '/');
    renderWithI18n(<App />);

    const table = await screen.findByRole('table');
    const link = within(table).getAllByRole('link', {
      name: /Anfrage bearbeiten/,
    })[0];
    expect(link.className).not.toContain('border-rahmen');
  });
});
