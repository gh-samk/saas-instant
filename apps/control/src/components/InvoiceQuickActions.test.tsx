import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { ToastProvider } from '@saas-instant/ui';
import { TaskInvoiceActions } from './InvoiceQuickActions';
import type { Task } from '../lib/api';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ reload: vi.fn().mockResolvedValue(undefined), state: { totpSetUp: true } }),
}));

/**
 * Die Direktaktionen auf „Heute" laden die Rechnung erst beim Klick nach.
 * Der Knopf darf dabei nicht `disabled` werden: Ein deaktivierter Knopf
 * verliert den Fokus, und nach Escape landete er auf <body>.
 */
const TASK = {
  kind: 'invoice_overdue',
  dueAt: '2026-08-15',
  urgency: 'high',
  title: 'Rechnung überfällig',
  reason: '',
  action: { type: 'open' },
  invoiceId: 'r1',
} as unknown as Task;

const INVOICE = {
  id: 'r1',
  companyId: 'c1',
  companyName: 'Verein Beispielgarten',
  invoiceNumber: '2026-0151',
  status: 'finalized',
  paymentState: 'overdue',
  invoiceDate: '2026-08-01',
  servicePeriodFrom: '2026-08-01',
  servicePeriodUntil: '2026-08-31',
  dueDate: '2026-08-15',
  sumGrossCent: 48_000,
  sumGross: '480,00',
  openAmount: '480,00',
  paidAmount: null,
  recipientName: 'Verein Beispielgarten',
  recipientEmail: 'kasse@beispielgarten.example',
  sumNetCent: 48_000,
  sumTaxCent: 0,
  lines: [],
  documentPresent: false,
};

afterEach(() => vi.unstubAllGlobals());

describe('TaskInvoiceActions — Fokus', () => {
  it.each([
    ['Erinnerung', /Zahlungserinnerung|Erinnerung/],
    ['Zahlung', /Zahlung erfassen|Zahlung/],
  ])('gibt den Fokus nach Escape an den Knopf zurück (%s)', async (_name, label) => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = String(input);
        if (path.includes('/api/auth/csrf')) {
          return new Response(JSON.stringify({ csrfToken: 'abc' }), { status: 200 });
        }
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }),
    );
    render(
      <ToastProvider>
        <TaskInvoiceActions task={TASK} onChanged={vi.fn()} />
      </ToastProvider>,
    );
    const button = screen.getAllByRole('button').find((b) => label.test(b.textContent ?? ''))!;
    button.focus();
    fireEvent.click(button);

    // Beim Nachladen: beschäftigt, aber NICHT deaktiviert (sonst verliert er den Fokus).
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).not.toBeDisabled();
    expect(document.activeElement).toBe(button);

    release(new Response(JSON.stringify(INVOICE), { status: 200 }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });
});
