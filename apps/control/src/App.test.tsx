import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n as render } from './test-support/render-with-i18n';
import App from './App';

/** Antwortet auf /api/auth/csrf und lässt /api/auth/me mit 401 scheitern. */
function arrangeFetch(meStatus: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/api/auth/csrf')) {
        return new Response(JSON.stringify({ csrfToken: 'abc' }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          error: { code: 'HTTP_401', message: 'Nicht angemeldet.' },
        }),
        { status: meStatus },
      );
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Einzelne Tests setzen die Adresse per pushState. Ohne Rücksetzen erbt der
  // nächste Test die Route und rendert eine ganz andere Seite.
  window.history.pushState({}, '', '/');
});

describe('App', () => {
  it('führt nicht angemeldete Personen zur Anmeldeseite', async () => {
    arrangeFetch(401);
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Anmelden' }),
      ).toBeInTheDocument(),
    );
  });

  it('zeigt einen Serverfehler an, statt eine leere Seite zu rendern', async () => {
    arrangeFetch(500);
    render(<App />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});

describe('Anmeldeseite: gesperrtes Konto', () => {
  /**
   * Regressionstest zu Finding K3: Das Backend antwortet mit 429 und
   * `detail.sekundenVerbleibend`; die Seite muss die Sperrmeldung samt
   * laufender Restzeit zeigen. Vorher verschwand sie im selben Renderdurchlauf
   * wieder, und der Bildschirm blieb stumm.
   */
  it('zeigt Sperrmeldung und Restzeit statt kommentarlos das Feld zu leeren', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes('/api/auth/csrf')) {
          return new Response(JSON.stringify({ csrfToken: 'abc' }), {
            status: 200,
          });
        }
        if (path.includes('/api/auth/login')) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'account_locked',
                message:
                  'Zu viele Fehlversuche. Das Konto ist vorübergehend gesperrt.',
                detail: { secondsRemaining: 900 },
              },
            }),
            { status: 429 },
          );
        }
        return new Response(
          JSON.stringify({
            error: { code: 'HTTP_401', message: 'Nicht angemeldet.' },
          }),
          { status: 401 },
        );
      }),
    );

    render(<App />);
    const username = await screen.findByLabelText('Benutzername');
    fireEvent.change(username, { target: { value: 'test' } });
    fireEvent.change(screen.getByLabelText('Passwort'), {
      target: { value: 'falsch-falsch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));

    await waitFor(() =>
      expect(
        screen.getByText('Konto vorübergehend gesperrt'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('15:00')).toBeInTheDocument();
    // Das Anmeldeformular ist während der Sperre nicht nur deaktiviert,
    // sondern gar nicht sichtbar.
    expect(screen.queryByLabelText('Passwort')).toBeNull();
  });
});

/**
 * Antwortet auf die Routen, die für den zweiten Schritt der Anmeldung nötig
 * sind. `faktoren` steuert, welche Methoden die Seite anbieten soll.
 */
function arrangeSecondFactor(
  factors: string[],
  emailCodeResponse: () => Response,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/api/auth/csrf')) {
        return new Response(JSON.stringify({ csrfToken: 'abc' }), {
          status: 200,
        });
      }
      if (path.includes('/api/auth/login-code/request')) {
        return new Response(
          JSON.stringify({ requested: true, againPossibleInSeconds: 60 }),
          { status: 200 },
        );
      }
      if (path.includes('/api/auth/login/email-code')) {
        return emailCodeResponse();
      }
      if (path.includes('/api/auth/login')) {
        return new Response(
          JSON.stringify({ secondFactorRequired: true, factors }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          error: { code: 'HTTP_401', message: 'Nicht angemeldet.' },
        }),
        { status: 401 },
      );
    }),
  );
}

/** Füllt Schritt 1 aus und sendet ab. */
async function loginWithPassword() {
  const username = await screen.findByLabelText('Benutzername');
  fireEvent.change(username, { target: { value: 'sam' } });
  fireEvent.change(screen.getByLabelText('Passwort'), {
    target: { value: 'ein-langes-passwort' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
}

describe('Anmeldeseite: zweiter Faktor per E-Mail', () => {
  it('bietet beide Methoden als Reiter an und beginnt beim E-Mail-Code', async () => {
    arrangeSecondFactor(
      ['email-code', 'totp'],
      () => new Response('{}', { status: 200 }),
    );
    render(<App />);
    await loginWithPassword();

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'E-Mail-Code' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(
      screen.getByRole('tab', { name: 'Authenticator-App' }),
    ).toHaveAttribute('aria-selected', 'false');
    expect(
      screen.getByRole('button', { name: 'Code senden' }),
    ).toBeInTheDocument();
  });

  it('zeigt bei nur einer Methode keine Reiterleiste', async () => {
    arrangeSecondFactor(
      ['totp'],
      () => new Response('{}', { status: 200 }),
    );
    render(<App />);
    await loginWithPassword();

    await waitFor(() =>
      expect(
        screen.getByText('Gib den 6-stelligen Code aus deiner Authenticator-App ein.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  /** Fehlerfall: Der Server lehnt den Code ab, die Seite sagt es am Feld. */
  it('meldet einen falschen E-Mail-Code am Eingabefeld', async () => {
    arrangeSecondFactor(
      ['email-code'],
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'login_failed',
              message: 'Anmeldung fehlgeschlagen.',
            },
          }),
          { status: 401 },
        ),
    );
    render(<App />);
    await loginWithPassword();

    const send = await screen.findByRole('button', { name: 'Code senden' });
    fireEvent.click(send);

    const field = await screen.findByLabelText('Code aus der E-Mail');
    fireEvent.change(field, { target: { value: '12345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));

    await waitFor(() =>
      expect(
        screen.getByText('Falscher Code. Bitte erneut versuchen.'),
      ).toBeInTheDocument(),
    );
    // Der Wiederhol-Zähler läuft — der Knopf ist in dieser Zeit nicht da.
    expect(screen.queryByRole('button', { name: 'Code erneut senden' })).toBeNull();
  });
});

describe('Einstellungen: letzte Anmeldemethode', () => {
  it('ersetzt „Entfernen" durch den Hinweis, statt ihn nur auszugrauen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes('/api/auth/csrf')) {
          return new Response(JSON.stringify({ csrfToken: 'abc' }), {
            status: 200,
          });
        }
        if (path.includes('/api/access/devices')) {
          return new Response(JSON.stringify({ devices: [] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            user: {
              id: '1',
              name: 'Sam',
              username: 'sam',
              email: 'admin@example.com',
              role: 'admin',
            },
            passwordSet: true,
            passkeyCount: 0,
            totpSetUp: false,
            emailCodeSetUp: true,
            loginCodeEmail: 'admin@example.com',
            setUpFactors: ['email-code'],
            openRecoveryCodes: 8,
          }),
          { status: 200 },
        );
      }),
    );
    window.history.pushState({}, '', '/settings');
    render(<App />);

    await waitFor(() =>
      expect(
        screen.getByText('Einzige Methode – richte zuerst eine weitere ein.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Entfernen' })).toBeNull();
    // Die maskierte Adresse steht dort, nicht die volle.
    expect(screen.getByText(/ad\*\*\*@example\.com/)).toBeInTheDocument();
    expect(screen.queryByText(/admin@example\.com/)).toBeNull();
  });
});

/**
 * Ersteinrichtung mit einem Konto, das noch keinen zweiten Faktor hat.
 * `PublicKeyCredential` wird gestellt, damit die Passkey-Karte erscheint.
 */
function arrangeWizard() {
  vi.stubGlobal('PublicKeyCredential', class {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/api/auth/csrf')) {
        return new Response(JSON.stringify({ csrfToken: 'abc' }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          user: {
            id: '1',
            name: 'Sam',
            username: 'sam',
            email: 'admin@example.com',
            role: 'admin',
          },
          passwordSet: true,
          passkeyCount: 0,
          totpSetUp: false,
          emailCodeSetUp: false,
          loginCodeEmail: 'admin@example.com',
          setUpFactors: [],
          openRecoveryCodes: 0,
        }),
        { status: 200 },
      );
    }),
  );
}

describe('Ersteinrichtung: Passkey als zweiter Faktor', () => {
  /**
   * Regression zu DW2: Wird der Passkey als zweiter Faktor gewählt, ist der
   * optionale Passkey-Schritt damit erledigt. Er darf nicht als zweiter,
   * gleichnamiger Schritt danebenstehen („2 Passkey · 3 Passkey").
   */
  it('lässt den doppelten Passkey-Schritt entfallen', async () => {
    arrangeWizard();
    window.history.pushState({}, '', '/first-setup');
    render(<App />);

    await screen.findByText('Passwort gesetzt');
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    // Vor der Wahl: vier Schritte, der zweite heißt neutral „Zweiter Faktor".
    await screen.findByText('Schritt 2 von 4: Zweiter Faktor');
    const progress = screen.getByRole('list', {
      name: 'Fortschritt der Ersteinrichtung',
    });
    expect(within(progress).getAllByRole('listitem')).toHaveLength(4);

    fireEvent.click(screen.getByRole('radio', { name: /Passkey/ }));

    await screen.findByText('Schritt 2 von 3: Passkey');
    expect(within(progress).getAllByRole('listitem')).toHaveLength(3);
    // „Passkey" steht genau einmal in der Fortschrittsanzeige.
    expect(
      within(progress).getAllByText('Passkey', { exact: true }),
    ).toHaveLength(1);
  });

  it('behält vier Schritte, wenn ein anderer Faktor gewählt wird', async () => {
    arrangeWizard();
    window.history.pushState({}, '', '/first-setup');
    render(<App />);

    await screen.findByText('Passwort gesetzt');
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await screen.findByText('Schritt 2 von 4: Zweiter Faktor');

    fireEvent.click(screen.getByRole('radio', { name: /Code per E-Mail/ }));

    await screen.findByText('Schritt 2 von 4: Code per E-Mail');
    const progress = screen.getByRole('list', {
      name: 'Fortschritt der Ersteinrichtung',
    });
    expect(within(progress).getAllByRole('listitem')).toHaveLength(4);
  });
});

describe('Anmeldeseite: toter E-Mail-Code', () => {
  /** Fordert einen Code an und gibt ihn ein; der Server lehnt mit `grund` ab. */
  async function attemptsWithReason(reason: string) {
    arrangeSecondFactor(
      ['email-code'],
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'login_failed',
              message: 'Anmeldung fehlgeschlagen.',
              detail: { reason },
            },
          }),
          { status: 401 },
        ),
    );
    render(<App />);
    await loginWithPassword();
    fireEvent.click(await screen.findByRole('button', { name: 'Code senden' }));
    const field = await screen.findByLabelText('Code aus der E-Mail');
    fireEvent.change(field, { target: { value: '12345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    return field;
  }

  /**
   * Regression zu DW1: Ein verbrannter Code sah aus wie ein Tippfehler. Jetzt
   * sagt die Meldung, dass ein neuer Code nötig ist — und der Weg dorthin
   * steht sichtbar darunter, auch während der 60-Sekunden-Sperre.
   */
  it('benennt einen verbrannten Code und weist den Weg zum neuen', async () => {
    const field = await attemptsWithReason('burned');

    await waitFor(() =>
      expect(
        screen.getByText(
          'Dieser Code ist nach zu vielen Fehlversuchen ungültig geworden. Fordere einen neuen Code an.',
        ),
      ).toBeInTheDocument(),
    );
    // Der tote Code bleibt nicht im Feld stehen und lädt so zum Weitertippen ein.
    expect(field).toHaveValue('');
    // Während der Sperre gibt es keinen Knopf — aber die Zeile sagt, worauf
    // man wartet, und nennt die Handlung beim Namen.
    expect(screen.getByText(/Neuen Code anfordern in/)).toBeInTheDocument();
    expect(screen.queryByText(/Erneut senden in/)).toBeNull();
  });

  it('benennt einen abgelaufenen Code', async () => {
    await attemptsWithReason('expired');

    await waitFor(() =>
      expect(
        screen.getByText('Dieser Code ist abgelaufen. Fordere einen neuen Code an.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/Neuen Code anfordern in/)).toBeInTheDocument();
  });

  it('lässt bei einem Tippfehler weiterprobieren', async () => {
    const field = await attemptsWithReason('wrong');

    await waitFor(() =>
      expect(
        screen.getByText('Falscher Code. Bitte erneut versuchen.'),
      ).toBeInTheDocument(),
    );
    // Hier bleibt der Code stehen — er lässt sich korrigieren.
    expect(field).toHaveValue('12345678');
    expect(screen.getByText(/Erneut senden in/)).toBeInTheDocument();
    expect(screen.queryByText(/Neuen Code anfordern in/)).toBeNull();
  });
});

describe('Anmeldeseite: Ausnahmeweg ohne wählbare Methode', () => {
  /** Führt bis in den Wiederherstellungscode-Weg und liefert den Hinweistext. */
  async function noticeOn(factors: string[]) {
    arrangeSecondFactor(factors, () => new Response('{}', { status: 200 }));
    render(<App />);
    await loginWithPassword();
    return screen.findByText(/Wiederherstellungscodes/);
  }

  /**
   * Regression zu K3: Der Satz über den Passkey stand hartkodiert da, auch für
   * Konten, die gar keinen haben.
   */
  it('nennt den Passkey nur, wenn es wirklich einen gibt', async () => {
    await noticeOn(['passkey']);
    expect(
      screen.getByText(/nur ein Passkey hinterlegt/),
    ).toBeInTheDocument();
  });

  it('weist ohne jeden Faktor den Weg über Code und Kommandozeile', async () => {
    await noticeOn([]);
    expect(
      screen.getByText(/kein zweiter Faktor eingerichtet/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Kommandozeile/)).toBeInTheDocument();
    // Kein Verweis auf einen Passkey, den es nicht gibt.
    expect(screen.queryByText(/Passkey/)).toBeNull();
  });
});

describe('Ersteinrichtung: Sitzung stirbt mitten im Wizard', () => {
  /**
   * Regression zu K3: Nach einem 401 fiel die Seite auf den Notfall-Vorschritt
   * zurück und zeigte dessen stehengebliebenes „Passkey erfolgreich erstellt" —
   * ein Bildschirm, der Erfolg behauptet, während nichts mehr geht.
   *
   * `ichAntworten` liefert erst einen gültigen Stand, danach 401.
   */
  it('zeigt statt eines Erfolgszustands den Weg zur Anmeldung', async () => {
    let meCalls = 0;
    vi.stubGlobal('PublicKeyCredential', class {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes('/api/auth/csrf')) {
          return new Response(JSON.stringify({ csrfToken: 'abc' }), {
            status: 200,
          });
        }
        if (path.includes('/api/auth/me')) {
          meCalls += 1;
          if (meCalls > 1) {
            return new Response(
              JSON.stringify({
                error: { code: 'HTTP_401', message: 'Nicht angemeldet.' },
              }),
              { status: 401 },
            );
          }
          return new Response(
            JSON.stringify({
              user: {
                id: '1',
                name: 'Sam',
                username: 'sam',
                email: 'admin@example.com',
                role: 'admin',
              },
              passwordSet: false,
              passkeyCount: 0,
              totpSetUp: false,
              emailCodeSetUp: false,
              loginCodeEmail: 'admin@example.com',
              setUpFactors: [],
              openRecoveryCodes: 0,
            }),
            { status: 200 },
          );
        }
        // Das Passwort wird gesetzt — der Server beendet dabei die Sitzung.
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    window.history.pushState({}, '', '/first-setup?token=egal');
    render(<App />);

    await screen.findByLabelText('Neues Passwort');
    fireEvent.change(screen.getByLabelText('Neues Passwort'), {
      target: { value: 'ein-langes-testpasswort' },
    });
    fireEvent.change(screen.getByLabelText('Passwort wiederholen'), {
      target: { value: 'ein-langes-testpasswort' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await waitFor(() =>
      expect(screen.getByText('Die Anmeldung ist beendet')).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: 'Zur Anmeldung' }),
    ).toBeInTheDocument();
    // Kein Rückfall auf den Notfall-Vorschritt und keine Erfolgsbehauptung.
    expect(screen.queryByText(/erfolgreich erstellt/)).toBeNull();
    expect(screen.queryByText(/Löse zuerst deinen einmaligen Link ein/)).toBeNull();
  });
});

/**
 * Einstellungen mit einem Konto, das TOTP und E-Mail-Code hat. `antwortAuf`
 * entscheidet je Pfad, was der Server liefert.
 */
function arrangeSettings(
  responseOn: (path: string, method: string) => Response | null,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (path.includes('/api/auth/csrf')) {
        return new Response(JSON.stringify({ csrfToken: 'abc' }), {
          status: 200,
        });
      }
      const own = responseOn(path, method);
      if (own) return own;
      if (path.includes('/api/access/devices')) {
        return new Response(JSON.stringify({ devices: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          user: {
            id: '1',
            name: 'Sam',
            username: 'sam',
            email: 'admin@example.com',
            role: 'admin',
          },
          passwordSet: true,
          passkeyCount: 0,
          totpSetUp: true,
          emailCodeSetUp: true,
          loginCodeEmail: 'admin@example.com',
          setUpFactors: ['email-code', 'totp'],
          openRecoveryCodes: 8,
        }),
        { status: 200 },
      );
    }),
  );
}

describe('Einstellungen: Faktor entfernen verlangt einen Nachweis', () => {
  /** Öffnet den Entfernen-Dialog für die Authenticator-App und bestätigt ihn. */
  async function removeTotp() {
    window.history.pushState({}, '', '/settings');
    render(<App />);
    await screen.findByRole('heading', { name: 'Anmeldemethoden' });
    const row = screen
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes('Authenticator-App'));
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Entfernen' }));
    await screen.findByText('Authenticator-App entfernen?');
    const dialogs = screen.getAllByRole('dialog');
    const open = dialogs[dialogs.length - 1] as HTMLElement;
    fireEvent.click(within(open).getByRole('button', { name: 'Entfernen' }));
  }

  it('fragt bei 401 nach und schickt den Nachweis mit', async () => {
    const body: string[] = [];
    let rejected = true;
    arrangeSettings((path, method) => {
      if (method !== 'DELETE' || !path.includes('/factors/totp')) return null;
      if (rejected) {
        rejected = false;
        return new Response(
          JSON.stringify({
            error: {
              code: 'login_failed',
              message: 'Für diese Aktion ist das aktuelle Passwort nötig.',
            },
          }),
          { status: 401 },
        );
      }
      return new Response(JSON.stringify({ invalidatedTrustedDevices: 0 }), {
        status: 200,
      });
    });
    const realFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await removeTotp();

    // Erst der Versuch ohne Nachweis, dann die Rückfrage.
    await screen.findByText('Bestätige, dass du es bist');
    // Beim Entfernen der App gibt es bewusst keinen TOTP-Umweg.
    expect(
      screen.queryByRole('button', {
        name: 'Stattdessen Bestätigungscode aus der App verwenden',
      }),
    ).toBeNull();

    // Die Seite hat auch in „Passwort ändern" ein Feld dieses Namens.
    const evidence = screen.getByText('Bestätige, dass du es bist')
      .closest('[role="dialog"]') as HTMLElement;
    fireEvent.change(within(evidence).getByLabelText('Aktuelles Passwort'), {
      target: { value: 'ein-langes-passwort' },
    });
    fireEvent.click(within(evidence).getByRole('button', { name: 'Weiter' }));

    await waitFor(() =>
      expect(screen.getByText('Authenticator-App entfernt.')).toBeInTheDocument(),
    );
    for (const call of realFetch.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      if ((init?.method ?? '') === 'DELETE') body.push(String(init?.body));
    }
    expect(body[0]).toBe('{}');
    expect(JSON.parse(body[1])).toEqual({
      currentPassword: 'ein-langes-passwort',
    });
  });

  it('zeigt ohne 401 gar keine Rückfrage', async () => {
    arrangeSettings((path, method) =>
      method === 'DELETE' && path.includes('/factors/totp')
        ? new Response(JSON.stringify({ invalidatedTrustedDevices: 0 }), {
            status: 200,
          })
        : null,
    );
    await removeTotp();

    await waitFor(() =>
      expect(screen.getByText('Authenticator-App entfernt.')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Bestätige, dass du es bist')).toBeNull();
  });
});

describe('Einstellungen: Authenticator-App hinzufügen', () => {
  /** Konto OHNE Authenticator-App, damit „Hinzufügen" erscheint. */
  function arrangeWithoutTotp() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes('/api/auth/csrf')) {
          return new Response(JSON.stringify({ csrfToken: 'abc' }), {
            status: 200,
          });
        }
        if (path.includes('/api/access/totp/setup')) {
          return new Response(
            JSON.stringify({
              secretBase32: 'JBSWY3DPEHPK3PXP',
              otpauthUrl: 'otpauth://totp/Beispielprodukt:sam?secret=JBSWY3DPEHPK3PXP',
            }),
            { status: 200 },
          );
        }
        if (path.includes('/api/access/devices')) {
          return new Response(JSON.stringify({ devices: [] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            user: {
              id: '1',
              name: 'Sam',
              username: 'sam',
              email: 'admin@example.com',
              role: 'admin',
            },
            passwordSet: true,
            passkeyCount: 0,
            totpSetUp: false,
            emailCodeSetUp: true,
            loginCodeEmail: 'admin@example.com',
            setUpFactors: ['email-code'],
            openRecoveryCodes: 8,
          }),
          { status: 200 },
        );
      }),
    );
  }

  const setupCall = () =>
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('totp/setup'),
    ).length;

  /**
   * Regression zum Befund des Testers: Der Dialog rief `totp/setup` beim
   * Öffnen auf und überschrieb dabei das Geheimnis. Wer öffnete und abbrach,
   * stand danach ohne funktionierenden Authenticator da. Das Anfordern gehört
   * hinter eine bewusste Handlung.
   */
  it('fordert beim Öffnen und beim Abbrechen kein Geheimnis an', async () => {
    arrangeWithoutTotp();
    window.history.pushState({}, '', '/settings');
    render(<App />);
    await screen.findByRole('heading', { name: 'Anmeldemethoden' });

    const row = screen
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes('Authenticator-App'));
    fireEvent.click(
      within(row as HTMLElement).getByRole('button', { name: 'Hinzufügen' }),
    );

    await screen.findByRole('button', { name: 'QR-Code anzeigen' });
    expect(setupCall()).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(setupCall()).toBe(0);
  });

  it('fordert das Geheimnis erst auf „QR-Code anzeigen" an', async () => {
    arrangeWithoutTotp();
    window.history.pushState({}, '', '/settings');
    render(<App />);
    await screen.findByRole('heading', { name: 'Anmeldemethoden' });

    const row = screen
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes('Authenticator-App'));
    fireEvent.click(
      within(row as HTMLElement).getByRole('button', { name: 'Hinzufügen' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'QR-Code anzeigen' }));

    await screen.findByAltText('QR-Code zum Einrichten der Authenticator-App');
    expect(setupCall()).toBe(1);
    // Erst die Bestätigung macht die App gültig — der Knopf heißt danach so.
    expect(
      screen.getByRole('button', { name: 'Bestätigen' }),
    ).toBeInTheDocument();
  });
});
