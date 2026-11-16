import { toDate } from '@saas-instant/shared';
import type { PrismaService } from '../../prisma/prisma.service';
import { PRICE_PRESETS } from '../../invoices/pricing.config';
import type { TasksContext } from '../tasks.types';
import { invoiceDue } from './invoice-due.source';

/**
 * Die Quelle „Rechnung fällig".
 *
 * Der Kern ist eine Kalenderrechnung mit einer Schwelle, und Schwellen sind
 * der Ort, an dem sich Fehler um genau eins verstecken. Geprüft wird deshalb
 * nicht nur „meldet sie?", sondern auch der Tag davor und der Tag danach.
 */

const Today = '2026-09-01';

function contextWith(rows: unknown[]): TasksContext {
  const prisma = {
    company: { findMany: () => Promise.resolve(rows) },
  } as unknown as PrismaService;

  return {
    prisma,
    todayDay: Today,
    now: new Date(`${Today}T08:00:00Z`),
    since: '2026-08-25',
    limit: 25,
    priceTable: PRICE_PRESETS,
    outbox: [],
  };
}

/** Instanzstart so, dass das Abo an `aboFrom` berechenbar wird. */
function company(fields: {
  aboFrom: string;
  paymentInterval: 'monthly' | 'half_yearly' | 'yearly';
  invoices?: {
    status: string;
    until: string;
    cancelledFrom?: string | null;
  }[];
}) {
  const start = new Date(`${fields.aboFrom}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - 90);
  return {
    id: 'o1',
    name: 'Kollektiv Grünspecht e. V.',
    status: 'paying',
    paymentInterval: fields.paymentInterval,
    instanceStartDate: start,
    invoices: (fields.invoices ?? []).map((r) => ({
      status: r.status,
      servicePeriodUntil: toDate(r.until),
      cancelledInvoiceId: r.cancelledFrom ?? null,
    })),
  };
}

describe('rechnungFaellig — der abgelaufene Zeitraum', () => {
  it('meldet nichts, solange der erste Monat noch läuft', async () => {
    // Abo ab 15.08., monatlich: der Zeitraum endet am 14.09. — heute ist der
    // 01.09.
    const { tasks, total } = await invoiceDue.collect(
      contextWith([company({ aboFrom: '2026-08-15', paymentInterval: 'monthly' })]),
    );
    expect(tasks).toEqual([]);
    expect(total).toBe(0);
  });

  it('meldet nichts am LETZTEN Tag des Zeitraums', async () => {
    // Abo ab 02.08., monatlich: Zeitraum 02.08.–01.09. Heute ist der 01.09.,
    // also der letzte Tag — noch nichts zu berechnen.
    const { tasks } = await invoiceDue.collect(
      contextWith([company({ aboFrom: '2026-08-02', paymentInterval: 'monthly' })]),
    );
    expect(tasks).toEqual([]);
  });

  it('meldet am Tag NACH Ablauf — und nennt den Zeitraum im Wortlaut', async () => {
    // Abo ab 01.08., monatlich: Zeitraum 01.08.–31.08., abgelaufen seit gestern.
    const { tasks } = await invoiceDue.collect(
      contextWith([company({ aboFrom: '2026-08-01', paymentInterval: 'monthly' })]),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].dueAt).toBe('2026-09-01');
    expect(tasks[0].reason).toContain('01.08.2026 bis 31.08.2026');
    expect(tasks[0].action.kind).toBe('invoice_create');
    expect(tasks[0].action.target).toBe('/companies/o1');
  });

  it('rechnet jährlich in Jahren, nicht in 365 Tagen', async () => {
    const { tasks } = await invoiceDue.collect(
      contextWith([
        company({ aboFrom: '2025-09-01', paymentInterval: 'yearly' }),
      ]),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].reason).toContain('01.09.2025 bis 31.08.2026');
  });
});

describe('rechnungFaellig — halbjährlich [H3]', () => {
  it('meldet einen halbjährlichen Zeitraum nach sechs Monaten, nicht erst nach zwölf', async () => {
    // Abo ab 01.02.2026, halbjährlich: Zeitraum 01.02.–31.07. Heute ist der
    // 01.09. — der Zeitraum ist abgelaufen. Mit „sonst zwölf" lief er bis
    // 31.01.2027 und die Aufgabe käme ein halbes Jahr zu spät.
    const { tasks } = await invoiceDue.collect(
      contextWith([company({ aboFrom: '2026-02-01', paymentInterval: 'half_yearly' })]),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.reason).toContain('01.02.2026');
    expect(tasks[0]?.reason).toContain('31.07.2026');
  });

  it('meldet am letzten Tag des halben Jahres noch nichts', async () => {
    // Zeitraum 02.03.–01.09.: heute (01.09.) ist der letzte Tag.
    const { tasks } = await invoiceDue.collect(
      contextWith([company({ aboFrom: '2026-03-02', paymentInterval: 'half_yearly' })]),
    );
    expect(tasks).toEqual([]);
  });
});

describe('rechnungFaellig — was als abgedeckt zählt', () => {
  it('schweigt, wenn eine festgeschriebene Rechnung den Zeitraum abdeckt', async () => {
    const { tasks } = await invoiceDue.collect(
      contextWith([
        company({
          aboFrom: '2026-08-01',
          paymentInterval: 'monthly',
          invoices: [{ status: 'finalized', until: '2026-08-31' }],
        }),
      ]),
    );
    expect(tasks).toEqual([]);
  });

  it('EIN ENTWURF DECKT NICHTS AB — er kann noch verworfen werden', async () => {
    const { tasks } = await invoiceDue.collect(
      contextWith([
        company({
          aboFrom: '2026-08-01',
          paymentInterval: 'monthly',
          invoices: [{ status: 'draft', until: '2026-08-31' }],
        }),
      ]),
    );
    expect(tasks).toHaveLength(1);
    // Der Entwurf wird aber genannt, sonst fragt man sich, warum die Zeile
    // trotz angefangener Arbeit stehen bleibt.
    expect(tasks[0].reason).toContain('Entwurf liegt bereits vor');
  });

  it('EINE STORNIERTE RECHNUNG DECKT NICHTS AB — sonst verschwände der Zeitraum mit dem Storno', async () => {
    const { tasks } = await invoiceDue.collect(
      contextWith([
        company({
          aboFrom: '2026-08-01',
          paymentInterval: 'monthly',
          invoices: [
            { status: 'cancelled', until: '2026-08-31' },
            // Der Stornobeleg selbst traegt denselben Zeitraum und ist
            // festgeschrieben — er darf nicht als Abdeckung durchgehen.
            { status: 'finalized', until: '2026-08-31', cancelledFrom: 'r1' },
          ],
        }),
      ]),
    );
    expect(tasks).toHaveLength(1);
  });

  it('setzt beim ÄLTESTEN offenen Zeitraum an, nicht beim jüngsten', async () => {
    // Abgedeckt bis 30.06.; offen sind Juli und August. Gemeldet wird Juli.
    const { tasks } = await invoiceDue.collect(
      contextWith([
        company({
          aboFrom: '2026-06-01',
          paymentInterval: 'monthly',
          invoices: [
            { status: 'paid', until: '2026-05-31' },
            { status: 'paid', until: '2026-06-30' },
          ],
        }),
      ]),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].reason).toContain('01.07.2026 bis 31.07.2026');
  });
});

describe('rechnungFaellig — wen sie gar nicht erst betrachtet', () => {
  it('fragt nur nach zahlenden Organisationen MIT Preisvereinbarung', async () => {
    let seen: Record<string, unknown> | undefined;
    const prisma = {
      company: {
        findMany: (args: { where: Record<string, unknown> }) => {
          seen = args.where;
          return Promise.resolve([]);
        },
      },
    } as unknown as PrismaService;

    await invoiceDue.collect({ ...contextWith([]), prisma });

    expect(seen).toMatchObject({
      status: 'paying',
      paymentInterval: { not: null },
      instanceStartDate: { not: null },
    });
    // Ohne Preisvereinbarung greift `preisangabe_fehlt`. Zwei Aufgaben fuer
    // dieselbe Luecke waeren zwei Zeilen fuer eine Handlung.
    expect(seen?.OR).toEqual([
      { priceTier: { not: null } },
      { customAmount: { not: null } },
    ]);
  });

  it('legt nichts an — die Quelle kennt keinen Schreibvorgang', async () => {
    const written: string[] = [];
    const prisma = new Proxy(
      { company: { findMany: () => Promise.resolve([]) } },
      {
        get(target: Record<string, unknown>, name: string) {
          if (name === 'company') return target['company'];
          written.push(name);
          return {};
        },
      },
    ) as unknown as PrismaService;

    await invoiceDue.collect({ ...contextWith([]), prisma });
    expect(written).toEqual([]);
  });
});
