import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithI18n } from '../test-support/render-with-i18n';
import { PaymentRecordDialog } from './PaymentRecordDialog';

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
