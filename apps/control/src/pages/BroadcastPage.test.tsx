import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import App from '../App';
import { renderWithI18n } from '../test-support/render-with-i18n';

/**
 * Schreibt in das Redaktionsfeld.
 *
 * Ein `contentEditable` ist kein Formularfeld: `fireEvent.change` loest dort
 * nichts aus. Geschrieben wird ins DOM, gemeldet wird per `input` -- genau der
 * Weg, den auch eine Tastatur nimmt.
 */
function writeWording(text: string): void {
  const field = screen.getByLabelText('Inhalt');
  field.innerHTML = text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph}</p>`)
    .join('');
  fireEvent.input(field);
}


/**
 * Der Redaktionsbereich, Übersicht.
 *
 * Geprüft wird, was die Seite ausmacht: Die beiden Kanäle stehen getrennt, der
 * Kanal fällt beim Anlegen und nirgends sonst, und ein Platzhalter ohne
 * Erklärung kommt gar nicht erst bis zum Server.
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

const MARKETING = {
  id: '11111111-1111-4111-8111-111111111111',
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
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Zahlungserinnerung',
  channel: 'transactional',
  subject: 'Erinnerung an die offene Rechnung',
  active: false,
};

function mockFetch(
  options: { templates?: unknown; createError?: boolean } = {},
) {
  const called = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (path.includes('/api/auth/csrf')) {
        return new Response(JSON.stringify({ csrfToken: 'abc' }), {
          status: 200,
        });
      }
      if (path.includes('/api/auth/me')) {
        return new Response(JSON.stringify(STATE), { status: 200 });
      }
      if (path.includes('/api/broadcast/counters')) {
        return new Response(
          JSON.stringify({ templates: 2, confirmed: 128, disabled: 3 }),
          { status: 200 },
        );
      }
      if (path.includes('/api/broadcast/templates') && method === 'POST') {
        if (options.createError === true) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'unknown_placeholders',
                message: 'Unbekannte Platzhalter: {{name}}.',
              },
            }),
            { status: 422 },
          );
        }
        return new Response(JSON.stringify(MARKETING), { status: 201 });
      }
      if (path.includes('/api/broadcast/templates')) {
        return new Response(
          JSON.stringify(options.templates ?? [MARKETING, TRANSACTIONAL]),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    },
  );
  vi.stubGlobal('fetch', called);
  return called;
}

function openPage() {
  window.history.pushState({}, '', '/broadcast');
  renderWithI18n(<App />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('Rundmail — Übersicht der Vorlagen', () => {
  it('führt beide Kanäle in EINER Tabelle, mit dem Kanal als Spalte', async () => {
    // Bis zum Redesign standen sie in zwei Abschnitten. Der Einwand dagegen
    // war das Vergreifen beim Versenden — und genau das verhindert jetzt die
    // Aktionsspalte, nicht die Gliederung.
    mockFetch();
    openPage();

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Neuigkeiten Herbst')).toBeInTheDocument();
    expect(within(table).getByText('Zahlungserinnerung')).toBeInTheDocument();
    expect(within(table).getByText('Werblich')).toBeInTheDocument();
    expect(within(table).getByText('Transaktion')).toBeInTheDocument();
    expect(within(table).getByText('Stillgelegt')).toBeInTheDocument();
  });

  it('SPERRT DEN SENDEKNOPF AN EINER TRANSAKTIONSVORLAGE', async () => {
    // Sie geht je Vorgang hinaus, nicht auf Zuruf. Ein aktiver Knopf
    // verspräche etwas, das der Server abweist.
    mockFetch();
    openPage();

    const rows = (await screen.findByRole('table')).querySelectorAll('tbody tr');
    const marketing = within(rows[0] as HTMLElement);
    const transactional = within(rows[1] as HTMLElement);

    expect(marketing.getByRole('button', { name: 'Senden …' })).toBeEnabled();
    const disabled = transactional.getByRole('button', { name: 'Senden' });
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveAttribute(
      'title',
      'Wird automatisch je Vorgang versendet',
    );
  });

  it('sagt je Zeile, WER die Mail bekommt', async () => {
    mockFetch();
    openPage();

    const rows = (await screen.findByRole('table')).querySelectorAll('tbody tr');
    expect(within(rows[0] as HTMLElement).getByText('128')).toBeInTheDocument();
    expect(
      within(rows[1] as HTMLElement).getByText('je Vorgang'),
    ).toBeInTheDocument();
  });

  it('zeigt Datumsangaben als dd.mm.yyyy, nie als ISO', async () => {
    mockFetch();
    openPage();

    await screen.findByRole('table');
    expect(screen.getAllByText('20.08.2026').length).toBeGreaterThan(0);
    expect(screen.queryByText(/2026-08-20/)).toBeNull();
  });

  it('hat kein Dauerband mehr: Der Hinweis steht im Versanddialog', async () => {
    mockFetch();
    openPage();

    await screen.findByRole('table');
    expect(screen.queryByText(/Versand nur an bestätigte Einwilligungen/)).toBeNull();
  });

  it('nennt die Reiter Vorlagen, Einwilligungen, Sperrliste und blendet „0“ aus', async () => {
    mockFetch();
    openPage();

    await screen.findByRole('table');
    const nav = screen.getByRole('navigation', { name: 'Bereiche der Rundmail' });
    const labels = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent?.replace(/\d+$/, ''));
    expect(labels).toEqual(['Vorlagen', 'Einwilligungen', 'Sperrliste']);
    expect(nav.textContent).not.toMatch(/(^|\D)0(\D|$)/);
  });

  it('bietet nirgends einen Import oder ein freies Adressfeld an (Abwesenheit)', async () => {
    mockFetch();
    openPage();

    await screen.findByRole('table');
    for (const forbidden of [/import/i, /an alle/i, /empfänger hinzufügen/i]) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }
  });

  it('lässt den Kanal beim Anlegen setzen — und sagt, dass er danach feststeht', async () => {
    mockFetch();
    openPage();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Vorlage anlegen' }),
    );

    const channel = await screen.findByLabelText('Kanal');
    expect(channel).toBeInTheDocument();
    expect(
      screen.getByText(/Kanal steht danach fest und lässt sich nicht mehr/),
    ).toBeInTheDocument();
  });

  it('hält den Anlegen-Knopf gesperrt, solange ein Platzhalter unerklärt ist', async () => {
    const called = mockFetch();
    openPage();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Vorlage anlegen' }),
    );
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Testvorlage' },
    });
    fireEvent.change(screen.getByLabelText('Betreff'), {
      target: { value: 'Ein Betreff' },
    });
    writeWording('Hallo {{name}}, das hier ist lang genug.');

    // Der letzte Knopf mit diesem Namen ist der in der Fussleiste des Dialogs.
    const dialogButton = screen
      .getAllByRole('button', { name: /^Vorlage anlegen$/ })
      .at(-1);
    expect(dialogButton).toBeDisabled();
    expect(screen.getByText(/sind aber nirgends erklärt/)).toBeInTheDocument();

    // Nichts ist an den Server gegangen.
    expect(
      called.mock.calls.filter(
        ([, init]) => (init?.method ?? 'GET').toUpperCase() === 'POST',
      ),
    ).toHaveLength(0);

    // Sobald der Platzhalter deklariert ist, trägt der Entwurf.
    fireEvent.change(screen.getByLabelText('Eigene Platzhalter'), {
      target: { value: 'name' },
    });
    expect(
      screen.getAllByRole('button', { name: /^Vorlage anlegen$/ }).at(-1),
    ).toBeEnabled();
  });

  it('zeigt den Fehler des Servers im Wortlaut, statt still zu scheitern', async () => {
    mockFetch({ createError: true });
    openPage();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Vorlage anlegen' }),
    );
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Testvorlage' },
    });
    fireEvent.change(screen.getByLabelText('Betreff'), {
      target: { value: 'Ein Betreff' },
    });
    writeWording('Ein Text, der lang genug für eine Vorlage ist.');
    fireEvent.click(
      screen.getAllByRole('button', { name: /^Vorlage anlegen$/ }).at(-1)!,
    );

    expect(
      await screen.findByText('Unbekannte Platzhalter: {{name}}.'),
    ).toBeInTheDocument();
  });

  it('meldet einen Ladefehler sichtbar und bietet einen zweiten Versuch an', async () => {
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
        if (path.includes('/api/broadcast/templates'))
          return new Response(
            JSON.stringify({
              error: {
                code: 'HTTP_500',
                message: 'Die Datenbank antwortet gerade nicht.',
              },
            }),
            { status: 500 },
          );
        return new Response('{}', { status: 200 });
      }),
    );
    openPage();

    expect(
      await screen.findByText('Die Datenbank antwortet gerade nicht.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Erneut versuchen' }),
    ).toBeInTheDocument();
  });

  it('überlebt eine Antwort, die gar keine Liste ist', async () => {
    mockFetch({ templates: { unerwartet: true } });
    openPage();

    expect(
      await screen.findByText('Die Vorlagenliste kam in einer unerwarteten Form.'),
    ).toBeInTheDocument();
  });

  it('zeigt einen Leerzustand, wenn es noch keine Vorlage gibt', async () => {
    mockFetch({ templates: [] });
    openPage();

    expect(await screen.findByText('Noch keine Vorlagen')).toBeInTheDocument();
  });

  it('führt nach dem Anlegen direkt in die neue Vorlage', async () => {
    mockFetch();
    openPage();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Vorlage anlegen' }),
    );
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Neuigkeiten Herbst' },
    });
    fireEvent.change(screen.getByLabelText('Betreff'), {
      target: { value: 'Neues aus dem Produkt' },
    });
    writeWording('Ein Text, der lang genug für eine Vorlage ist.');
    fireEvent.click(
      screen.getAllByRole('button', { name: /^Vorlage anlegen$/ }).at(-1)!,
    );

    await waitFor(() => {
      expect(window.location.pathname).toBe(`/broadcast/${MARKETING.id}`);
    });
  });
});

/**
 * DIE ALTEN ADRESSEN DES BEREICHS.
 *
 * `/consents` und `/newsletter-block` waren eigene Menüpunkte und
 * stehen in Lesezeichen. Ohne Weiterleitung fielen sie auf die Auffangroute
 * — und die schickt STILL auf die Startseite. Ein Klick auf ein Lesezeichen
 * landete auf „Heute", ohne dass irgendetwas nach Fehler aussähe.
 */
describe('Die alten Rundmail-Adressen leiten weiter', () => {
  it.each([
    ['/consents', '/broadcast/consents'],
    ['/newsletter-block', '/broadcast/blocklist'],
  ])('führt von %s auf %s', async (old, next) => {
    mockFetch();
    window.history.pushState({}, '', old);
    renderWithI18n(<App />);

    await waitFor(() => expect(window.location.pathname).toBe(next));
  });

  it('MARKIERT DEN GEWÄHLTEN REITER, nicht zwei gleichzeitig', async () => {
    // `/broadcast` ist Präfix von `/broadcast/blocklist`. Mit `startsWith`
    // wären beide Reiter aktiv, und die Leiste sagte nicht mehr, wo man ist.
    mockFetch();
    window.history.pushState({}, '', '/broadcast/blocklist');
    renderWithI18n(<App />);

    const bar = await screen.findByRole('navigation', {
      name: 'Bereiche der Rundmail',
    });
    const marked = within(bar)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'page');
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent('Sperrliste');
  });
});
