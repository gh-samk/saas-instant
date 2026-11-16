import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithI18n } from '../test-support/render-with-i18n';
import { PaymentRecordDialog } from './PaymentRecordDialog';

const notePayment = vi.fn();
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  notePayment: (...a: unknown[]) => notePayment(...a),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ reload: vi.fn().mockResolvedValue(undefined), state: { totpSetUp: false } }),
}));

/** Beim Öffnen steht der Fokus in der ersten Eingabe, nicht auf „Schließen". */
describe('PaymentRecordDialog: Anfangsfokus', () => {
  it('fokussiert das Zahldatum statt des Schließen-Knopfs', async () => {
    renderWithI18n(
      <PaymentRecordDialog
        open
        invoice={
          {
            id: 'r1',
            invoiceNumber: 'R-1',
            sumGross: '100.00',
            openAmount: '100.00',
            paidAmount: null,
            sumGrossCent: 10000,
          } as never
        }
        totpPossible={false}
        onClose={vi.fn()}
        onNoted={vi.fn()}
      />,
    );
    const field = await screen.findByLabelText(/Zahlungsdatum|Zahldatum|Datum/i);
    expect(field).toHaveFocus();
  });
});

const PAID = {
  id: 'r1',
  invoiceNumber: 'R-1',
  sumGross: '583.10',
  openAmount: '0.00',
  paidAmount: '583.10',
  paymentDate: '2026-11-01',
  sumGrossCent: 58310,
} as never;

describe('PaymentRecordDialog: Zahlungsstand berichtigen [M13]', () => {
  beforeEach(() => notePayment.mockReset());

  function open(invoice: unknown, initialMode?: 'correct') {
    const onNoted = vi.fn();
    renderWithI18n(
      <PaymentRecordDialog
        open
        invoice={invoice as never}
        totpPossible={false}
        initialMode={initialMode}
        onClose={vi.fn()}
        onNoted={onNoted}
      />,
    );
    return onNoted;
  }

  it('bietet „berichtigen“ nur, wenn schon etwas erfasst ist', () => {
    open({ ...(PAID as object), paidAmount: null });
    expect(screen.queryByRole('radio', { name: /berichtigen/ })).toBeNull();
  });

  it('öffnet aus dem Menü direkt bei „berichtigen“, vorbelegt mit dem bisherigen Stand', () => {
    open(PAID, 'correct');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: /berichtigen/ })).toBeChecked();
    expect(within(dialog).getByLabelText('Neuer Gesamtstand (EUR)')).toHaveValue(583.1);
  });

  it('schickt den neuen Gesamtstand — auch 0 — samt erwartetem bisherigem Stand', async () => {
    notePayment.mockResolvedValue({ ...(PAID as object), paidAmount: null });
    const onNoted = open(PAID, 'correct');
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Neuer Gesamtstand (EUR)'), {
      target: { value: '0' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zahlung erfassen' }));
    await waitFor(() => expect(onNoted).toHaveBeenCalled());
    expect(notePayment).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ paidAmountCent: 0, expectedPaidCent: 58310 }),
      undefined,
    );
  });

  it('sendet bei einer normalen Zahlung den bisherigen Stand als erwarteten mit', async () => {
    notePayment.mockResolvedValue(PAID);
    open({ ...(PAID as object), paidAmount: '100.00', openAmount: '483.10' });
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Zahlung erfassen' }),
    );
    await waitFor(() => expect(notePayment).toHaveBeenCalled());
    expect(notePayment.mock.calls[0]?.[1]).toMatchObject({
      paidAmountCent: 58310,
      expectedPaidCent: 10000,
    });
  });
});
