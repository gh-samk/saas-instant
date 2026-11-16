import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@saas-instant/ui';
import { renderWithI18n } from '../test-support/render-with-i18n';
import { InvoiceView } from './InvoiceView';
import type { InvoiceWithRetention } from '../lib/api';
import * as api from '../lib/api';

/**
 * Der Bestätigungsdialog vor dem Versand: Ein Klick auf „Versenden" oder
 * „Zahlungserinnerung senden" schickt NICHTS, erst die Bestätigung im Dialog.
 */

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ reload: vi.fn(async () => undefined) }),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  return {
    ...original,
    sendInvoice: vi.fn(),
    sendPaymentReminder: vi.fn(),
    fetchInvoice: vi.fn(),
  };
});

const BASE = {
  id: 'r1',
  invoiceNumber: '2026-014',
  status: 'finalized',
  paymentState: 'overdue',
  invoiceDate: '2026-08-31',
  servicePeriodFrom: '2026-08-01',
  servicePeriodUntil: '2026-08-31',
  dueDate: '2026-09-14',
  finalizedAt: '2026-08-31T09:15:00.000Z',
  createdAt: '2026-08-31T08:00:00.000Z',
  paymentDate: null,
  paidAmount: null,
  recipientAddress: 'Hauptstraße 12\n79098 Freiburg',
  recipientName: 'Solawi Rheintal',
  recipientEmail: 'lena@example.com',
  sumGross: '583.10',
  openAmount: '200.00',
  cancellationInvoiceId: null,
  cancelledInvoiceId: null,
  lines: [],
} as unknown as InvoiceWithRetention;

function show(
  invoice: Partial<InvoiceWithRetention> = {},
  contactDataDeleted = false,
) {
  const onChanged = vi.fn();
  renderWithI18n(
    <MemoryRouter>
      <ToastProvider>
    <InvoiceView
      invoice={{ ...BASE, ...invoice }}
      companyId="c1"
      totpPossible
      contactDataDeleted={contactDataDeleted}
      onChanged={onChanged}
      onCancelled={vi.fn()}
    />
      </ToastProvider>
    </MemoryRouter>,
  );
  return onChanged;
}

describe('InvoiceView: Bestätigung vor dem Versand', () => {
  beforeEach(() => {
    vi.mocked(api.sendInvoice).mockResolvedValue(BASE as never);
    vi.mocked(api.sendPaymentReminder).mockResolvedValue(BASE as never);
  });
  afterEach(() => vi.clearAllMocks());

  it('Rechnung: Klick sendet nicht, Dialog zeigt Empfänger und Brutto, Abbrechen sendet nichts', async () => {
    show({ paymentState: 'open', status: 'finalized' });
    fireEvent.click(screen.getByRole('button', { name: /^Versenden$/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Rechnung versenden?')).toBeInTheDocument();
    expect(within(dialog).getByText('lena@example.com')).toBeInTheDocument();
    expect(within(dialog).getByText('Solawi Rheintal')).toBeInTheDocument();
    expect(within(dialog).getByText('2026-014')).toBeInTheDocument();
    expect(within(dialog).getByText(/583,10/)).toBeInTheDocument();
    expect(api.sendInvoice).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.sendInvoice).not.toHaveBeenCalled();
  });

  it('Rechnung: „Jetzt senden" sendet genau einmal', async () => {
    const onChanged = show({ paymentState: 'open' });
    fireEvent.click(screen.getByRole('button', { name: /^Versenden$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Jetzt senden' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.sendInvoice).toHaveBeenCalledTimes(1);
    expect(api.sendPaymentReminder).not.toHaveBeenCalled();
  });

  it('bereits versendete Rechnung: Titel „erneut versenden"', async () => {
    show({ paymentState: 'open', status: 'sent' });
    fireEvent.click(screen.getByRole('button', { name: /Erneut versenden/ }));
    expect(await screen.findByText('Rechnung erneut versenden?')).toBeInTheDocument();
  });

  it('Erinnerung: zeigt den offenen Betrag, sendet erst nach Bestätigung einmal', async () => {
    const onChanged = show();
    fireEvent.click(screen.getByRole('button', { name: /Zahlungserinnerung senden/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Zahlungserinnerung senden?')).toBeInTheDocument();
    expect(within(dialog).getByText(/200,00/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/583,10/)).toBeNull();
    expect(api.sendPaymentReminder).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Erinnerung senden' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.sendPaymentReminder).toHaveBeenCalledTimes(1);
  });

  it('Erinnerung: Abbrechen sendet nichts', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /Zahlungserinnerung senden/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.sendPaymentReminder).not.toHaveBeenCalled();
  });

  it('ohne E-Mail-Adresse: Hinweis, Senden-Knopf gesperrt', async () => {
    show({ recipientEmail: null, paymentState: 'open' });
    fireEvent.click(screen.getByRole('button', { name: /^Versenden$/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/keine E-Mail-Adresse/);
    expect(within(dialog).getByRole('button', { name: 'Jetzt senden' })).toBeDisabled();
    expect(api.sendInvoice).not.toHaveBeenCalled();
  });

  it('bei gelöschten Kontaktdaten erscheint nur der Warn-Dialog', async () => {
    show({ paymentState: 'open' }, true);
    fireEvent.click(screen.getByRole('button', { name: /^Versenden$/ }));

    const dialogs = await screen.findAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(within(dialogs[0]!).getByText('Kontaktdaten wurden gelöscht')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Jetzt senden' })).toBeNull();
    expect(api.sendInvoice).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Trotzdem senden' }));
    await waitFor(() => expect(api.sendInvoice).toHaveBeenCalledTimes(1));
  });
});
