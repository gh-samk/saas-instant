import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import App from '../App';
import { renderWithI18n } from '../test-support/render-with-i18n';

/**
 * [W4] Der Widerspruch, der nicht über den Link kommt.
 *
 * Geprüft wird genau das, was die Route ausmacht: Sie sperrt, sie entsperrt
 * nie, und sie kommt mit einer Adresse zurecht, die wir gar nicht kennen. Die
 * Oberfläche darf beides nicht verschweigen — eine Sperre, deren Endgültigkeit
 * man erst hinterher bemerkt, ist eine Falle.
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
  totpConfigured: true,
  emailCodeConfigured: true,
  loginCodeEmail: 'test@example.com',
  setUpFactors: ['totp'],
  openRecoveryCodes: 8,
};

/** Die 401-Antwort des `ZweitfaktorGuard`, im Wortlaut des Servers. */
const PROOF_REQUIRED = {
  error: {
    code: 'login_failed',
    message:
      'Für diese Aktion ist das aktuelle Passwort oder ein Bestätigungscode nötig.',
  },
};

function mockFetch(
  options: {
    needs2fa?: boolean;
    result?: { consentId: string; created: boolean; abortedMails: number };
    blocklist?: unknown[];
  } = {},
) {
  const called = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};

    if (path.includes('/api/auth/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
    }
    if (path.includes('/api/auth/me')) {
      return new Response(JSON.stringify(STATE), { status: 200 });
    }
    if (path.includes('/api/broadcast/blocklist')) {
      return new Response(JSON.stringify(options.blocklist ?? []), {
        status: 200,
      });
    }
    if (path.includes('/api/broadcast/counters')) {
      return new Response(
        JSON.stringify({ templates: 4, confirmed: 128, disabled: 3 }),
        { status: 200 },
      );
    }
    if (path.includes('/api/consent/block')) {
      const withProof =
        body['currentPassword'] !== undefined ||
        body['totpCode'] !== undefined;
      if ((options.needs2fa ?? false) && !withProof) {
        return new Response(JSON.stringify(PROOF_REQUIRED), { status: 401 });
      }
      return new Response(
        JSON.stringify(
          options.result ?? {
            consentId: 'e1',
            created: true,
            abortedMails: 2,
          },
        ),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', called);
  return called;
}

function openPage() {
  window.history.pushState({}, '', '/broadcast/blocklist');
  renderWithI18n(<App />);
}

async function fillIn(email = 'anna@example.com') {
  fireEvent.change(await screen.findByLabelText('E-Mail-Adresse'), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText(/^Anlass/), {
    target: { value: 'telefonisch am 30.08.2026' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('Newsletter-Sperre — sie sperrt, sie entsperrt nie', () => {
  it('sagt VOR dem Abschicken, dass es keinen Weg zurück gibt', async () => {
    mockFetch();
    openPage();

    expect(
      await screen.findByText(/eine Sperre kann niemand aufheben/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/trägt sich selbst über das öffentliche Formular neu ein/),
    ).toBeInTheDocument();
  });

  it('bietet nirgends ein Entsperren an (geprüft als Abwesenheit)', async () => {
    mockFetch();
    openPage();

    await screen.findByLabelText('E-Mail-Adresse');
    for (const forbidden of [/entsperr/i, /aufheben/i, /freigeben/i]) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }
    // Auch die Auswahl kennt nur Sperrzustände — kein „bestätigt".
    const reason = screen.getByLabelText('Grund');
    expect(within(reason).queryByText(/bestätigt/i)).toBeNull();
    expect(within(reason).getAllByRole('option')).toHaveLength(3);
  });

  it('hält den Knopf gesperrt, bis Adresse und Anlass tragen', async () => {
    mockFetch();
    openPage();

    const button = await screen.findByRole('button', {
      name: /^Sperren$/,
    });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('E-Mail-Adresse'), {
      target: { value: 'anna@example.com' },
    });
    // Adresse allein reicht nicht: Der Anlass ist Pflicht und hat eine
    // Mindestlänge — ein „ok" wäre später kein Beleg.
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^Anlass/), {
      target: { value: 'kurz' },
    });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^Anlass/), {
      target: { value: 'telefonisch am 30.08.2026' },
    });
    expect(button).toBeEnabled();
  });

  it('schickt Adresse, Grund und Anlass — und meldet den reinen Sperreintrag', async () => {
    const called = mockFetch();
    openPage();
    await fillIn();

    fireEvent.click(
      screen.getByRole('button', { name: /^Sperren$/ }),
    );

    await waitFor(() => {
      const call = called.mock.calls.find(([path]) =>
        String(path).includes('/api/consent/block'),
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        email: 'anna@example.com',
        reason: 'unsubscribed',
        justification: 'telefonisch am 30.08.2026',
      });
    });

    expect(
      await screen.findByText('anna@example.com ist gesperrt.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/kein Einwilligungsnachweis/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('2 bereits eingestellte Mails wurden abgebrochen.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Ein Weg zurück besteht von hier aus nicht.'),
    ).toBeInTheDocument();
    // Das Formular ist leer: die nächste Sperre ist ein neuer Vorgang.
    expect(screen.getByLabelText('E-Mail-Adresse')).toHaveValue('');
  });

  it('ruft erst ohne Nachweis und fragt erst bei 401 nach', async () => {
    const called = mockFetch({ needs2fa: true });
    openPage();
    await fillIn();

    fireEvent.click(
      screen.getByRole('button', { name: /^Sperren$/ }),
    );

    fireEvent.change(await screen.findByLabelText('Aktuelles Passwort'), {
      target: { value: 'geheim' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await waitFor(() => {
      const calls = called.mock.calls.filter(([path]) =>
        String(path).includes('/api/consent/block'),
      );
      expect(calls).toHaveLength(2);
      expect(String(calls[0]?.[1]?.body)).not.toContain('currentPassword');
      expect(String(calls[1]?.[1]?.body)).toContain('currentPassword');
    });
  });

  it('meldet eine Adresse mit Tippfehler, statt sie abzuschicken', async () => {
    const called = mockFetch();
    openPage();

    fireEvent.change(await screen.findByLabelText('E-Mail-Adresse'), {
      target: { value: 'anna@example' },
    });
    fireEvent.change(screen.getByLabelText(/^Anlass/), {
      target: { value: 'telefonisch am 30.08.2026' },
    });

    expect(
      screen.getByRole('button', { name: /^Sperren$/ }),
    ).toBeDisabled();
    expect(
      called.mock.calls.filter(([path]) =>
        String(path).includes('/api/consent/block'),
      ),
    ).toHaveLength(0);
  });

  it('zeigt den Fehler des Servers im Wortlaut, statt still zu scheitern', async () => {
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
        if (path.includes('/api/consent/block'))
          return new Response(
            JSON.stringify({
              error: {
                code: 'HTTP_400',
                message: 'Der Anlass ist zu kurz, um später zu tragen.',
              },
            }),
            { status: 400 },
          );
        return new Response('{}', { status: 200 });
      }),
    );
    openPage();
    await fillIn();

    fireEvent.click(
      screen.getByRole('button', { name: /^Sperren$/ }),
    );

    expect(
      await screen.findByText('Der Anlass ist zu kurz, um später zu tragen.'),
    ).toBeInTheDocument();
  });
});

/**
 * DIE LISTE, DIE ES BIS ZUM REDESIGN NICHT GAB.
 *
 * Der Kommentar der Seite begründete ihr Fehlen ausdrücklich („Ein Verzeichnis
 * aller gesperrten Adressen wäre eine zweite Oberfläche über personenbezogene
 * Daten"). Mit ihr kommt die Frage zurück, die sie beantworten soll: Bekommt
 * diese Adresse noch Post? Vorher liess sie sich nur durch einen
 * Sperrversuch beantworten — also durch eine Handlung ohne Rückweg.
 */
describe('Die Sperrliste', () => {
  const ROWS = [
    {
      consentId: 's1',
      email: 'alt@example.com',
      status: 'unsubscribed',
      reason: 'telefonisch am 30.08.',
      registeredAt: '2026-08-30T10:00:00.000Z',
    },
    {
      consentId: 's2',
      email: 'post@example.com',
      status: 'spam_reported',
      reason: 'Rückmeldung Provider',
      registeredAt: '2026-08-14T10:00:00.000Z',
    },
    {
      consentId: 's3',
      email: 'selbst@example.com',
      status: 'unsubscribed',
      reason: null,
      registeredAt: '2026-07-03T10:00:00.000Z',
    },
  ];

  it('zeigt Adresse, Grund, Anlass und Zeitpunkt', async () => {
    mockFetch({ blocklist: ROWS });
    openPage();

    const table = await screen.findByRole('table');
    expect(within(table).getByText('alt@example.com')).toBeInTheDocument();
    expect(within(table).getByText('telefonisch am 30.08.')).toBeInTheDocument();
    expect(within(table).getByText('Als Spam gemeldet')).toBeInTheDocument();
    expect(within(table).getByText('30.08.2026')).toBeInTheDocument();
  });

  it('SAGT BEI EINER SELBSTABMELDUNG, WARUM NICHTS DASTEHT', async () => {
    // Ein „—" liesse offen, ob der Anlass fehlt oder ob niemand einen
    // genannt hat. Wer sich selbst abmeldet, nennt keinen.
    mockFetch({ blocklist: ROWS });
    openPage();

    expect(
      await screen.findByText('Selbst abgemeldet — kein Anlass erfasst'),
    ).toBeInTheDocument();
  });

  it('unterscheidet „noch keine" von einem Ladefehler', async () => {
    mockFetch({ blocklist: [] });
    openPage();
    expect(
      await screen.findByText('Keine gesperrten Adressen'),
    ).toBeInTheDocument();
  });

  it('BIETET AN KEINER ZEILE EIN ENTSPERREN AN', async () => {
    // Die Liste ist rein lesend. Ein Knopf je Zeile wäre der bequemste Weg,
    // R3 zu umgehen — und es gibt auf dem Server auch keine Route dafür.
    mockFetch({ blocklist: ROWS });
    openPage();

    const table = await screen.findByRole('table');
    expect(within(table).queryAllByRole('button')).toHaveLength(0);
    expect(within(table).queryAllByRole('link')).toHaveLength(0);
  });
});
