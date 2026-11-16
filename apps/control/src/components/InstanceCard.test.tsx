import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { ToastProvider } from '@saas-instant/ui';
import { InstanceCard } from './InstanceCard';
import type { InstanceDetail } from '../lib/api';

// Die Sicherungsansicht (InstanceBackups) fragt den zweiten Faktor über
// `useAuth` ab; die Karte selbst braucht keinen AuthProvider.
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ reload: vi.fn().mockResolvedValue(undefined), state: { totpSetUp: false } }),
}));

/**
 * Die Instanz-Karte — geprüft an dem, was fachlich trägt.
 *
 * Drei Dinge stehen im Mittelpunkt, weil sie im Auftrag ausdrücklich benannt
 * sind: Die Vorschau ist ein Pflichtschritt und wird tatsächlich gerufen; ein
 * Fehlschlag bleibt sichtbar, obwohl es keinen Status dafür gibt; und es gibt
 * keinen Weg, der löscht oder wiederherstellt — das wird als ABWESENHEIT
 * geprüft, nicht als Absichtserklärung.
 */

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

const BASIS: InstanceDetail = {
  id: 'i1',
  companyId: COMPANY_ID,
  subdomain: 'musterverein-ostend',
  status: 'active',
  appVersion: '0.5.2',
  createdAt: '2026-06-01T09:00:00.000Z',
  archivedAt: null,
  message: null,
  metrics: {
    activePersons: { current: 34, beforeThreeWeeks: 28 },
    circles: { current: 5, beforeThreeWeeks: 5 },
    lastEntryAt: '2026-08-29',
    lastLoginAt: '2026-08-30',
    lastSuccessfulQueryAt: '2026-08-31',
    sinceDaysFailed: 0,
    database: 'erreichbar',
  },
  backup: {
    last: { date: '2026-08-31', sizeBytes: 2.4 * 1024 ** 3 },
    missing: false,
  },
  invitationOpen: false,
  configuredAt: null,
  coolifyCreated: false,
};

interface Options {
  instance?: InstanceDetail | null;
  /**
   * Antwortet `GET :id/instanz` mit einem LEEREN Körper statt mit `null`?
   *
   * Genau das tut der Server: 200, `Content-Length: 0`, kein `Content-Type`
   * (live mit `fetch()` nachgemessen). Kein erfundener Fall.
   */
  emptyBody?: boolean;
  available?: boolean;
  previewStatus?: number;
  createStatus?: number;
  createErrorCode?: string;
}

function arrangeFetch(options: Options = {}) {
  const called = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (path.includes('/api/auth/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
    }
    if (path.includes('/instance/subdomain-suggestion')) {
      return new Response(JSON.stringify({ subdomain: 'musterverein-ostend' }), {
        status: 200,
      });
    }
    if (path.includes('/instance/subdomain-available')) {
      return new Response(
        JSON.stringify({ available: options.available ?? true }),
        { status: 200 },
      );
    }
    if (path.includes('/instance/preview') && method === 'POST') {
      if ((options.previewStatus ?? 200) !== 200) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'subdomain_taken',
              message: '„musterverein-ostend" ist bereits vergeben.',
            },
          }),
          { status: options.previewStatus },
        );
      }
      return new Response(
        JSON.stringify({
          previewId: 'v1',
          subdomain: 'musterverein-ostend',
          url: 'https://musterverein-ostend.example.com',
          applicationName: 'musterverein-ostend-app',
          databaseName: 'beispiel',
          environmentVariables: ['APP_URL', 'KENNZAHLEN_TOKEN'],
          validUntil: '2026-08-31T10:15:00.000Z',
          deviatesBySuggestionFrom: false,
          suggestedSubdomain: 'musterverein-ostend',
        }),
        { status: 200 },
      );
    }
    if (path.includes('/instance/check-reachability') && method === 'POST') {
      return new Response(JSON.stringify({ erreichbar: true }), { status: 200 });
    }
    if (path.includes('/instance/discard') && method === 'POST') {
      return new Response(JSON.stringify({ discarded: true }), { status: 200 });
    }
    if (path.includes('/instance/archive') && method === 'POST') {
      return new Response(
        JSON.stringify({ ...BASIS, status: 'stopped', metrics: null }),
        { status: 200 },
      );
    }
    if (path.includes('/invitation-link/send') && method === 'POST') {
      return new Response(
        JSON.stringify({ sent: true, email: 'anna@example.com' }),
        { status: 200 },
      );
    }
    if (path.includes('/fetch-metrics') && method === 'POST') {
      return new Response(JSON.stringify({ successful: true, errorKind: null }), {
        status: 200,
      });
    }
    if (path.endsWith('/instance') && method === 'POST') {
      if ((options.createStatus ?? 201) !== 201) {
        return new Response(
          JSON.stringify({
            error: {
              code: options.createErrorCode ?? 'preview_missing',
              message:
                'Vor dem Anlegen muss die Vorschau erzeugt und bestätigt werden.',
            },
          }),
          { status: options.createStatus },
        );
      }
      return new Response(
        JSON.stringify({
          ...BASIS,
          status: 'provisioning',
          createdAt: new Date().toISOString(),
          metrics: null,
          message: 'Anwendung wird in Coolify angelegt …',
        }),
        { status: 201 },
      );
    }
    if (path.endsWith('/instance')) {
      if (options.emptyBody) return new Response('', { status: 200 });
      const instance = options.instance === undefined ? BASIS : options.instance;
      return new Response(JSON.stringify(instance), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', called);
  return called;
}

function show() {
  render(
    <ToastProvider>
      <InstanceCard
        companyId={COMPANY_ID}
        companyName="Musterverein Ostend e. V."
        totpPossible={false}
      />
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Instanz-Karte — anlegen', () => {
  it('führt über die Pflicht-Vorschau: erst POST /vorschau, dann POST /instanz', async () => {
    const called = arrangeFetch({ instance: null });
    show();

    fireEvent.click(await screen.findByRole('button', { name: 'Instanz anlegen' }));
    expect(await screen.findByLabelText('Subdomain *')).toHaveValue(
      'musterverein-ostend',
    );
    expect(await screen.findByText('Verfügbar')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    // Die Vorschau stellt Name und Adresse unmittelbar untereinander — genau
    // hier fällt eine falsch getippte Subdomain auf.
    expect(await screen.findByText('Neue Instanz für')).toBeInTheDocument();
    expect(
      screen.getByText('https://musterverein-ostend.example.com'),
    ).toBeInTheDocument();
    expect(screen.getByText('musterverein-ostend-app')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Instanz jetzt anlegen' }));

    await waitFor(() =>
      expect(screen.getByText('Die Instanz wird erstellt.')).toBeInTheDocument(),
    );

    const order = called.mock.calls
      .filter((c) => (((c[1] as RequestInit | undefined)?.method ?? 'GET') === 'POST'))
      .map((c) => String(c[0]))
      .filter((p) => p.includes('/instance'));
    expect(order[0]).toContain('/instance/preview');
    expect(order[1]?.endsWith('/instance')).toBe(true);
  });

  it('reicht eine vergebene Subdomain nicht bis zur Bestätigung durch', async () => {
    arrangeFetch({ instance: null, available: false });
    show();

    fireEvent.click(await screen.findByRole('button', { name: 'Instanz anlegen' }));
    // Beim ungetippten Vorschlag steht kein roter Fehler, nur ein ruhiger Hinweis.
    expect(
      await screen.findByText(/Der Vorschlag ist bereits vergeben/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Diese Subdomain ist bereits vergeben.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();
    // Erst nach eigener Eingabe wird daraus der Fehler am Feld.
    fireEvent.change(screen.getByLabelText('Subdomain *'), { target: { value: 'musterverein' } });
    expect(
      await screen.findByText('Diese Subdomain ist bereits vergeben.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();
  });

  it('meldet eine fehlende Vorschau im Wortlaut des Servers', async () => {
    // Der Server erzwingt die Vorschau; läuft sie ab, kommt 409 vorschau_fehlt.
    arrangeFetch({ instance: null, createStatus: 409 });
    show();

    fireEvent.click(await screen.findByRole('button', { name: 'Instanz anlegen' }));
    await screen.findByText('Verfügbar');
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Instanz jetzt anlegen' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Vorschau erzeugt und bestätigt/,
    );
  });

  it('schließt den Dialog sofort — der lange Teil läuft in der Karte weiter', async () => {
    arrangeFetch({ instance: null });
    show();

    fireEvent.click(await screen.findByRole('button', { name: 'Instanz anlegen' }));
    await screen.findByText('Verfügbar');
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Instanz jetzt anlegen' }),
    );

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Du kannst diese Seite verlassen/),
    ).toBeInTheDocument();
  });
});

describe('Instanz-Karte — laufender Betrieb', () => {
  it('zeigt die Kennzahlen als Text mit festem Drei-Wochen-Vergleich', async () => {
    arrangeFetch();
    show();

    expect(await screen.findByText('Aktive Personen')).toBeInTheDocument();
    expect(screen.getByText('34')).toBeInTheDocument();
    // Zwei Kennzahlen tragen den Vergleich: aktive Personen und Kreise.
    expect(screen.getAllByText(/vor drei Wochen:/)).toHaveLength(2);
    expect(screen.getByText('28')).toBeInTheDocument();
    // Kein Diagramm, keine Kachel: die Zahlen stehen im dl-Raster.
    expect(document.querySelector('svg[role="img"]')).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('zeigt Zeitpunkt und Größe der letzten Sicherung unauffällig', async () => {
    arrangeFetch();
    show();

    const field = (await screen.findByText('Letzte Sicherung'))
      .parentElement as HTMLElement;
    expect(within(field).getByText('31.08.2026')).toBeInTheDocument();
    expect(field.textContent).toContain('2,4 GB');
    // Kein Dauerhäkchen im gesunden Fall.
    expect(screen.queryByText(/Sicherung überfällig/)).not.toBeInTheDocument();
    expect(
      screen.getByText('Eine Wiederherstellung in eine neue Instanz ist im Bereich „Sicherungen" möglich; das Zurückspielen in die bestehende Instanz gibt es bewusst nicht.'),
    ).toBeInTheDocument();
  });

  it('markiert eine ausgebliebene Sicherung farbig UND im Wortlaut', async () => {
    arrangeFetch({
      instance: {
        ...BASIS,
        backup: {
          last: { date: '2026-08-09', sizeBytes: 1024 ** 3 },
          missing: true,
        },
      },
    });
    show();

    // Farbe ist nie das alleinige Signal.
    const row = await screen.findByText(/Sicherung überfällig/);
    expect(row.textContent).toContain('09.08.2026');
  });

  it('meldet fehlgeschlagene Kennzahlen-Abfragen, statt sie zu verschlucken', async () => {
    arrangeFetch({
      instance: {
        ...BASIS,
        metrics: {
          ...BASIS.metrics!,
          sinceDaysFailed: 3,
          lastSuccessfulQueryAt: '2026-08-28',
        },
      },
    });
    show();

    expect(
      await screen.findByText(/Seit 3 Tagen keine erfolgreiche Kennzahlen-Abfrage/),
    ).toBeInTheDocument();
  });

  /**
   * [A.7] Der Link steht NICHT mehr von vornherein auf dem Schirm. Wer ihn hat,
   * wird auf der Kundeninstanz Administrator — er kommt erst auf Verlangen und
   * gegen einen zweiten Faktor.
   */
  it('bietet den Einrichtungslink an, zeigt ihn aber noch nicht', async () => {
    arrangeFetch({ instance: { ...BASIS, invitationOpen: true } });
    show();

    expect(await screen.findByText('Instanz ist bereit.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Einrichtungslink anzeigen' }),
    ).toBeInTheDocument();
    // Weder der Link noch ein Kopierknopf, solange nichts nachgewiesen wurde.
    expect(
      screen.queryByRole('button', { name: 'Einrichtungslink kopieren' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/api\/setup\/start/)).not.toBeInTheDocument();
  });

  it('verlangt einen Nachweis, bevor der Link herauskommt', async () => {
    arrangeFetch({ instance: { ...BASIS, invitationOpen: true } });
    show();

    const button = await screen.findByRole('button', {
      name: 'Einrichtungslink anzeigen',
    });
    button.click();

    expect(
      await screen.findByText(/weise dich noch einmal aus/i),
    ).toBeInTheDocument();
  });

  it('sagt nichts von einem Link, wenn keiner offen ist', async () => {
    arrangeFetch({ instance: { ...BASIS, invitationOpen: false } });
    show();

    // Warten, bis die Karte wirklich geladen ist — sonst belegt der Test nur,
    // dass noch nichts da war.
    expect(
      await screen.findByRole('button', { name: 'Instanz archivieren' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Instanz ist bereit.')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Einrichtungslink anzeigen' }),
    ).not.toBeInTheDocument();
  });
});

describe('Instanz-Karte — Halbzustände bleiben sichtbar', () => {
  it('zeigt den Zwischenstand während der Erstellung', async () => {
    arrangeFetch({
      instance: {
        ...BASIS,
        status: 'provisioning',
        metrics: null,
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        message: 'Warte auf Health-Check …',
      },
    });
    show();

    expect(await screen.findByText('Die Instanz wird erstellt.')).toBeInTheDocument();
    expect(screen.getByText(/Warte auf Health-Check/)).toBeInTheDocument();
    expect(screen.getByText(/seit 2 Minuten/)).toBeInTheDocument();
  });

  it('behauptet beim Archivieren keine Laufzeit aus dem Erstellungsdatum', async () => {
    // `erstelltAm` ist der Tag der Instanz, nicht der Beginn der Archivierung.
    // Ohne diese Unterscheidung stünde bei einer halbjährigen Instanz „läuft
    // seit 4300 Stunden" — eine Zahl, die etwas ganz anderes misst.
    arrangeFetch({
      instance: {
        ...BASIS,
        status: 'stopped',
        metrics: null,
        createdAt: '2026-01-05T09:00:00.000Z',
        message: 'Die Instanz wird gestoppt und gesichert.',
      },
    });
    show();

    expect(
      await screen.findByText('Die Instanz wird gestoppt und archiviert.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Läuft seit/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Die Instanz wird gestoppt und gesichert\./),
    ).toBeInTheDocument();
  });

  it('wird nach 15 Minuten ohne Abschluss deutlich — ohne „Erneut versuchen"', async () => {
    // EIN LAUFENDER Aufbau, kein gescheiterter. Hier stand eine Meldung
    // „Fehlgeschlagen: …" — und der Test verlangte dazu „dauert
    // ungewöhnlich lange". Er schrieb damit genau die Anzeige fest, die am
    // 12.09.2026 als falsch gemeldet wurde: Ein gescheiterter Aufbau dauert
    // nicht lange, er ist vorbei. Dafür gibt es jetzt eigene Fälle unten.
    arrangeFetch({
      instance: {
        ...BASIS,
        status: 'provisioning',
        metrics: null,
        createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        message: 'Zweites Ausrollen, jetzt mit Domäne und Zertifikat (einige Minuten) …',
      },
    });
    show();

    expect(
      await screen.findByText('Die Erstellung dauert ungewöhnlich lange.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Zweites Ausrollen/)).toBeInTheDocument();
    // Ein Neustart wäre eine dritte Schreiboperation gegen Coolify (R1).
    expect(
      screen.queryByRole('button', { name: /Erneut versuchen/ }),
    ).not.toBeInTheDocument();
  });

  it('zeigt die Meldung AUCH im Endzustand — es gibt keinen Fehlerstatus', async () => {
    // Ohne diese Stelle bliebe „die letzte Sicherung wurde nie gezogen"
    // unsichtbar: das Enum kennt kein `fehlgeschlagen`.
    arrangeFetch({
      instance: {
        ...BASIS,
        status: 'archived',
        metrics: null,
        archivedAt: '2026-08-31',
        message:
          'Eine abschliessende Sicherung liess sich nicht auslösen. Bitte in Coolify eine Sicherung anstossen.',
      },
    });
    show();

    expect(await screen.findByText('Archiviert')).toBeInTheDocument();
    expect(
      screen.getByText(/Bitte in Coolify eine Sicherung anstossen/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Die Daten bleiben erhalten/),
    ).toBeInTheDocument();
  });

  it('meldet einen Ladefehler sichtbar, statt eine leere Karte zu zeigen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('kaputt', { status: 500 })),
    );
    show();

    // Der Wortlaut kommt vom Server, wenn er einen liefert; entscheidend ist,
    // dass der Fehlschlag sichtbar wird und ein reines Nachladen angeboten
    // wird — keine Schreiboperation.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Erneut versuchen' }),
    ).toBeInTheDocument();
  });
});

describe('Instanz-Karte — Archivieren', () => {
  it('sagt, was passiert UND was nicht — und verspricht keine Sicherung', async () => {
    arrangeFetch();
    show();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Instanz archivieren' }),
    );

    expect(await screen.findByText('Das passiert:')).toBeInTheDocument();
    expect(screen.getByText('Das passiert nicht:')).toBeInTheDocument();
    expect(
      screen.getByText(/Es wird nichts gelöscht — alle Daten bleiben mindestens 90 Tage/),
    ).toBeInTheDocument();
    // Der Dialog verspricht KEINE Sicherung. Das Backend löst keine mehr aus
    // (`loeseSicherungAus` ist entfernt, der Coolify-Endpunkt existiert in
    // dieser Betriebsform nicht) — es NENNT nur den Stand. Ein Text, der hier
    // etwas anderes zusagt, wird genau dann geglaubt, wenn es darauf ankommt.
    expect(
      screen.getByText(/Es wird keine Sicherung ausgelöst/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Der Stand der letzten Sicherung wird festgehalten/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/wird gestoppt und gesichert/)).toBeNull();
    // Kein abgetipptes Bestätigungswort: es ist ausdrücklich kein Löschen.
    expect(screen.queryByLabelText(/LÖSCHEN/)).not.toBeInTheDocument();
  });

  it('wechselt danach in den Übergangszustand und pollt weiter', async () => {
    arrangeFetch();
    show();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Instanz archivieren' }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Instanz archivieren' }),
    );

    expect(
      await screen.findByText('Die Instanz wird gestoppt und archiviert.'),
    ).toBeInTheDocument();
  });
});

describe('Instanz-Karte — Abwesenheit (R1)', () => {
  it('bietet weder Löschen noch Wiederherstellen an', async () => {
    arrangeFetch();
    show();

    await screen.findByText('Aktive Personen');
    for (const button of screen.getAllByRole('button')) {
      const text = button.textContent ?? '';
      expect(text).not.toMatch(/löschen/i);
      expect(text).not.toMatch(/zurückspielen/i);
      // Wiederherstellen gibt es seit der Sicherungsfunktion — aber nur als
      // NEUE Instanz, nie über die bestehende (Prüfgegenstand bewusst
      // enger gefasst: Löschen bleibt ausgeschlossen, R1).
      if (/wiederherstell/i.test(text)) {
        expect(text).toMatch(/als neue instanz/i);
      }
    }
  });
});

/**
 * ===========================================================================
 * [K1] DER LEERE ANTWORTKÖRPER
 * ===========================================================================
 *
 * `GET :id/instanz` antwortet bei fehlender Instanz mit 200 und einem LEEREN
 * Körper — nicht mit `null`. `apiFetch` machte daraus `undefined`, die Karte
 * prüfte `instanz === null`, fiel in den „hat Instanz"-Zweig und stürzte auf
 * `instanz.subdomain` ab. Ergebnis: eine vollständig weiße Seite für jede
 * Organisation ohne Instanz — am Prüftag 0 von 41, also praktisch jede.
 *
 * Der Test greift bewusst am ECHTEN Verhalten des Servers an (`new
 * Response('')`), nicht an einem gemockten `null`. Mit `null` wäre er auch
 * gegen die kaputte Fassung grün gewesen und hätte nichts geprüft.
 */
describe('[K1] Instanz-Karte bei leerem Antwortkörper', () => {
  it('zeigt den Leerzustand, statt die Seite abzuräumen', async () => {
    arrangeFetch({ emptyBody: true });
    show();

    expect(await screen.findByText('Noch keine Instanz')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Instanz anlegen' }),
    ).toBeInTheDocument();
  });

  it('behandelt leeren Körper und echtes `null` gleich', async () => {
    arrangeFetch({ instance: null });
    show();
    expect(await screen.findByText('Noch keine Instanz')).toBeInTheDocument();
  });
});

/**
 * ===========================================================================
 * DIE SACKGASSE NACH EINEM GESCHEITERTEN AUFBAU
 * ===========================================================================
 *
 * Gemessen am 07.09.2026: Der erste Coolify-Aufruf scheiterte, und die
 * `Instanz`-Zeile blieb auf `wird_erstellt` stehen — mit einer Meldung, die
 * seit acht Minuten „Fehlgeschlagen" lautete, und darunter dem Satz „Du
 * kannst diese Seite verlassen — der Vorgang läuft im Hintergrund weiter."
 * Er lief nicht mehr.
 *
 * `Instanz.organisationId` ist unique, es gibt keinen Loeschweg (R1), und die
 * Organisation war damit dauerhaft blockiert. Die Route zum Verwerfen gab es
 * seit [W4] — die Oberflaeche kannte sie nicht.
 */
describe('Eine gescheiterte Erstellung ist keine Sackgasse', () => {
  const FAILED: InstanceDetail = {
    ...BASIS,
    // Wie im gemeldeten Fall: acht Minuten alt, also NOCH nicht „haengt fest".
    createdAt: new Date(Date.now() - 8 * 60_000).toISOString(),
    status: 'provisioning',
    metrics: null,
    message:
      'Fehlgeschlagen: Coolify antwortete 422 auf POST ' +
      '/applications/private-deploy-key. Es wurde nichts gelöscht; bitte in ' +
      'Coolify nachsehen.',
  };

  it('bietet den Ausweg an', async () => {
    arrangeFetch({ instance: FAILED });
    show();
    expect(
      await screen.findByRole('button', { name: /Erstellung verwerfen/ }),
    ).toBeInTheDocument();
  });

  it('behauptet NICHT mehr, der Vorgang laufe weiter', async () => {
    arrangeFetch({ instance: FAILED });
    show();
    await screen.findByRole('button', { name: /Erstellung verwerfen/ });
    expect(screen.queryByText(/läuft im Hintergrund weiter/)).not.toBeInTheDocument();
  });

  it('bietet ihn NICHT an, solange der Aufbau laeuft', async () => {
    arrangeFetch({
      instance: {
        ...FAILED,
        // FRISCH, sonst greift der „haengt fest"-Zweig (er rechnet gegen
        // `erstelltAm`) und die laufende Anzeige kommt gar nicht vor.
        createdAt: new Date().toISOString(),
        message: 'Anwendung wird in Coolify angelegt …',
      },
    });
    show();
    await screen.findByText(/Die Instanz wird erstellt/);
    expect(
      screen.queryByRole('button', { name: /Erstellung verwerfen/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/läuft im Hintergrund weiter/)).toBeInTheDocument();
  });

  it('ruft die Verwerfen-Route und laedt danach neu', async () => {
    const called = arrangeFetch({ instance: FAILED });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Erstellung verwerfen/ }));

    await waitFor(() =>
      expect(
        called.mock.calls.filter(([e]) => String(e).includes('/instance/discard')),
      ).toHaveLength(1),
    );
  });
});

/**
 * Der Satz unter „Erstellung verwerfen" muss in BEIDEN Fällen stimmen.
 *
 * Gemeldet am 11.09.2026: Dort stand „dort ist bei diesem Fehlschlag nichts
 * entstanden" — obwohl in Coolify die halb angelegte Anwendung stand. Der
 * Server lehnte das Verwerfen ab, und die Oberfläche hatte vorher das
 * Gegenteil versprochen.
 */
describe('Nach einem Fehlschlag steht die WAHRE Anweisung da', () => {
  const FAILURE: InstanceDetail = {
    ...BASIS,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    status: 'provisioning',
    metrics: null,
    message:
      'Fehlgeschlagen: Coolify antwortete 422 auf PATCH /applications/x: ' +
      'Validation failed.',
  };

  it('sagt „nichts entstanden", wenn in Coolify nichts steht', async () => {
    arrangeFetch({ instance: { ...FAILURE, coolifyCreated: false } });
    show();
    await screen.findByRole('button', { name: /Erstellung verwerfen/ });
    expect(screen.getByText(/dort ist bei diesem Fehlschlag nichts entstanden/)).toBeInTheDocument();
    expect(screen.queryByText(/Lösche\s+sie dort von Hand/)).not.toBeInTheDocument();
  });

  it('verlangt erst das Löschen in Coolify, wenn dort etwas steht', async () => {
    arrangeFetch({ instance: { ...FAILURE, coolifyCreated: true } });
    show();
    await screen.findByRole('button', { name: /Erstellung verwerfen/ });
    expect(screen.getByText(/Lösche\s+sie dort von Hand/)).toBeInTheDocument();
    expect(screen.getByText('musterverein-ostend', { selector: 'code' })).toBeInTheDocument();
    // Und NICHT mehr das Gegenteil.
    expect(
      screen.queryByText(/dort ist bei diesem Fehlschlag nichts entstanden/),
    ).not.toBeInTheDocument();
  });
});

/**
 * Ausgerollt, aber noch nicht erreichbar — gemeldet als Sackgasse am
 * 11.09.2026: Die Instanz lief, die Karte sagte „läuft im Hintergrund
 * weiter", und es gab keinen Knopf.
 */
describe('Ausgerollt, aber noch nicht erreichbar', () => {
  const PENDING: InstanceDetail = {
    ...BASIS,
    createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    status: 'provisioning',
    metrics: null,
    coolifyCreated: true,
    message:
      'Erreichbarkeit ausstehend: Das Deployment ist durchgelaufen, aber ' +
      'https://musterverein-ostend.example.com/api/health antwortet noch nicht.',
  };

  it('bietet „Erneut prüfen" an — und keinen falschen Ausweg', async () => {
    arrangeFetch({ instance: PENDING });
    show();
    expect(await screen.findByRole('button', { name: /Erneut prüfen/ })).toBeInTheDocument();
    expect(screen.queryByText(/läuft im Hintergrund weiter/)).not.toBeInTheDocument();
    // Verwerfen wäre hier falsch: Die Instanz läuft.
    expect(screen.queryByRole('button', { name: /Erstellung verwerfen/ })).not.toBeInTheDocument();
  });

  it('ruft die Prüfroute', async () => {
    const called = arrangeFetch({ instance: PENDING });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Erneut prüfen/ }));
    await waitFor(() =>
      expect(
        called.mock.calls.filter(([e]) => String(e).includes('/instance/check-reachability')),
      ).toHaveLength(1),
    );
  });
});

/**
 * Endzustände laufen nicht — gemeldet am 12.09.2026.
 *
 * Über einem Aufbau, der seit einer Stunde gescheitert war, stand „Läuft seit
 * 56 Minuten ohne Abschluss … Diese Karte aktualisiert sich automatisch", und
 * schon vorher drehte sich das Symbol neben „Die Instanz wird erstellt. …
 * Läuft seit 6 Minuten".
 */
describe('Ein Endzustand behauptet keinen laufenden Vorgang', () => {
  const FAILED: InstanceDetail = {
    ...BASIS,
    status: 'provisioning',
    metrics: null,
    coolifyCreated: true,
    message:
      'Fehlgeschlagen: Coolify antwortete 422 auf PATCH /applications/x: ' +
      'Validation failed. Es wurde nichts gelöscht; bitte in Coolify nachsehen.',
  };

  function noRunDisplay() {
    expect(screen.queryByText('Die Instanz wird erstellt.')).not.toBeInTheDocument();
    expect(screen.queryByText('Die Erstellung dauert ungewöhnlich lange.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Läuft/)).not.toBeInTheDocument();
    expect(screen.queryByText(/aktualisiert sich automatisch/)).not.toBeInTheDocument();
    expect(screen.queryByText(/läuft im Hintergrund weiter/)).not.toBeInTheDocument();
  }

  it.each([
    ['frisch', 1],
    ['nach 20 Minuten', 20],
  ])('zeigt einen gescheiterten Aufbau als gescheitert — %s', async (_name, minutes) => {
    arrangeFetch({
      instance: {
        ...FAILED,
        createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
      },
    });
    show();
    expect(await screen.findByText('Die Erstellung ist gescheitert.')).toBeInTheDocument();
    // Der Grund steht da — ohne das doppelte „Fehlgeschlagen:".
    expect(screen.getByText(/Coolify antwortete 422/)).toBeInTheDocument();
    expect(screen.queryByText(/^Fehlgeschlagen:/)).not.toBeInTheDocument();
    noRunDisplay();
    expect(screen.getByRole('button', { name: /Erstellung verwerfen/ })).toBeInTheDocument();
    // R1: kein Neustart gegen Coolify.
    expect(screen.queryByRole('button', { name: /Erneut versuchen/ })).not.toBeInTheDocument();
  });

  it('zeigt „ausgerollt, antwortet noch nicht" auch nach 20 Minuten nicht als „ungewöhnlich lange"', async () => {
    arrangeFetch({
      instance: {
        ...BASIS,
        status: 'provisioning',
        metrics: null,
        coolifyCreated: true,
        createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        message:
          'Erreichbarkeit ausstehend: Das Deployment ist durchgelaufen, aber ' +
          'https://musterverein-ostend.example.com/api/health antwortet noch nicht.',
      },
    });
    show();
    expect(
      await screen.findByText('Ausgerollt — die Instanz antwortet noch nicht.'),
    ).toBeInTheDocument();
    noRunDisplay();
    expect(screen.getByRole('button', { name: /Erneut prüfen/ })).toBeInTheDocument();
  });
});



function showWithAddress(email: string | null) {
  render(
    <ToastProvider>
      <InstanceCard
        companyId={COMPANY_ID}
        companyName="Musterverein Ostend e. V."
        contactEmail={email}
        totpPossible={false}
      />
    </ToastProvider>,
  );
}

/**
 * Drei Dinge vom 12.09.2026: Die Karte zeigte „noch nicht eingelöst" für eine
 * eingerichtete Instanz, der Link liess sich nur kopieren, und die
 * App-Version stand bis 04:00 auf „—".
 */
describe('Instanz-Karte — Einrichtung, Mailversand, Kennzahlen jetzt', () => {
  it('zeigt „Eingerichtet am" und keinen Link mehr, sobald die Einrichtung vermerkt ist', async () => {
    arrangeFetch({
      instance: { ...BASIS, invitationOpen: false, configuredAt: '2026-09-12' },
    });
    show();

    expect(await screen.findByText('Eingerichtet am')).toBeInTheDocument();
    expect(screen.getByText('12.09.2026')).toBeInTheDocument();
    expect(screen.queryByText('Instanz ist bereit.')).not.toBeInTheDocument();
  });

  it('nennt die Adresse auf dem Knopf und schickt erst nach dem Nachweis', async () => {
    const called = arrangeFetch({ instance: { ...BASIS, invitationOpen: true } });
    showWithAddress('anna@example.com');

    fireEvent.click(
      await screen.findByRole('button', { name: /Per Mail senden an anna@example\.com/ }),
    );
    // Noch ist nichts hinausgegangen — erst kommt der Nachweis.
    expect(
      called.mock.calls.some((c) => String(c[0]).includes('/invitation-link/send')),
    ).toBe(false);
    expect(await screen.findByText(/Der Link geht an anna@example\.com/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Aktuelles Passwort'), {
      target: { value: 'mein-passwort' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await waitFor(() => {
      const call = called.mock.calls.find((c) =>
        String(c[0]).includes('/invitation-link/send'),
      );
      expect(call).toBeDefined();
      const init = call?.[1] as RequestInit | undefined;
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('mein-passwort');
      // DIE ADRESSE GEHT NICHT MIT: Der Server nimmt die hinterlegte. Sonst
      // liesse sich der Link aus dem Browser heraus umlenken.
      expect(String(init?.body)).not.toContain('anna@');
    });
    expect(
      await screen.findByText('Einrichtungslink an anna@example.com gesendet.'),
    ).toBeInTheDocument();
  });

  it('bietet ohne hinterlegte Adresse keinen Versand an, sondern sagt, wo sie fehlt', async () => {
    arrangeFetch({ instance: { ...BASIS, invitationOpen: true } });
    showWithAddress(null);

    expect(await screen.findByText('Instanz ist bereit.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Per Mail senden/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/fehlt die E-Mail-Adresse der/)).toBeInTheDocument();
  });

  it('ruft die Kennzahlen auf Knopfdruck ab und lädt die Karte danach neu', async () => {
    const called = arrangeFetch();
    show();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Kennzahlen jetzt abrufen' }),
    );

    await waitFor(() => {
      expect(
        called.mock.calls.some(
          (c) =>
            String(c[0]).includes('/fetch-metrics') &&
            (c[1] as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true);
    });
    // NEU LADEN GEHÖRT DAZU — sonst stünde die App-Version weiter auf „—",
    // obwohl sie gerade abgerufen wurde.
    await waitFor(() => {
      const loads = called.mock.calls.filter(
        (c) =>
          String(c[0]).endsWith('/instance') &&
          ((c[1] as RequestInit | undefined)?.method ?? 'GET') === 'GET',
      );
      expect(loads.length).toBeGreaterThan(1);
    });
  });
});

describe('Instanz-Karte — von außen angeforderter Anlegen-Dialog', () => {
  function showRequested(handled: () => void) {
    render(
      <ToastProvider>
        <InstanceCard
          companyId={COMPANY_ID}
          companyName="Musterverein Ostend e. V."
          totpPossible={false}
          createRequested
          onCreateRequestHandled={handled}
        />
      </ToastProvider>,
    );
  }

  it('öffnet ohne Instanz den Dialog und meldet die Anforderung als gelesen', async () => {
    arrangeFetch({ instance: null });
    const handled = vi.fn();
    showRequested(handled);
    expect(await screen.findByLabelText('Subdomain *')).toBeInTheDocument();
    expect(handled).toHaveBeenCalled();
  });

  it('öffnet bei vorhandener Instanz keinen Dialog, meldet die Anforderung aber trotzdem zurück', async () => {
    arrangeFetch({ instance: BASIS });
    const handled = vi.fn();
    showRequested(handled);
    await waitFor(() => expect(handled).toHaveBeenCalled());
    expect(screen.queryByLabelText('Subdomain *')).toBeNull();
  });

  it('gibt den Fokus nach Escape an den Anlegen-Knopf der Karte zurück', async () => {
    arrangeFetch({ instance: null });
    showRequested(vi.fn());
    await screen.findByLabelText('Subdomain *');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Subdomain *')).toBeNull());
    const create = screen.getByRole('button', { name: 'Instanz anlegen' });
    expect(document.activeElement).toBe(create);
  });
});
