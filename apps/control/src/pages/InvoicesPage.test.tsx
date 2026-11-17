import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n } from '../test-support/render-with-i18n';
import App from '../App';

/**
 * Die globale Rechnungsliste.
 *
 * DER SCHWERPUNKT LIEGT AUF DER AKTIONSSPALTE. Regel 4 des Entwurfs lautet
 * „Aktionen passen zum Zustand des Objekts", und das Abnahmekriterium wird
 * ausdrücklich: „Bezahlte und stornierte Rechnungen bieten AUSSCHLIESSLICH
 * ansehen an." Eine Liste, die ein Bezahlt-Häkchen an einer bezahlten
 * Rechnung zeigt, lädt zu einer Handlung ein, die fachlich nicht mehr geht.
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

const ORG = '11111111-1111-4111-8111-111111111111';

function invoice(
  id: string,
  paymentState: string,
  number: string | null,
  grossCent = 48_000,
) {
  return {
    id,
    companyId: ORG,
    companyName: 'Verein Beispielgarten',
    invoiceNumber: number,
    status: paymentState === 'draft' ? 'draft' : 'finalized',
    paymentState,
    invoiceDate: '2026-08-01',
    servicePeriodFrom: '2026-08-01',
    servicePeriodUntil: '2026-08-31',
    dueDate: '2026-08-15',
    sumGrossCent: grossCent,
    sumGross: '480,00',
    openAmount: '480,00',
    paidAmount: null,
    recipientName: 'Verein Beispielgarten',
    recipientEmail: 'kasse@beispielgarten.example',
    sumNetCent: grossCent,
    sumTaxCent: 0,
    lines: [],
    documentPresent: false,
  };
}

const METRICS = {
  year: 2026,
  openCent: 186_000,
  openCount: 2,
  overdueCent: 48_000,
  overdueCount: 1,
  paidCent: 2_448_000,
};

const COMPANIES = {
  companies: [
    { id: ORG, name: 'Verein Beispielgarten', city: 'Freiburg', status: 'paying' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Solawi Rheintal', city: null, status: 'paying' },
  ],
  total: 2,
  page: 1,
  perPage: 8,
  countPerStatus: {},
};

function setFetchReady(invoices: unknown[]) {
  const called = vi.fn(async (input: unknown) => {
    const path = String(input);
    if (/\/api\/companies\/[0-9a-f-]+$/.test(path)) {
      return new Response(
        JSON.stringify({ ...COMPANIES.companies[1] }),
        { status: 200 },
      );
    }
    if (path.includes('/api/companies')) {
      const search = new URL(path, 'http://x').searchParams.get('search') ?? '';
      const list = COMPANIES.companies.filter((c) =>
        c.name.toLowerCase().includes(search.toLowerCase()),
      );
      return new Response(
        JSON.stringify({ ...COMPANIES, companies: list, total: list.length }),
        { status: 200 },
      );
    }
    if (path.includes('/api/auth/csrf')) {
      return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
    }
    if (path.includes('/api/auth/me')) {
      return new Response(JSON.stringify(STATE), { status: 200 });
    }
    if (path.includes('/api/invoices/metrics')) {
      return new Response(JSON.stringify(METRICS), { status: 200 });
    }
    if (path.includes('/api/invoices')) {
      return new Response(
        JSON.stringify({
          invoices,
          total: invoices.length,
          page: 1,
          perPage: 25,
          countPerState: {
            draft: 1,
            open: 2,
            overdue: 1,
            partially_paid: 0,
            paid: 2,
            cancelled: 1,
          },
        }),
        { status: 200 },
      );
    }
    if (path.includes('/api/navigation/counters')) {
      return new Response(
        JSON.stringify({ tasksUrgent: 0, invoicesOpen: 3 }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', called);
  return called;
}

function open(search = '') {
  window.history.pushState({}, '', `/invoices${search}`);
  renderWithI18n(<App />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

function firstRow() {
  return within(
    document.querySelector('tbody tr') as HTMLElement,
  );
}

describe('Rechnungsliste — Aktionen passen zum Zustand', () => {
  it('bietet beim ENTWURF genau „Bearbeiten“ als Hauptknopf an', async () => {
    setFetchReady([invoice('r1', 'draft', null)]);
    open();

    await screen.findByRole('table');
    const row = firstRow();
    expect(row.getByRole('button', { name: /Bearbeiten/ })).toBeInTheDocument();
    expect(row.queryByRole('button', { name: /Zahlung/ })).toBeNull();
    expect(row.queryByRole('button', { name: /ansehen/i })).toBeNull();
  });

  it('bietet bei OFFEN „Zahlung“ als Hauptknopf; Erinnerung erst ab überfällig', async () => {
    setFetchReady([invoice('r2', 'open', '2026-0151')]);
    open();

    await screen.findByRole('table');
    const row = firstRow();
    const main = row.getByRole('button', { name: /Zahlung zu 2026-0151 erfassen/ });
    expect(main).toHaveTextContent('Zahlung');
    // Offen, aber noch nicht fällig: keine Erinnerung im Menü.
    fireEvent.click(row.getByRole('button', { name: 'Weitere Aktionen zu 2026-0151' }));
    expect(screen.queryByRole('menuitem', { name: 'Zahlungserinnerung senden' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Organisation öffnen' })).toBeInTheDocument();
  });

  it('bietet bei ÜBERFÄLLIG „Zahlung“ als Hauptknopf und die Erinnerung im Zeilenmenü', async () => {
    setFetchReady([invoice('r2', 'overdue', '2026-0151')]);
    open();

    await screen.findByRole('table');
    const row = firstRow();
    expect(
      row.getByRole('button', { name: /Zahlung zu 2026-0151 erfassen/ }),
    ).toBeInTheDocument();
    fireEvent.click(row.getByRole('button', { name: 'Weitere Aktionen zu 2026-0151' }));
    expect(
      screen.getByRole('menuitem', { name: 'Zahlungserinnerung senden' }),
    ).toBeInTheDocument();
  });

  it('BIETET BEI BEZAHLT AUSSCHLIESSLICH ANSEHEN AN (keine Zahlung, keine Erinnerung)', async () => {
    // Abnahmekriterium des Entwurfs, wörtlich. Ein Bezahlt-Häkchen an einer
    // bezahlten Rechnung lädt zu einer Handlung ein, die es nicht mehr gibt.
    setFetchReady([invoice('r3', 'paid', '2026-0139')]);
    open();

    await screen.findByRole('table');
    const row = firstRow();
    expect(row.getByRole('button', { name: /ansehen/i })).toBeInTheDocument();
    expect(row.queryByRole('button', { name: /Zahlung zu/ })).toBeNull();
    fireEvent.click(row.getByRole('button', { name: 'Weitere Aktionen zu 2026-0139' }));
    expect(screen.queryByRole('menuitem', { name: /Zahlung/ })).toBeNull();
  });

  it('BIETET BEI STORNIERT AUSSCHLIESSLICH ANSEHEN AN', async () => {
    setFetchReady([invoice('r4', 'cancelled', '2026-0131')]);
    open();

    await screen.findByRole('table');
    const row = firstRow();
    expect(row.getByRole('button', { name: /ansehen/i })).toBeInTheDocument();
    expect(row.queryByRole('button', { name: /Zahlung zu/ })).toBeNull();
  });
});

describe('Rechnungsliste — Direktaktionen ohne Seitenwechsel', () => {
  it('„Zahlung“ öffnet den Zahlungsdialog IN der Liste', async () => {
    setFetchReady([invoice('r2', 'overdue', '2026-0151')]);
    open();

    await screen.findByRole('table');
    fireEvent.click(
      firstRow().getByRole('button', { name: /Zahlung zu 2026-0151 erfassen/ }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/2026-0151/)).toBeInTheDocument();
    expect(window.location.pathname).toBe('/invoices');
  });

  it('die Erinnerung fragt ERST NACH und schickt vor der Bestätigung nichts', async () => {
    const called = setFetchReady([invoice('r2', 'overdue', '2026-0151')]);
    open();

    await screen.findByRole('table');
    fireEvent.click(
      firstRow().getByRole('button', { name: 'Weitere Aktionen zu 2026-0151' }),
    );
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Zahlungserinnerung senden' }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('kasse@beispielgarten.example')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/invoices');
    expect(
      called.mock.calls.some((c) => String(c[0]).includes('/reminder')),
    ).toBe(false);
  });
});

describe('Rechnungsliste — Kopfzeile und Organisationswahl', () => {
  it('hat „+ Rechnung“ als Hauptknopf und den Export als Sekundärknopf', async () => {
    setFetchReady([invoice('r1', 'open', '2026-0151')]);
    open();

    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Rechnung' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Export für Betriebsprüfung/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Rechnung bei einer Organisation anlegen')).toBeNull();
  });

  it('fragt „Für welche Organisation?“, sucht und springt in den neuen Entwurf', async () => {
    const called = setFetchReady([invoice('r1', 'open', '2026-0151')]);
    open();

    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Rechnung' }));

    const dialog = await screen.findByRole('dialog', { name: 'Für welche Organisation?' });
    // Ohne Eingabe stehen die ersten Treffer da.
    expect(await within(dialog).findByText('Verein Beispielgarten')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByRole('searchbox'), {
      target: { value: 'rhein' },
    });
    await waitFor(() =>
      expect(
        called.mock.calls.some((c) => String(c[0]).includes('search=rhein')),
      ).toBe(true),
    );
    fireEvent.click(await within(dialog).findByRole('button', { name: /Solawi Rheintal/ }));

    await waitFor(() =>
      expect(window.location.pathname).toBe(
        '/companies/22222222-2222-4222-8222-222222222222/invoices/new',
      ),
    );
  });

  it('meldet „keine Organisation gefunden“', async () => {
    setFetchReady([invoice('r1', 'open', '2026-0151')]);
    open();

    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Rechnung' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('searchbox'), {
      target: { value: 'zzz' },
    });
    expect(
      await within(dialog).findByText('Keine Organisation gefunden.'),
    ).toBeInTheDocument();
  });
});

describe('Rechnungsliste — Kacheln, Chips und Zustände', () => {
  it('zeigt genau drei Kacheln, keine für Entwürfe', async () => {
    // Entwürfe stehen als Chip im Filter. Eine vierte Kachel dafür wäre eine
    // Zahl ohne Geldbezug zwischen drei Beträgen.
    setFetchReady([invoice('r1', 'open', '2026-0151')]);
    open();

    await screen.findByRole('table');
    expect(
      screen.getByRole('button', { name: /Offene Beträge/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Überfällige Beträge/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Bezahlter Umsatz 2026/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Entwürfe/ }),
    ).toBeNull();
  });

  it('filtert über die Kachel und merkt es in der URL', async () => {
    const called = setFetchReady([invoice('r1', 'open', '2026-0151')]);
    open();

    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: /Überfällige Beträge/ }));

    await waitFor(() =>
      expect(window.location.search).toContain('state=overdue'),
    );
    await waitFor(() =>
      expect(
        called.mock.calls.some((a) =>
          String(a[0]).includes('state=overdue'),
        ),
      ).toBe(true),
    );
  });

  it('SCHREIBT BEIM ENTWURF KEIN FÄLLIGKEITSDATUM, sondern „—"', async () => {
    // Ein Entwurf hat weder Nummer noch verbindliche Frist. Beides zu zeigen
    // hiesse, eine Zusage zu behaupten, die erst das Festschreiben macht.
    setFetchReady([invoice('r1', 'draft', null)]);
    open();

    const row = within((await screen.findByRole('table')).querySelector('tbody tr')!);
    expect(row.getAllByText('—')).toHaveLength(2);
  });

  it('unterscheidet „noch keine" von „keine in dieser Auswahl"', async () => {
    setFetchReady([]);
    open();
    expect(await screen.findByText('Noch keine Rechnungen')).toBeInTheDocument();

    window.history.pushState({}, '', '/invoices?state=cancelled');
    renderWithI18n(<App />);
    expect(
      await screen.findByText('Keine Rechnung in dieser Auswahl'),
    ).toBeInTheDocument();
  });
});

describe('Rechnungsliste — Karten unter 1280 px', () => {
  function narrow(matches: boolean) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  }

  it('zeigt statt der Tabelle eine Kartenliste mit Hauptknopf und Menü', async () => {
    narrow(false);
    setFetchReady([invoice('r2', 'overdue', '2026-0151')]);
    open();

    const list = await screen.findByRole('list', { name: 'Rechnungen' });
    expect(screen.queryByRole('table')).toBeNull();
    const card = within(within(list).getByRole('listitem'));
    expect(card.getByRole('link', { name: '2026-0151' })).toBeInTheDocument();
    expect(card.getByText('Überfällig')).toBeInTheDocument();
    expect(card.getByText('Verein Beispielgarten')).toBeInTheDocument();
    expect(card.getByText('Betrag')).toBeInTheDocument();
    expect(card.getByText('Fällig')).toBeInTheDocument();
    expect(
      card.getByRole('button', { name: /Zahlung zu 2026-0151 erfassen/ }),
    ).toBeInTheDocument();
    expect(
      card.getByRole('button', { name: 'Weitere Aktionen zu 2026-0151' }),
    ).toBeInTheDocument();
  });

  it('zeigt ab 1280 px die Tabelle', async () => {
    narrow(true);
    setFetchReady([invoice('r2', 'overdue', '2026-0151')]);
    open();
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Rechnungen' })).toBeNull();
  });
});
