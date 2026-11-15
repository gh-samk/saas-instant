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

function setFetchReady(invoices: unknown[]) {
  const called = vi.fn(async (input: unknown) => {
    const path = String(input);
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

describe('Rechnungsliste — Aktionen passen zum Zustand', () => {
  it('bietet beim ENTWURF genau „Bearbeiten" an', async () => {
    setFetchReady([invoice('r1', 'draft', null)]);
    open();

    const row = within((await screen.findByRole('table')).querySelector('tbody tr')!);
    expect(row.getByRole('button', { name: /Bearbeiten/ })).toBeInTheDocument();
    expect(row.queryByRole('button', { name: /bezahlt/i })).toBeNull();
    expect(row.queryByRole('button', { name: /ansehen/i })).toBeNull();
  });

  it('bietet bei OFFEN Zahlung erfassen und Erinnerung an', async () => {
    setFetchReady([invoice('r2', 'open', '2026-0151')]);
    open();

    const row = within((await screen.findByRole('table')).querySelector('tbody tr')!);
    expect(
      row.getByRole('button', { name: /Zahlung zu 2026-0151 erfassen/ }),
    ).toBeInTheDocument();
    expect(
      row.getByRole('button', { name: /Erinnerung zu 2026-0151 senden/ }),
    ).toBeInTheDocument();
  });

  it('BIETET BEI BEZAHLT AUSSCHLIESSLICH ANSEHEN AN', async () => {
    // Abnahmekriterium des Entwurfs, wörtlich. Ein Bezahlt-Häkchen an einer
    // bezahlten Rechnung lädt zu einer Handlung ein, die es nicht mehr gibt.
    setFetchReady([invoice('r3', 'paid', '2026-0139')]);
    open();

    const row = within((await screen.findByRole('table')).querySelector('tbody tr')!);
    const buttons = row.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(/ansehen/i);
  });

  it('BIETET BEI STORNIERT AUSSCHLIESSLICH ANSEHEN AN', async () => {
    setFetchReady([invoice('r4', 'cancelled', '2026-0131')]);
    open();

    const row = within((await screen.findByRole('table')).querySelector('tbody tr')!);
    const buttons = row.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(/ansehen/i);
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
