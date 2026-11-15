import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import App from '../App';
import { renderWithI18n } from '../test-support/render-with-i18n';

/**
 * Die Vorlagenseite — und die vier Stellen, an denen sie lügen könnte.
 *
 * 1. Die Empfängerauswahl ist eine VORHERSAGE. Sagt die Seite das nicht, hält
 *    jemand die Liste für eine Zusage — und wundert sich, warum weniger Mails
 *    ankamen, als dort standen.
 * 2. Der Testversand hat KEIN Adressfeld. Eines anzubieten wäre der bequemste
 *    Weg, R3 zu umgehen.
 * 3. Der Versand ist UNUMKEHRBAR und liegt hinter dem zweiten Faktor.
 * 4. Der Transaktionskanal hat hier keinen Versandweg — ein Knopf, der sicher
 *    scheitert, wäre schlechter als keiner.
 */

const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';
const TRANSACTIONAL_ID = '22222222-2222-4222-8222-222222222222';

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
  totpConfigured: true,
  emailCodeConfigured: true,
  loginCodeEmail: 'test@example.com',
  setUpFactors: ['totp'],
  openRecoveryCodes: 8,
};

const MARKETING = {
  id: TEMPLATE_ID,
  name: 'Neuigkeiten Herbst',
  channel: 'marketing',
  subject: 'Neues aus dem Produkt',
  contentText: 'Hallo {{company}}, hier ist die Herbstausgabe.',
  placeholders: ['company', 'unsubscribeLink'],
  active: true,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
};

const TRANSACTIONAL = {
  ...MARKETING,
  id: TRANSACTIONAL_ID,
  name: 'Zahlungserinnerung',
  channel: 'transactional',
};

/**
 * Der Wortlaut der Fusszeile steht NUR hier — er kommt vom Server.
 * Taucht er in der Oberfläche an einer anderen Stelle auf als in dem, was der
 * Server geliefert hat, gibt es zwei Fassungen einer Pflichtangabe.
 */
const PROVIDER_IDENTIFICATION =
  'Example Company GmbH & Co KG, Amtsgericht Example City HRA 0000';

const PREVIEW = {
  subject: 'Neues aus dem Produkt',
  body: 'Hallo Beispielorganisation, hier ist die Herbstausgabe.',
  html:
    '<!doctype html><html lang="de"><body>' +
    '<p>Hallo Beispielorganisation, hier ist die Herbstausgabe.</p>' +
    `<p>Abmelden</p><p>${PROVIDER_IDENTIFICATION}</p>` +
    '</body></html>',
  text:
    'Hallo Beispielorganisation, hier ist die Herbstausgabe.\n\n' +
    '--\nAbmelden — ein Klick, keine Rückfrage, sofort wirksam:\n' +
    `https://…/api/consent/unsubscribe/beispiel-token\n\n${PROVIDER_IDENTIFICATION}`,
  used: {
    company: 'Beispielorganisation',
    unsubscribeLink: 'https://…/api/consent/unsubscribe/beispiel-token',
  },
};

const RECIPIENTS = {
  count: 2,
  recipient: [
    {
      consentId: 'e1',
      email: 'anna@example.com',
      companyId: 'o1',
      companyName: 'Verein Nord',
      confirmedAt: '2026-07-15T08:00:00.000Z',
    },
    {
      consentId: 'e2',
      email: 'bea@example.com',
      companyId: null,
      companyName: null,
      confirmedAt: null,
    },
  ],
  note:
    'Stand jetzt. Massgeblich ist die Prüfung unmittelbar vor dem Versand: Wer bis dahin widerruft, bekommt nichts.',
};

const PROOF_REQUIRED = {
  error: {
    code: 'login_failed',
    message:
      'Für diese Aktion ist das aktuelle Passwort oder ein Bestätigungscode nötig.',
  },
};

/** Der Vorgabestand: nichts eingestellt, nichts offen. */
const PROGRESS_EMPTY = {
  templateId: TEMPLATE_ID,
  total: 0,
  sent: 0,
  open: 0,
  failed: 0,
  refused: 0,
};

interface Options {
  template?: unknown;
  needs2fa?: boolean;
  sendError?: { status: number; body: unknown };
  testSend?: unknown;
  run?: unknown;
  /**
   * Die Antworten auf `/fortschritt`, der Reihe nach. Die letzte bleibt
   * stehen — so lässt sich ein laufender Versand als Folge von Ständen
   * beschreiben, ohne die Abrufe zu zählen.
   */
  progress?: unknown[];
  progressError?: number;
}

function mockFetch(options: Options = {}) {
  const called = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      const withProof =
        body['currentPassword'] !== undefined ||
        body['totpCode'] !== undefined;
      const needsProof = (options.needs2fa ?? false) && !withProof;

      if (path.includes('/api/auth/csrf')) {
        return new Response(JSON.stringify({ csrfToken: 'abc' }), {
          status: 200,
        });
      }
      if (path.includes('/api/auth/me')) {
        return new Response(JSON.stringify(STATE), { status: 200 });
      }
      if (path.includes('/api/broadcast/recipients')) {
        return new Response(JSON.stringify(RECIPIENTS), { status: 200 });
      }
      if (path.includes('/preview')) {
        return new Response(JSON.stringify(PREVIEW), { status: 200 });
      }
      if (path.includes('/progress')) {
        if (options.progressError !== undefined) {
          return new Response(JSON.stringify({ error: { code: 'HTTP_500' } }), {
            status: options.progressError,
          });
        }
        const sequence = options.progress ?? [PROGRESS_EMPTY];
        const next = sequence.length > 1 ? sequence.shift() : sequence[0];
        return new Response(JSON.stringify(next), { status: 200 });
      }
      if (path.includes('/test-send')) {
        if (needsProof)
          return new Response(JSON.stringify(PROOF_REQUIRED), { status: 401 });
        return new Response(
          JSON.stringify(options.testSend ?? { sent: true }),
          { status: 200 },
        );
      }
      if (path.includes('/send')) {
        if (needsProof)
          return new Response(JSON.stringify(PROOF_REQUIRED), { status: 401 });
        if (options.sendError) {
          return new Response(JSON.stringify(options.sendError.body), {
            status: options.sendError.status,
          });
        }
        return new Response(
          JSON.stringify({ enqueued: 2, template: 'Neuigkeiten Herbst' }),
          { status: 200 },
        );
      }
      if (path.includes('/queue/run')) {
        if (needsProof)
          return new Response(JSON.stringify(PROOF_REQUIRED), { status: 401 });
        return new Response(
          JSON.stringify(
            options.run ?? {
              considered: 2,
              sent: 2,
              refused: 0,
              retry: 0,
              failed: 0,
              cleanedUp: 0,
            },
          ),
          { status: 200 },
        );
      }
      if (path.includes('/api/broadcast/templates/') && method === 'PATCH') {
        return new Response(
          JSON.stringify({
            ...(options.template ?? MARKETING),
            ...(body as object),
            updatedAt: '2026-08-31T10:00:00.000Z',
          }),
          { status: 200 },
        );
      }
      if (path.includes('/api/broadcast/templates/')) {
        return new Response(JSON.stringify(options.template ?? MARKETING), {
          status: 200,
        });
      }
      return new Response('{}', { status: 200 });
    },
  );
  vi.stubGlobal('fetch', called);
  return called;
}

function openPage(id = TEMPLATE_ID) {
  window.history.pushState({}, '', `/broadcast/${id}`);
  renderWithI18n(<App />);
}

/** Führt bis zum offenen Versanddialog mit ausgefülltem Bestätigungswort. */
async function readyToSend() {
  fireEvent.click(
    await screen.findByRole('button', { name: /Rundmail versenden …/ }),
  );
  fireEvent.change(
    await screen.findByLabelText(/Zur Bestätigung „versenden" eingeben/),
    { target: { value: 'versenden' } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('Vorlagenseite — die Empfängerauswahl ist eine Vorhersage', () => {
  it('zeigt Zahl, Liste und den Hinweis des Servers im Wortlaut', async () => {
    mockFetch();
    openPage();

    expect(
      await screen.findByText('Das ist eine Vorhersage, keine Zusage.'),
    ).toBeInTheDocument();
    expect(screen.getByText(RECIPIENTS.note)).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('anna@example.com')).toBeInTheDocument();
    expect(screen.getByText('bea@example.com')).toBeInTheDocument();
    // Datum als dd.mm.yyyy, nie als ISO.
    expect(screen.getByText(/15\.07\.2026/)).toBeInTheDocument();
  });

  it('bietet keine Auswahlkästchen und kein Hinzufügen an (Abwesenheit)', async () => {
    mockFetch();
    openPage();

    await screen.findByText('anna@example.com');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    for (const forbidden of [/hinzufügen/i, /import/i, /an alle/i]) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }
  });
});

describe('Vorlagenseite — Testversand ohne Adressfeld', () => {
  it('nennt die eigene Adresse und erklärt, warum es kein Feld gibt', async () => {
    mockFetch();
    openPage();

    expect(
      await screen.findByText('Es gibt hier bewusst kein Adressfeld.'),
    ).toBeInTheDocument();
    expect(screen.getByText('test@example.com')).toBeInTheDocument();
    // Kein Eingabefeld für eine Zieladresse — geprüft als Abwesenheit.
    expect(screen.queryByLabelText(/Empfänger/i)).toBeNull();
    expect(screen.queryByLabelText(/Testadresse/i)).toBeNull();
  });

  it('übersetzt einen misslungenen Testversand in einen Satz', async () => {
    mockFetch({ testSend: { sent: false, reason: 'rejected' } });
    openPage();

    fireEvent.click(
      await screen.findByRole('button', { name: /Testmail an mich schicken/ }),
    );

    expect(
      await screen.findByText(/keine bestätigte Einwilligung mehr vor/),
    ).toBeInTheDocument();
  });
});

describe('Vorlagenseite — der Versand ist unumkehrbar', () => {
  it('trennt „Das passiert" von „Das passiert nicht"', async () => {
    mockFetch();
    openPage();

    fireEvent.click(
      await screen.findByRole('button', { name: /Rundmail versenden …/ }),
    );

    expect(await screen.findByText('Das passiert')).toBeInTheDocument();
    expect(screen.getByText('Das passiert nicht')).toBeInTheDocument();
    expect(
      screen.getByText(/Zurückholen lässt sich nichts/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Es wird nicht gemessen, wer die Mail öffnet/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Jede versendete Mail erscheint im Verlauf/),
    ).toBeInTheDocument();
  });

  it('hält den Knopf gesperrt, bis das Bestätigungswort stimmt', async () => {
    const called = mockFetch();
    openPage();

    fireEvent.click(
      await screen.findByRole('button', { name: /Rundmail versenden …/ }),
    );
    const button = await screen.findByRole('button', {
      name: 'Rundmail endgültig versenden',
    });
    expect(button).toBeDisabled();

    fireEvent.change(
      screen.getByLabelText(/Zur Bestätigung „versenden" eingeben/),
      { target: { value: 'versende' } },
    );
    expect(button).toBeDisabled();

    fireEvent.change(
      screen.getByLabelText(/Zur Bestätigung „versenden" eingeben/),
      { target: { value: 'versenden' } },
    );
    expect(button).toBeEnabled();

    expect(
      called.mock.calls.filter(([path]) =>
        String(path).includes('/send'),
      ),
    ).toHaveLength(0);
  });

  it('ruft erst ohne Nachweis und fragt erst bei 401 nach', async () => {
    const called = mockFetch({ needs2fa: true });
    openPage();
    await readyToSend();

    fireEvent.click(
      screen.getByRole('button', { name: 'Rundmail endgültig versenden' }),
    );
    fireEvent.change(await screen.findByLabelText('Aktuelles Passwort'), {
      target: { value: 'geheim' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await waitFor(() => {
      const calls = called.mock.calls.filter(([path]) =>
        String(path).endsWith(`/templates/${TEMPLATE_ID}/send`),
      );
      expect(calls).toHaveLength(2);
      expect(String(calls[0]?.[1]?.body)).not.toContain('currentPassword');
      expect(String(calls[1]?.[1]?.body)).toContain('currentPassword');
    });
  });

  it('schickt NUR den Nachweis mit — kein Bestätigungswort, kein Empfänger', async () => {
    const called = mockFetch();
    openPage();
    await readyToSend();

    fireEvent.click(
      screen.getByRole('button', { name: 'Rundmail endgültig versenden' }),
    );

    await waitFor(() => {
      const call = called.mock.calls.find(([path]) =>
        String(path).endsWith(`/templates/${TEMPLATE_ID}/send`),
      );
      // `forbidNonWhitelisted` im Server: Jedes zusätzliche Feld wäre eine 400.
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({});
    });
  });

  it('meldet nach dem Einstellen, dass noch nichts hinausgegangen ist', async () => {
    mockFetch();
    openPage();
    await readyToSend();

    fireEvent.click(
      screen.getByRole('button', { name: 'Rundmail endgültig versenden' }),
    );

    expect(
      await screen.findByText(
        '2 Mails aus „Neuigkeiten Herbst" stehen in der Warteschlange.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Hinausgegangen ist damit noch nichts/),
    ).toBeInTheDocument();
  });

  it('zeigt offene Platzhalter im Dialog, statt ihn über den Fehler zu legen', async () => {
    mockFetch({
      sendError: {
        status: 409,
        body: {
          error: {
            code: 'open_placeholders',
            message:
              'Für {{name}} gibt es bei mindestens einer Empfängerin keinen Wert. Es wurde nichts verschickt.',
            detail: { placeholders: ['name'] },
          },
        },
      },
    });
    openPage();
    await readyToSend();

    fireEvent.click(
      screen.getByRole('button', { name: 'Rundmail endgültig versenden' }),
    );

    expect(
      await screen.findByText(/Es wurde nichts verschickt/),
    ).toBeInTheDocument();
    // Der Fehlerblock zählt die offenen Namen einzeln auf.
    expect(
      screen.getAllByText('{{name}}').length,
    ).toBeGreaterThanOrEqual(1);
    // Der Dialog bleibt offen: Die Liste ist genau das, was man jetzt braucht.
    expect(
      screen.getByRole('button', { name: 'Rundmail endgültig versenden' }),
    ).toBeInTheDocument();
  });
});

describe('Vorlagenseite — Versandlauf und Vorschau', () => {
  it('zeigt die sechs Zahlen eines Laufs mit ihrer Bedeutung', async () => {
    mockFetch();
    openPage();

    fireEvent.click(
      await screen.findByRole('button', { name: /Versandlauf jetzt starten/ }),
    );

    expect(
      await screen.findByText(
        'Lauf beendet: 2 von 2 betrachteten Zeilen sind hinausgegangen.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Versendet')).toBeInTheDocument();
    expect(screen.getByText('Später erneut')).toBeInTheDocument();
    expect(
      screen.getByText(/steht jetzt im Verlauf der Organisation/),
    ).toBeInTheDocument();
  });

  it('zeigt das ganze Dokument des Servers, samt Fusszeile', async () => {
    mockFetch();
    openPage();

    const frame = await screen.findByTitle('Vorschau der E-Mail');
    const doc = frame.getAttribute('srcdoc') ?? '';
    expect(doc).toBe(PREVIEW.html);
    expect(doc).toContain(PROVIDER_IDENTIFICATION);
    expect(frame).toHaveAttribute('sandbox', '');
  });

  it('zeigt die Fusszeile im Wortlaut auch als Nur-Text-Ansicht', async () => {
    mockFetch();
    openPage();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Nur-Text-Ansicht anzeigen' }),
    );

    expect(
      screen.getByText(new RegExp(PROVIDER_IDENTIFICATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    ).toBeInTheDocument();
    // Zweimal: einmal im Textteil des Servers, einmal unten als
    // eingesetzter Beispielwert. Ein echter Token einer Empfängerin steht
    // an keiner der beiden Stellen.
    expect(
      screen.getAllByText(/api\/consent\/unsubscribe\/beispiel-token/)
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  /**
   * EINE QUELLE, EIN WORTLAUT. Vorher stand die Anbieterkennung als
   * nachgebaute Aufzählung in der Oberfläche. Dieser Test hält fest, dass sie
   * ausschliesslich aus der Serverantwort stammt: Wer sie wieder abschreibt,
   * bekommt ihn rot.
   */
  it('schreibt die Anbieterkennung nirgends selbst ab', async () => {
    mockFetch();
    openPage();

    await screen.findByTitle('Vorschau der E-Mail');
    expect(document.body.textContent ?? '').not.toContain(PROVIDER_IDENTIFICATION);
    expect(screen.queryByText(/§ 5 DDG/)).toBeNull();
  });

  it('bietet genau die drei Auszeichnungen an, die der Server durchlaesst', async () => {
    // Hier stand einmal die Gegenprobe: KEIN HTML-Feld, weil das Backend nur
    // Text kannte. Diese Voraussetzung gilt nicht mehr — der Server nimmt
    // `inhaltHtml` entgegen und leitet den Text daraus ab.
    //
    // Geprueft wird jetzt die Grenze in die andere Richtung: dass die Leiste
    // nicht MEHR anbietet, als ankommt. Ein Knopf fuer Ueberschriften, Farben
    // oder Listen waere ein Versprechen, das der Saeuberer beim Versand
    // wieder einkassiert.
    mockFetch();
    openPage();

    await screen.findByLabelText('Inhalt');
    const bar = screen.getByRole('toolbar', { name: /Auszeichnungen/ });
    const buttons = within(bar)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(buttons).toEqual(['Fett', 'Kursiv', 'Unterstrichen']);
  });
});

describe('Vorlagenseite — der Transaktionskanal hat keinen Versandweg', () => {
  it('erklärt die Auslassung, statt einen Knopf anzubieten, der scheitert', async () => {
    mockFetch({ template: TRANSACTIONAL });
    openPage(TRANSACTIONAL_ID);

    expect(
      await screen.findByRole('heading', { name: 'Kein Versandweg' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Rundmail versenden/ }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Testmail an mich schicken/ }),
    ).toBeNull();
  });
});

describe('Vorlagenseite — Fehler bleiben sichtbar', () => {
  it('meldet einen Ladefehler und bietet einen zweiten Versuch an', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes('/api/auth/csrf'))
          return new Response(JSON.stringify({ csrfToken: 'abc' }), {
            status: 200,
          });
        if (path.includes('/api/auth/me'))
          return new Response(JSON.stringify(STATE), { status: 200 });
        if (path.includes('/api/broadcast/templates/'))
          return new Response(
            JSON.stringify({
              error: {
                code: 'template_not_found',
                message: 'Vorlage nicht gefunden.',
              },
            }),
            { status: 404 },
          );
        return new Response('{}', { status: 200 });
      }),
    );
    openPage();

    expect(
      await screen.findByText('Vorlage nicht gefunden.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Erneut versuchen' }),
    ).toBeInTheDocument();
  });
});

/**
 * ===========================================================================
 * DER FORTSCHRITTSBALKEN
 * ===========================================================================
 *
 * Die Seite hat lange eine Zeitansage gezeigt („bis zu anderthalb Minuten"),
 * weil es keine Warteschlangenabfrage gab. Jetzt gibt es sie, und der Balken
 * bewegt sich nach GEMESSENEN Zahlen. Drei Dinge müssen dabei stimmen:
 *
 * 1. Die Zahlen kommen vom Server und werden nicht geschätzt.
 * 2. Gefragt wird nur, solange etwas offen ist — sonst läuft ein Takt ewig
 *    weiter auf einer Seite, die tagelang offen stehen kann.
 * 3. Nach einem Fehler wird NICHT weitergefragt, sondern gefragt, ob nochmal.
 */
describe('Vorlagenseite — Fortschritt des Versands', () => {
  it('sagt, dass nichts in der Warteschlange steht, statt einen leeren Balken zu zeigen', async () => {
    mockFetch();
    openPage();

    expect(
      await screen.findByText(/steht nichts in der Warteschlange/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('zeigt einen Balken nach den Zahlen des Servers', async () => {
    mockFetch({
      progress: [
        {
          templateId: TEMPLATE_ID,
          total: 10,
          sent: 4,
          open: 5,
          failed: 0,
          refused: 1,
        },
      ],
    });
    openPage();

    const bar = await screen.findByRole('progressbar');
    // 4 versendet + 1 abgewiesen = 5 erledigt von 10.
    expect(bar).toHaveAttribute('aria-valuenow', '5');
    expect(bar).toHaveAttribute('aria-valuemax', '10');
    expect(bar).toHaveAttribute(
      'aria-valuetext',
      '4 von 10 versendet, 5 offen.',
    );
    expect(screen.getByText('50 %')).toBeInTheDocument();
    expect(screen.getByText('Abgewiesen')).toBeInTheDocument();
    expect(screen.getByText('Fehlgeschlagen')).toBeInTheDocument();
  });

  it('fragt weiter nach, solange etwas offen ist — und hört danach auf', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const called = mockFetch({
        progress: [
          {
            templateId: TEMPLATE_ID,
            total: 4,
            sent: 1,
            open: 3,
            failed: 0,
            refused: 0,
          },
          {
            templateId: TEMPLATE_ID,
            total: 4,
            sent: 4,
            open: 0,
            failed: 0,
            refused: 0,
          },
        ],
      });
      openPage();

      const bar = await screen.findByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '1');

      // In `act`, weil der Takt selbst einen Abruf und damit einen
      // Zustandswechsel auslöst — sonst warnt React zu Recht.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      await waitFor(() =>
        expect(screen.getByRole('progressbar')).toHaveAttribute(
          'aria-valuenow',
          '4',
        ),
      );
      expect(screen.getByText(/Nichts mehr offen/)).toBeInTheDocument();

      // Ab hier ist nichts mehr offen: es darf keine weitere Abfrage kommen.
      const before = called.mock.calls.filter((call) =>
        String(call[0]).includes('/progress'),
      ).length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      const after = called.mock.calls.filter((call) =>
        String(call[0]).includes('/progress'),
      ).length;
      expect(after).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rennt nach einem Fehler nicht weiter gegen den Server an', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const called = mockFetch({ progressError: 500 });
      openPage();

      expect(
        await screen.findByRole('button', { name: 'Stand erneut abrufen' }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/läuft davon unberührt weiter/),
      ).toBeInTheDocument();

      const before = called.mock.calls.filter((call) =>
        String(call[0]).includes('/progress'),
      ).length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      const after = called.mock.calls.filter((call) =>
        String(call[0]).includes('/progress'),
      ).length;
      expect(after).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holt den Stand sofort, wenn eine Rundmail eingestellt wurde', async () => {
    const called = mockFetch();
    openPage();

    await screen.findByText(/steht nichts in der Warteschlange/);
    const before = called.mock.calls.filter((call) =>
      String(call[0]).includes('/progress'),
    ).length;

    await readyToSend();
    fireEvent.click(
      screen.getByRole('button', { name: 'Rundmail endgültig versenden' }),
    );

    await waitFor(() => {
      const after = called.mock.calls.filter((call) =>
        String(call[0]).includes('/progress'),
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('zeigt für den Transaktionskanal gar keinen Fortschritt an', async () => {
    mockFetch({ template: TRANSACTIONAL });
    openPage(TRANSACTIONAL_ID);

    await screen.findByText('Kein Versandweg');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/steht nichts in der Warteschlange/)).toBeNull();
  });
});

/**
 * DIE VIER STRUKTURFELDER — und warum sie nicht im Fliesstext stehen können.
 *
 * Der Säuberer lässt kein `<a>` durch, und er soll es nicht: Sonst wäre jede
 * Redaktion ein Weg, eine beliebige Adresse in eine Mail dieses Hauses zu
 * setzen. Der Knopf ist die EINE Stelle, an der eine Adresse hineinkommt —
 * deshalb wird sie geprüft, hier wie auf dem Server.
 */
describe('Rundmail-Vorlage — Struktur der Werbemail', () => {
  it('zeigt Vorüberschrift, Überschrift und Knopf beim werblichen Kanal', async () => {
    mockFetch();
    openPage();

    expect(await screen.findByLabelText('Vorüberschrift')).toBeInTheDocument();
    expect(screen.getByLabelText('Überschrift')).toBeInTheDocument();
    expect(screen.getByLabelText('Text des Knopfes')).toBeInTheDocument();
    expect(screen.getByLabelText('Ziel des Knopfes')).toBeInTheDocument();
  });

  it('ZEIGT SIE BEIM TRANSAKTIONSKANAL NICHT', async () => {
    // Der Transaktionsrahmen kennt weder Vorüberschrift noch Knopf. Felder
    // anzubieten, die nirgends ankommen, ist schlimmer als keine.
    mockFetch({ template: TRANSACTIONAL });
    openPage(TRANSACTIONAL_ID);

    await screen.findByLabelText('Betreff');
    expect(screen.queryByLabelText('Vorüberschrift')).toBeNull();
    expect(screen.queryByLabelText('Text des Knopfes')).toBeNull();
  });

  it('MELDET EINEN HALBEN KNOPF, statt ihn stillschweigend wegzulassen', async () => {
    mockFetch();
    openPage();

    fireEvent.change(await screen.findByLabelText('Text des Knopfes'), {
      target: { value: 'Termine ansehen' },
    });

    expect(
      await screen.findByText(
        'Zur Beschriftung gehört ein Ziel, sonst entfällt der Knopf.',
      ),
    ).toBeInTheDocument();
  });

  it('MELDET EIN ZIEL OHNE SCHEMA, bevor der Server es abweist', async () => {
    mockFetch();
    openPage();

    fireEvent.change(await screen.findByLabelText('Text des Knopfes'), {
      target: { value: 'Termine' },
    });
    fireEvent.change(screen.getByLabelText('Ziel des Knopfes'), {
      target: { value: 'example.com/termine' },
    });

    expect(
      await screen.findByText(
        'Das Ziel muss eine vollständige Adresse mit http:// oder https:// sein.',
      ),
    ).toBeInTheDocument();
  });

  it('schickt die vier Felder beim Speichern mit', async () => {
    const called = mockFetch();
    openPage();

    fireEvent.change(await screen.findByLabelText('Vorüberschrift'), {
      target: { value: 'Neues im Produkt' },
    });
    fireEvent.change(screen.getByLabelText('Überschrift'), {
      target: { value: 'Vier Termine im Herbst' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Änderungen speichern/ }));

    await waitFor(() => {
      const patch = called.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      const body = JSON.parse(
        String((patch![1] as RequestInit).body),
      ) as Record<string, unknown>;
      expect(body['eyebrow']).toBe('Neues im Produkt');
      expect(body['heading']).toBe('Vier Termine im Herbst');
      // Leer heisst LEER, nicht „unverändert": Der Server macht daraus
      // `null` und löscht damit einen alten Wert.
      expect(body).toHaveProperty('buttonText', '');
    });
  });
});
