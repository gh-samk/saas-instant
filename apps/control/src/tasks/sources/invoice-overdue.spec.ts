import { Prisma } from '.prisma/control-client';
import { toDate } from '@saas-instant/shared';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TasksContext } from '../tasks.types';
import { invoiceOverdue } from './invoice-overdue.source';
import { PRICE_PRESETS } from '../../invoices/pricing.config';

/**
 * Die Quelle für überfällige Rechnungen.
 *
 * Sie ist absichtlich NOCH NICHT in `Sources` eingetragen — die Begründung
 * steht dort. Damit sie trotzdem nicht als ungeprüfter Code liegen bleibt,
 * wird sie hier unmittelbar aufgerufen.
 */

interface Call {
  where: Record<string, unknown>;
}

function contextWith(rows: unknown[]): {
  context: TasksContext;
  calls: Call[];
} {
  const calls: Call[] = [];
  const prisma = {
    invoice: {
      findMany: (args: Call) => {
        calls.push(args);
        return Promise.resolve(rows);
      },
      count: (args: Call) => {
        calls.push(args);
        return Promise.resolve(rows.length);
      },
    },
  } as unknown as PrismaService;

  return {
    calls,
    context: {
      prisma,
      todayDay: '2026-09-01',
      now: new Date('2026-09-01T08:00:00Z'),
      since: '2026-08-25',
      limit: 25,
      priceTable: PRICE_PRESETS,
      outbox: [],
    },
  };
}

const Row = {
  id: 'r1',
  invoiceNumber: '2026-001',
  dueDate: toDate('2026-08-14'),
  company: { id: 'o1', name: 'Kollektiv Grünspecht e. V.', status: 'paying' },
  lines: [{ grossAmount: new Prisma.Decimal('458.15') }],
  paidAmount: null,
};

describe('invoiceOverdue', () => {
  it('meldet eine überfällige Rechnung mit offenem Betrag', async () => {
    const { context } = contextWith([Row]);
    const result = await invoiceOverdue.collect(context);

    expect(result.total).toBe(1);
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0];
    expect(task?.kind).toBe('invoice_overdue');
    expect(task?.dueAt).toBe('2026-08-14');
    // Achtzehn Tage überfällig -> hoch.
    expect(task?.urgency).toBe('high');
    expect(task?.title).toContain('2026-001');
    expect(task?.reason).toContain('458,15 €');
    expect(task?.action.kind).toBe('payment_check');
    expect(task?.company?.id).toBe('o1');
  });

  it('zieht eine Teilzahlung vom offenen Betrag ab', async () => {
    const { context } = contextWith([
      { ...Row, paidAmount: new Prisma.Decimal('200.00') },
    ]);
    const result = await invoiceOverdue.collect(context);
    expect(result.tasks[0]?.reason).toContain('258,15 €');
  });

  /**
   * DIE ENTSCHEIDENDE ABGRENZUNG.
   *
   * Bezahlt, storniert und Entwurf dürfen nie in dieser Liste stehen: Eine
   * stornierte Rechnung ist aufgehoben, ein Entwurf war nie draußen. Geprüft
   * wird der FILTER, den die Quelle an die Datenbank schickt — die Abgrenzung
   * findet dort statt und nicht nachträglich im Speicher.
   */
  it('fragt nur nach Rechnungen, bei denen noch Geld erwartet wird', async () => {
    const { context, calls } = contextWith([]);
    await invoiceOverdue.collect(context);

    const where = calls[0]?.where as {
      status: { in: string[] };
      dueDate: { lt: Date };
    };
    expect([...where.status.in].sort()).toEqual([
      'finalized',
      'partially_paid',
      'sent',
    ]);
    expect(where.status.in).not.toContain('paid');
    expect(where.status.in).not.toContain('cancelled');
    expect(where.status.in).not.toContain('draft');
    // Nur was VOR heute fällig war.
    expect(where.dueDate.lt).toEqual(toDate('2026-09-01'));
  });

  it('schlägt nichts vor, was etwas auslösen würde (R4/R5)', async () => {
    const { context } = contextWith([Row]);
    const result = await invoiceOverdue.collect(context);
    // Die Handlung führt zur Rechnung. Sie mahnt nicht, sie ändert keinen
    // Status und sie verschickt nichts.
    expect(result.tasks[0]?.action.target).toMatch(
      /^\/companies\/o1\/invoices\/r1$/,
    );
    expect(result.tasks[0]?.action.label).toBe('Rechnung öffnen');
  });
});
