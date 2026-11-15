import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { renderWithI18n as render } from '../test-support/render-with-i18n';
import { InvoiceIntegrity } from './InvoiceIntegrity';

expect.extend(matchers);

const fetchInvoiceIntegrity = vi.fn();
const fetchInvoiceHistory = vi.fn();
vi.mock('../lib/api', () => ({
  fetchInvoiceIntegrity: (...a: unknown[]) => fetchInvoiceIntegrity(...a),
  fetchInvoiceHistory: (...a: unknown[]) => fetchInvoiceHistory(...a),
}));

const OK = {
  invoiceId: 'r1',
  invoiceNumber: '2026-001',
  finalized: true,
  ok: true,
  checkedAt: '2026-11-15T09:30:00.000Z',
  checks: [{ check: 'pdf_sha256', ok: true, status: 'ok' }],
};

const HISTORY = [
  { at: '2026-11-01T08:00:00.000Z', actor: 'sam', action: 'invoice.draft.created' },
  { at: '2026-11-01T08:05:00.000Z', actor: 'sam', action: 'invoice.finalized' },
  { at: '2026-11-02T10:00:00.000Z', actor: 'sam', action: 'invoice.sent' },
  { at: '2026-11-03T10:00:00.000Z', actor: 'sam', action: 'invoice.document_downloaded', format: 'pdf' },
  { at: '2026-11-04T10:00:00.000Z', actor: 'sam', action: 'invoice.payment.noted' },
  { at: '2026-11-05T10:00:00.000Z', actor: 'sam', action: 'invoice.cancelled' },
];

describe('InvoiceIntegrity', () => {
  beforeEach(() => {
    fetchInvoiceIntegrity.mockReset();
    fetchInvoiceHistory.mockReset();
    fetchInvoiceHistory.mockResolvedValue(HISTORY);
  });

  it('zeigt „Integrität geprüft", Aufbewahrungsfrist und Verlauf', async () => {
    fetchInvoiceIntegrity.mockResolvedValue(OK);
    const { container } = render(
      <InvoiceIntegrity invoiceId="r1" finalized retentionUntil="2034-12-31" />,
    );
    expect(await screen.findByText('Integrität geprüft')).toBeInTheDocument();
    expect(screen.getByText('Aufzubewahren bis 31.12.2034')).toBeInTheDocument();
    for (const text of [
      'Erzeugt (Entwurf)',
      'Festgeschrieben',
      'Versendet',
      'Dokument abgerufen (PDF)',
      'Zahlung vermerkt (bezahlt)',
      'Storniert',
    ]) {
      expect(await screen.findByText(text)).toBeInTheDocument();
    }
    expect(await axe(container)).toHaveNoViolations();
  });

  it('meldet eine Abweichung mit Text und benennt die Prüfung', async () => {
    fetchInvoiceIntegrity.mockResolvedValue({
      ...OK,
      ok: false,
      checks: [{ check: 'pdf_sha256', ok: false, status: 'mismatch' }],
    });
    const { container } = render(
      <InvoiceIntegrity invoiceId="r1" finalized retentionUntil="2034-12-31" />,
    );
    expect(await screen.findByText('Abweichung festgestellt')).toBeInTheDocument();
    expect(screen.getByText('PDF-Prüfsumme: Abweichung')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('prüft einen Entwurf nicht', async () => {
    render(<InvoiceIntegrity invoiceId="r1" finalized={false} />);
    expect(await screen.findByText('Erzeugt (Entwurf)')).toBeInTheDocument();
    expect(fetchInvoiceIntegrity).not.toHaveBeenCalled();
    expect(
      screen.getByText('Aufbewahrungsfrist wird mit der Festschreibung festgelegt.'),
    ).toBeInTheDocument();
  });

  it('fällt bei Fehlern auf Hinweise zurück, ohne abzustürzen', async () => {
    fetchInvoiceIntegrity.mockRejectedValue(new Error('x'));
    fetchInvoiceHistory.mockRejectedValue(new Error('x'));
    render(<InvoiceIntegrity invoiceId="r1" finalized />);
    expect(
      await screen.findByText('Die Integritätsprüfung ist gerade nicht möglich.'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Der Verlauf konnte nicht geladen werden.'),
    ).toBeInTheDocument();
  });
});
