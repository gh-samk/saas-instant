import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithI18n } from '../test-support/render-with-i18n';
import App from '../App';

/**
 * [DK1]: Der Ersteinrichtungs-Wizard lief in eine Endlosschleife.
 *
 * Der Design-Tester maß an der laufenden Oberfläche rund 99 Anfragen, danach
 * war die ganze Anwendung minutenlang durch das globale Rate-Limit blockiert.
 *
 * Die Mechanik: Die Automatik-Effekte hatten `stand` in der
 * Abhängigkeitsliste. `stand` ist ein FRISCHES OBJEKT aus jedem `neuLaden()`,
 * und `neuLaden()` läuft genau dann, wenn eine Anfrage mit 401 zurückkam.
 * Anfordern → 401 → Stand nachladen → neues Objekt → Abhängigkeit geändert →
 * anfordern. Sichtbar wird das erst ab zehn Minuten Sitzungsalter, weil der
 * Server vorher gar keinen Nachweis verlangt.
 *
 * Deshalb antwortet die Attrappe hier mit 401 auf die Automatik-Routen und
 * liefert bei jedem `/api/auth/me` ein NEUES Objekt — genau der Zustand einer
 * älteren Sitzung. Gegen die alte Fassung zählt der Zähler unten hoch, bis der
 * Notausgang der Attrappe greift.
 */

/** Ab hier bricht die Attrappe die Schleife ab, damit der Test endet. */
const EMERGENCY_EXIT = 25;

interface Calls {
  totpSetup: number;
  recoveryCodes: number;
  me: number;
}

function setFetchReady(calls: Calls, state: Record<string, unknown>) {
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
        calls.me += 1;
        // Bewusst bei JEDEM Abruf ein neues Objekt — so verhält sich der
        // echte Client auch. Genau daran hing die Schleife.
        return new Response(JSON.stringify({ ...state }), { status: 200 });
      }

      if (path.includes('/api/access/totp/setup')) {
        calls.totpSetup += 1;
        return responseEvidenceRequired(calls.totpSetup);
      }

      if (path.includes('/api/access/recovery-codes')) {
        calls.recoveryCodes += 1;
        return responseEvidenceRequired(calls.recoveryCodes);
      }

      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
}

/**
 * 401 „Nachweis nötig" — bis der Notausgang greift. Danach ein 500, das die
 * Schleife auch in der KAPUTTEN Fassung beendet: sonst liefe der Test ewig,
 * statt den Befund zu zeigen.
 */
function responseEvidenceRequired(count: number): Response {
  if (count > EMERGENCY_EXIT) {
    return new Response(
      JSON.stringify({ error: { code: 'HTTP_500', message: 'Notausgang.' } }),
      { status: 500 },
    );
  }
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
  totpSetUp: false,
  emailCodeSetUp: true,
  loginCodeEmail: 'test@example.com',
  setUpFactors: ['email-code'],
  openRecoveryCodes: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

/** Sucht ein Bedienelement und klickt es — mit Warten auf die Umschaltung. */
async function click(role: string, name: string | RegExp): Promise<void> {
  fireEvent.click(await screen.findByRole(role, { name }));
  await waitFor(() => undefined);
}

/** Lässt etwaige Nachschläge der Automatik auflaufen. */
async function runPending(): Promise<void> {
  await new Promise((done) => setTimeout(done, 400));
}

describe('[DK1] Der Wizard fordert höchstens einmal je Schritt von selbst an', () => {
  it('läuft beim TOTP-Schritt nicht in eine Endlosschleife', async () => {
    const calls: Calls = {
      totpSetup: 0,
      recoveryCodes: 0,
      me: 0,
    };
    setFetchReady(calls, STATE);
    window.history.pushState({}, '', '/first-setup');
    renderWithI18n(<App />);

    await click('button', 'Weiter');
    await click('button', 'Weitere Methode einrichten');
    await click('radio', /Authenticator-App/);

    await runPending();

    // Die alte Fassung lief hier bis in den Notausgang der Attrappe.
    expect(calls.totpSetup).toBe(1);
    // Und der Nachweisdialog steht da, statt hinter einem Spinner zu
    // verschwinden, hinter dem die Anfragen abgehen.
    expect(
      screen.getByRole('heading', { name: 'Bestätige, dass du es bist' }),
    ).toBeInTheDocument();
  });

  it('läuft beim Codes-Schritt nicht in eine Endlosschleife', async () => {
    const calls: Calls = {
      totpSetup: 0,
      recoveryCodes: 0,
      me: 0,
    };
    setFetchReady(calls, STATE);
    window.history.pushState({}, '', '/first-setup');
    renderWithI18n(<App />);

    // Passwort → zweiter Faktor → Passkey → Codes. Der zweite Faktor steht
    // schon, deshalb kommt man mit „Weiter" durch.
    for (let step = 0; step < 3; step += 1) {
      await click('button', 'Weiter');
    }

    await runPending();

    expect(calls.recoveryCodes).toBe(1);
  });

  it('bietet nach einem abgebrochenen Nachweis einen Weg zurück', async () => {
    const calls: Calls = {
      totpSetup: 0,
      recoveryCodes: 0,
      me: 0,
    };
    setFetchReady(calls, STATE);
    window.history.pushState({}, '', '/first-setup');
    renderWithI18n(<App />);

    await click('button', 'Weiter');
    await click('button', 'Weitere Methode einrichten');
    await click('radio', /Authenticator-App/);
    await screen.findByRole('heading', { name: 'Bestätige, dass du es bist' });

    await click('button', 'Abbrechen');

    // Ohne diesen Weg bliebe ein Spinner stehen: die Automatik feuert nicht
    // mehr nach, und ohne Knopf gäbe es hier gar nichts mehr zu tun.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Erneut versuchen' }),
      ).toBeInTheDocument(),
    );
    expect(calls.totpSetup).toBe(1);

    await click('button', 'Erneut versuchen');
    await waitFor(() => expect(calls.totpSetup).toBe(2));
  });
});
