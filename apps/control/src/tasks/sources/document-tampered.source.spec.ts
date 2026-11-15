import type { PrismaService } from '../../prisma/prisma.service';
import { PRICE_PRESETS } from '../../invoices/pricing.config';
import type { TasksContext } from '../tasks.types';
import {
  clearDocumentTamperedCache,
  documentTampered,
} from './document-tampered.source';

/**
 * Die Quelle „Beleg manipuliert" gegen eine Datenbank-Attrappe. Die echte
 * SQL-Berechnung der Pruefsummen prueft `gobd.integration.spec.ts`.
 */

const COMPANY = { id: 'c1', name: 'Muster GmbH', status: 'customer' };

function setup(findingRows: unknown[], numbers: string[]) {
  const queryRaw = jest.fn(async () => findingRows);
  const prisma = {
    $queryRaw: queryRaw,
    invoice: {
      findMany: jest.fn(async (args: { where: Record<string, unknown>; select: Record<string, unknown> }) =>
        'invoiceNumber' in args.where
          ? numbers.map((invoiceNumber) => ({ invoiceNumber }))
          : [{ id: 'inv-1', company: COMPANY }],
      ),
    },
  } as unknown as PrismaService;
  const context: TasksContext = {
    prisma,
    todayDay: '2026-09-01',
    now: new Date('2026-09-01T08:00:00Z'),
    since: '2026-08-25',
    limit: 25,
    priceTable: PRICE_PRESETS,
    outbox: [],
  };
  return { context, prisma, queryRaw };
}

describe('Aufgabenquelle document_tampered', () => {
  it('liefert nichts bei sauberem Bestand (kein gruener Haken)', async () => {
    const { context } = setup([], ['2026-001', '2026-002']);
    expect(await documentTampered.collect(context)).toEqual({ tasks: [], total: 0 });
  });

  it('meldet einen Beleg mit abweichender Pruefsumme, dringend, mit Organisation', async () => {
    const { context } = setup(
      [{ id: 'inv-1', invoiceNumber: '2026-001', pdf: 'mismatch', xml: 'ok', xrechnung: 'absent', total: 1 }],
      ['2026-001'],
    );
    const result = await documentTampered.collect(context);
    expect(result.total).toBe(1);
    const task = result.tasks[0];
    expect(task).toMatchObject({
      kind: 'document_tampered',
      urgency: 'high',
      dueAt: '2026-09-01',
      title: 'Beleg manipuliert',
      company: COMPANY,
      action: { kind: 'company_open', target: '/companies/c1' },
    });
    expect(task?.reason).toContain('2026-001');
    expect(task?.reason).toContain('PDF: Prüfsumme stimmt nicht');
    // Kein Inhalt, keine Hashes in der Aufgabe.
    expect(task?.reason).not.toMatch(/[0-9a-f]{64}/);
  });

  it('meldet eine Luecke im Nummernkreis', async () => {
    const { context } = setup([], ['2026-001', '2026-004']);
    const result = await documentTampered.collect(context);
    expect(result.total).toBe(1);
    expect(result.tasks[0]?.title).toBe('Lücke im Rechnungsnummernkreis');
    expect(result.tasks[0]?.reason).toContain('2026-002, 2026-003');
  });

  it('haelt das Ergebnis kurz vor und rechnet danach neu', async () => {
    const { context, queryRaw } = setup([], ['2026-001']);
    await documentTampered.collect(context);
    await documentTampered.collect(context);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    await documentTampered.collect({ ...context, now: new Date('2026-09-01T08:06:00Z') });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    clearDocumentTamperedCache(context.prisma);
    await documentTampered.collect(context);
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });
});
