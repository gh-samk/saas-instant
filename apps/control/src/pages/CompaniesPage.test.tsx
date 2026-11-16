import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n } from '../test-support/render-with-i18n';
import App from '../App';

/**
 * Die Organisationsliste: Filter und Suche stehen in der URL, gefiltert wird
 * serverseitig, und die beiden Leerzustände sagen Verschiedenes.
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

const ONE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Solawi Rheintal',
  status: 'pilot_running',
  city: 'Freiburg',
  contactName: 'Lena Brandt',
  contactEmail: 'contact@example.com',
  reviewDueDate: '2026-12-01',
  lastStatusChangeAt: '2026-05-01',
  createdAt: '2026-04-02T09:12:00.000Z',
  instanceStatus: 'active',
  openAmountCent: 124_000,
  openOverdue: false,
};

function setFetchReady(
  response: (path: string) => Response,
): ReturnType<typeof vi.fn> {
  const called = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/api/auth/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
    }
    if (path.includes('/api/auth/me')) {
      return new Response(JSON.stringify(STATE), { status: 200 });
    }
    return response(path);
  });
  vi.stubGlobal('fetch', called);
  return called;
}

function list(companies: unknown[], total = companies.length) {
  return new Response(
    JSON.stringify({
      companies,
      total,
      page: 1,
      perPage: 25,
      // Die Zahlen der Filterchips. Sie kommen vom Server und beachten die
      // Suche, aber nicht den Statusfilter.
      countPerStatus: { pilot_running: total },
    }),
    { status: 200 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('Organisationsliste', () => {
  it('zeigt Name, Ort, Status, Ansprechpartnerin und Datum in deutscher Form', async () => {
    setFetchReady((path) =>
      path.includes('/api/companies')
        ? list([ONE])
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/companies');
    renderWithI18n(<App />);

    await screen.findByText('Solawi Rheintal');
    // Innerhalb der Tabelle prüfen: „Pilot läuft" steht zusätzlich als Option
    // im Statusfilter, und der ist hier nicht gemeint.
    const rows = within(screen.getByRole('table'));
    expect(rows.getByText('Solawi Rheintal')).toBeInTheDocument();
    expect(rows.getByText('Freiburg')).toBeInTheDocument();
    expect(rows.getByText('Pilot läuft')).toBeInTheDocument();
    // Instanz und offener Betrag stehen seit dem Redesign in der Liste:
    // beim Überfliegen sind das die zwei Fragen, die man wirklich hat.
    expect(rows.getByText('Aktiv')).toBeInTheDocument();
    expect(rows.getByText('1.240,00 €')).toBeInTheDocument();
    // dd.mm.yyyy, niemals ISO — auch aus einem technischen Zeitstempel.
    expect(rows.getByText('01.12.2026')).toBeInTheDocument();
    expect(screen.queryByText(/2026-12-01/)).not.toBeInTheDocument();
    // Die Ansprechpartnerin hat keine eigene Spalte mehr — sie steht auf der
    // Detailseite. Eine Liste, die alles zeigt, zeigt nichts.
    expect(rows.queryByText('Lena Brandt')).not.toBeInTheDocument();
  });

  it('färbt einen überfälligen Betrag rot und schreibt „—", wo nichts offen ist', async () => {
    // Die einzige Stelle der Liste, an der Farbe etwas behauptet.
    setFetchReady((path) =>
      path.includes('/api/companies')
        ? list([
            { ...ONE, openAmountCent: 48_000, openOverdue: true },
            {
              ...ONE,
              id: '22222222-2222-4222-8222-222222222222',
              name: 'Ohne Forderung',
              openAmountCent: 0,
              openOverdue: false,
            },
          ])
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/companies');
    renderWithI18n(<App />);

    const amount = await screen.findByText('480,00 €');
    expect(amount.className).toContain('text-gefahr');
    expect(within(screen.getByRole('table')).getByText('—')).toBeInTheDocument();
  });

  it('reicht den Statusfilter an den Server weiter und merkt ihn in der URL', async () => {
    const called = setFetchReady((path) =>
      path.includes('/api/companies')
        ? list([ONE])
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/companies');
    renderWithI18n(<App />);

    await screen.findByText('Solawi Rheintal');
    const bar = within(
      screen.getByRole('group', { name: 'Nach Status filtern' }),
    );
    fireEvent.click(bar.getByRole('button', { name: /Ruhend/ }));

    await waitFor(() =>
      expect(
        called.mock.calls.some((call) =>
          String(call[0]).includes('status=dormant'),
        ),
      ).toBe(true),
    );
    expect(window.location.search).toContain('status=dormant');
  });

  it('DER CHIP „PILOT" SCHICKT BEIDE PILOTSTUFEN — nicht nur eine', async () => {
    // `pilot_beschlossen` und `pilot_laufend` sind derselbe Lebensabschnitt.
    // Schickte der Chip nur einen davon, versteckte er die halbe Gruppe.
    const called = setFetchReady((path) =>
      path.includes('/api/companies')
        ? list([ONE])
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/companies');
    renderWithI18n(<App />);

    await screen.findByText('Solawi Rheintal');
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Nach Status filtern' }),
      ).getByRole('button', { name: /Pilot/ }),
    );

    await waitFor(() =>
      expect(
        called.mock.calls.some((call) =>
          String(call[0]).includes(
            `status=${encodeURIComponent('pilot_approved,pilot_running')}`,
          ),
        ),
      ).toBe(true),
    );
  });

  it('unterscheidet „noch gar nichts da" von „nichts gefunden"', async () => {
    setFetchReady((path) =>
      path.includes('/api/companies')
        ? list([])
        : new Response('{}', { status: 200 }),
    );

    window.history.pushState({}, '', '/companies');
    const { unmount } = renderWithI18n(<App />);
    // Ohne Filter: Startzustand mit Einladung zum Anlegen, ohne Suchfeld.
    expect(
      await screen.findByText('Noch keine Organisationen'),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Organisationen durchsuchen'),
    ).not.toBeInTheDocument();
    unmount();

    window.history.pushState({}, '', '/companies?search=xyz');
    renderWithI18n(<App />);
    // Mit Filter: die Werkzeugleiste bleibt stehen, damit sofort weiter
    // gefiltert werden kann.
    expect(
      await screen.findByText('Keine Organisationen gefunden'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Organisationen durchsuchen'),
    ).toBeInTheDocument();
  });

  it('meldet einen Ladefehler sichtbar und bietet einen zweiten Versuch an', async () => {
    setFetchReady((path) =>
      path.includes('/api/companies')
        ? new Response(
            JSON.stringify({
              error: {
                code: 'HTTP_500',
                message: 'Die Liste ließ sich nicht laden.',
              },
            }),
            { status: 500 },
          )
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/companies');
    renderWithI18n(<App />);

    expect(
      await screen.findByText('Die Liste ließ sich nicht laden.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Erneut versuchen' }),
    ).toBeInTheDocument();
    // Kein Leerzustand, der Ordnung behauptet, wo keine ist.
    expect(
      screen.queryByText('Noch keine Organisationen'),
    ).not.toBeInTheDocument();
  });

  it('[W5] bleibt eine Anfrage ohne Ansprechpartnerin auffindbar', async () => {
    // Eine Demo-Anfrage über das Formular bringt oft nur eine Adresse mit.
    // Die Kontaktspalte gibt es seit dem Redesign nicht mehr — dafür trägt
    // der NAME die Adresse („Anfrage von …", siehe oeffentlich.service.ts),
    // und die Zeile bleibt so identifizierbar. Geprüft wird deshalb, dass
    // eine solche Organisation vollständig dasteht und nicht als leere Zeile.
    setFetchReady((path) =>
      path.includes('/api/companies')
        ? list([
            {
              ...ONE,
              name: 'Anfrage von gast@example.com',
              contactName: null,
              contactEmail: 'gast@example.com',
            },
          ])
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/companies');
    renderWithI18n(<App />);

    const rows = within(await screen.findByRole('table'));
    expect(
      rows.getByText('Anfrage von gast@example.com'),
    ).toBeInTheDocument();
    expect(rows.getByText('Freiburg')).toBeInTheDocument();
  });

  it('[W2] nimmt Filter und Suche mit auf die Detailseite und wieder zurück', async () => {
    // Filter und Suche stehen eigens in der URL, damit ein Zurückspringen die
    // Arbeit nicht von vorn beginnen lässt. Führte der Rückweg auf die
    // ungefilterte Liste, wäre genau das verloren.
    setFetchReady((path) =>
      path.includes('/api/companies')
        ? list([ONE])
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/companies?status=demo&search=Rhein');
    renderWithI18n(<App />);

    await screen.findByText('Solawi Rheintal');
    const target = within(screen.getByRole('table'))
      .getByRole('link')
      .getAttribute('href');
    expect(target).toContain(`/companies/${ONE.id}`);
    expect(target).toContain('status=demo');
    expect(target).toContain('search=Rhein');
  });

  it('[K1] gibt der Tabelle feste Spaltenbreiten, damit lange Namen kürzen', async () => {
    // Unter `table-layout: auto` wächst die Namensspalte mit dem längsten
    // Namen, `truncate` bleibt wirkungslos und die Tabelle sprengt ihre Hülle.
    setFetchReady((path) =>
      path.includes('/api/companies')
        ? list([{ ...ONE, name: 'Ver' + 'ein '.repeat(24) + 'Nordstadt' }])
        : new Response('{}', { status: 200 }),
    );
    window.history.pushState({}, '', '/companies');
    renderWithI18n(<App />);

    const table = await screen.findByRole('table');
    expect(table.className).toContain('sm:table-fixed');
    expect(table.querySelectorAll('colgroup col')).toHaveLength(6);
  });
});

/** Schmaler Bildschirm: `matchMedia` meldet „passt nicht" für jede Mindestbreite. */
function stubNarrow() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe('Organisationsliste — Karten unter 1280 px', () => {
  it('zeigt statt der Tabelle Karten mit Status und offenem Betrag, ohne Platzhalter', async () => {
    stubNarrow();
    const empty = { ...ONE, id: '22222222-2222-4222-8222-222222222222', name: 'Leere Gruppe', city: null, reviewDueDate: null, openAmountCent: 0 };
    setFetchReady(() => list([ONE, empty]));
    window.history.pushState({}, '', '/companies');
    renderWithI18n(<App />);

    const cards = await screen.findByRole('list', { name: 'Organisationen' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const [first, second] = within(cards).getAllByRole('listitem');
    expect(within(first).getByRole('link', { name: 'Solawi Rheintal' })).toHaveAttribute(
      'href',
      '/companies/11111111-1111-4111-8111-111111111111',
    );
    expect(first).toHaveTextContent('1.240,00');
    expect(first).toHaveTextContent('01.12.2026');
    // Nichts Offenes, keine Frist: weder Betrag noch Frist noch „—".
    expect(second).not.toHaveTextContent('—');
    expect(second).not.toHaveTextContent('Frist');
    expect(second).not.toHaveTextContent('Offen');
  });

  it('bleibt auf breitem Bildschirm bei der Tabelle (ohne matchMedia)', async () => {
    setFetchReady(() => list([ONE]));
    window.history.pushState({}, '', '/companies');
    renderWithI18n(<App />);

    expect(await screen.findByRole('table')).toBeInTheDocument();
  });
});
