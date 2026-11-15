import { AUDIT_ACTION } from '../audit/audit.service';
import { InvoiceNotFoundError } from './invoice.errors';
import { HISTORY_ACTIONS, InvoiceHistoryService } from './invoice-history.service';

function build(rows: unknown[], exists = true) {
  const findMany = jest.fn(async () => rows);
  const prisma = {
    invoice: { findUnique: jest.fn(async () => (exists ? { id: 'i1' } : null)) },
    auditLog: { findMany },
  };
  return { service: new InvoiceHistoryService(prisma as never), findMany };
}

describe('Verlauf einer Rechnung', () => {
  it('gibt nur Benutzer, UTC-Zeit, Aktion und Format zurueck — chronologisch', async () => {
    const { service, findMany } = build([
      // Die Abfrage liefert neueste zuerst; die Antwort dreht um.
      {
        timestamp: new Date('2026-03-03T10:00:00Z'),
        actor: 'sam',
        action: AUDIT_ACTION.invoiceDocumentDownloaded,
        afterValue: { format: 'pdf', sha256: 'x', sizeBytes: 3 },
        ip: '203.0.113.1',
      },
      {
        timestamp: new Date('2026-03-02T10:00:00Z'),
        actor: 'sam',
        action: AUDIT_ACTION.invoiceFinalized,
        afterValue: { invoiceNumber: '2026-001', companyId: 'c' },
      },
    ]);
    const history = await service.history('i1');
    expect(history).toEqual([
      { at: '2026-03-02T10:00:00.000Z', actor: 'sam', action: 'invoice.finalized' },
      {
        at: '2026-03-03T10:00:00.000Z',
        actor: 'sam',
        action: 'invoice.document_downloaded',
        format: 'pdf',
      },
    ]);
    const args = (findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; select: Record<string, boolean> }])[0];
    expect(args.where).toMatchObject({ objectType: 'Invoice', objectId: 'i1' });
    // Keine IP und kein Browserkennzeichen werden ueberhaupt gelesen.
    expect(Object.keys(args.select)).not.toContain('ip');
    expect(Object.keys(args.select)).not.toContain('userAgent');
  });

  it('deckt erzeugt, festgeschrieben, versendet, abgerufen, storniert und Zahlung ab', () => {
    for (const action of [
      AUDIT_ACTION.invoiceDraftCreated,
      AUDIT_ACTION.invoiceFinalized,
      AUDIT_ACTION.invoiceSent,
      AUDIT_ACTION.invoiceDocumentDownloaded,
      AUDIT_ACTION.invoiceCancelled,
      AUDIT_ACTION.invoicePaymentNoted,
    ]) {
      expect(HISTORY_ACTIONS).toContain(action);
    }
  });

  it('wirft fuer eine unbekannte Rechnung', async () => {
    const { service } = build([], false);
    await expect(service.history('nope')).rejects.toBeInstanceOf(InvoiceNotFoundError);
  });
});
