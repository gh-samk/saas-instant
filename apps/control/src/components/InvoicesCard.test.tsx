import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { MemoryRouter } from 'react-router-dom';
import { InvoicesCard } from './InvoicesCard';
import type { Invoice } from '../lib/api';

/**
 * Die Rechnungsliste einer Organisation.
 *
 * Zwei Fallstricke des Vertrags werden hier festgenagelt, weil beide
 * unsichtbar falsch sein können: Der Server liefert ZWEI Statusfelder, und
 * angezeigt gehört nur das abgeleitete; und Geldbeträge kommen als
 * Punkt-Zeichenketten („583.10"), die roh gerendert wie ein Programmierfehler
 * aussähen.
 */

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

function invoice(part: Partial<Invoice>): Invoice {
  return {
    id: 'r1',
    companyId: COMPANY_ID,
    companyName: 'Kollektiv Grünspecht e. V.',
    introduction: null,
    paymentNote: null,
    internalNote: null,
    invoiceNumber: '2026-014',
    status: 'sent',
    paymentState: 'overdue',
    invoiceDate: '2026-08-03',
    servicePeriodFrom: '2026-08-01',
    servicePeriodUntil: '2026-08-31',
    dueDate: '2026-08-17',
    finalizedAt: '2026-08-03T10:00:00.000Z',
    createdAt: '2026-08-03T09:00:00.000Z',
    paymentDate: null,
    paidAmount: null,
    openAmount: '583.10',
    sumNet: '490.00',
    sumTax: '93.10',
    sumGross: '583.10',
    sumGrossCent: 58310,
    cancellationInvoiceId: null,
    cancelledInvoiceId: null,
    cancellationReason: null,
    isCancellation: false,
    recipientName: 'Solawi Rheintal',
    recipientAddress: 'Hauptstraße 12\n79098 Freiburg',
    recipientEmail: null,
    transferStatus: null,
    documentPresent: true,
    lines: [],
    ...part,
  };
}

function arrangeFetch(response: () => Response) {
  const called = vi.fn(async () => response());
  vi.stubGlobal('fetch', called);
  return called;
}

function show() {
  render(
    <MemoryRouter>
      <InvoicesCard companyId={COMPANY_ID} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Rechnungsliste einer Organisation', () => {
  it('zeigt den abgeleiteten Zahlungsstand, nie die rohe Statusspalte', async () => {
    arrangeFetch(
      () =>
        new Response(JSON.stringify([invoice({})]), { status: 200 }),
    );
    show();

    expect(await screen.findByText('Überfällig')).toBeInTheDocument();
    // `status` ist „versendet" — das darf nirgends als Abzeichen auftauchen.
    expect(screen.queryByText('Versendet')).toBeNull();
  });

  it('formatiert Beträge deutsch und Daten als dd.mm.yyyy', async () => {
    arrangeFetch(
      () => new Response(JSON.stringify([invoice({})]), { status: 200 }),
    );
    show();

    const amount = await screen.findByText((text) =>
      text.replace(/ /g, ' ') === '583,10 €',
    );
    expect(amount).toBeInTheDocument();
    expect(screen.queryByText('583.10')).toBeNull();
    expect(screen.getByText('03.08.2026')).toBeInTheDocument();
    expect(screen.queryByText('2026-08-03')).toBeNull();
  });

  it('kennzeichnet eine Stornorechnung schon in der Liste', async () => {
    arrangeFetch(
      () =>
        new Response(
          JSON.stringify([
            invoice({ id: 'r2', invoiceNumber: '2026-018', isCancellation: true }),
          ]),
          { status: 200 },
        ),
    );
    show();

    expect(await screen.findByText('(Storno)')).toBeInTheDocument();
  });

  it('führt jede Zeile auf die Route, die auch die Dashboard-Aufgabe nennt', async () => {
    arrangeFetch(
      () => new Response(JSON.stringify([invoice({})]), { status: 200 }),
    );
    show();

    expect(await screen.findByRole('link')).toHaveAttribute(
      'href',
      `/companies/${COMPANY_ID}/invoices/r1`,
    );
  });

  it('bietet den Leerzustand an, ohne das Anlegen zu sperren', async () => {
    arrangeFetch(() => new Response('[]', { status: 200 }));
    show();

    expect(await screen.findByText('Noch keine Rechnungen')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Rechnung anlegen' }),
    ).toBeEnabled();
  });

  it('meldet einen Ladefehler sichtbar und bietet einen zweiten Versuch', async () => {
    let first = true;
    const called = arrangeFetch(() => {
      if (first) {
        first = false;
        return new Response(
          JSON.stringify({
            error: { code: 'HTTP_500', message: 'Serverfehler.' },
          }),
          { status: 500 },
        );
      }
      return new Response(JSON.stringify([invoice({})]), { status: 200 });
    });
    show();

    expect(await screen.findByRole('alert')).toHaveTextContent('Serverfehler.');
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByText('2026-014')).toBeInTheDocument();
    expect(called).toHaveBeenCalledTimes(2);
  });

  it('stirbt nicht an einer Antwort, die keine Liste ist', async () => {
    // Ohne Formprüfung risse hier ein `.map` auf `undefined` die ganze
    // Organisations-Detailseite mit — nicht nur diese Karte.
    arrangeFetch(() => new Response('{}', { status: 200 }));
    show();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'unerwarteten Form',
    );
  });
});
