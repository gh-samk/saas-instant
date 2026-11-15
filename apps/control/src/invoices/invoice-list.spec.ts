import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Prisma } from '.prisma/control-client';
import { InvoiceController } from './invoice.controller';
import { paymentStateFrom } from './invoice.response';

/**
 * Die globale Rechnungsliste — und die zwei Stellen, an denen sie leise
 * kaputtgehen kann.
 */

describe('Routenreihenfolge', () => {
  /**
   * NEST PRÜFT ROUTEN IN DER REIHENFOLGE IHRER DEKLARATION.
   *
   * `rechnungen/:id` fängt jeden Pfad ab, der danach kommt — auch
   * `invoices/metrics`. Der Server suchte dann eine Rechnung mit der
   * Kennung „kennzahlen" und antwortete mit 404. Das fällt in keinem
   * Unit-Test auf, der die Methode direkt ruft, und im Browser sieht es aus
   * wie ein Datenproblem.
   */
  it('stellt die festen Pfade VOR den Platzhalter', () => {
    const prototype = InvoiceController.prototype as unknown as Record<
      string,
      object
    >;
    const paths = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => ({
        name,
        path: Reflect.getMetadata(PATH_METADATA, prototype[name]) as
          | string
          | undefined,
      }))
      .filter((e): e is { name: string; path: string } => e.path !== undefined);

    const position = (path: string) => paths.findIndex((e) => e.path === path);

    expect(position('invoices/metrics')).toBeGreaterThanOrEqual(0);
    expect(position('invoices/:id')).toBeGreaterThanOrEqual(0);
    expect(position('invoices/metrics')).toBeLessThan(
      position('invoices/:id'),
    );
  });
});

describe('Zahlungsstand — teilweise bezahlt gibt es nicht mehr', () => {
  function invoice(paidCent: number | null, due: string) {
    return {
      status: 'finalized' as const,
      dueDate: new Date(`${due}T00:00:00.000Z`),
      paidAmount:
        paidCent === null
          ? null
          : new Prisma.Decimal((paidCent / 100).toFixed(2)),
    };
  }

  /**
   * Entscheidung des Auftraggebers beim Durchgang zum Redesign, wörtlich:
   * „Ich muss Zahlungen ja manuell erfassen — es wird kein echtes Konto
   * gegengeprüft. Daher gibt es nur Offen oder Gezahlt."
   */
  it('LÄSST ONE TEILZAHLUNG OFFEN, statt einen dritten Zustand zu erfinden', () => {
    expect(
      paymentStateFrom(invoice(30_000, '2026-12-01'), 48_000, '2026-09-01'),
    ).toBe('open');
  });

  it('bleibt bei einer Teilzahlung überfällig, wenn die Frist um ist', () => {
    expect(
      paymentStateFrom(invoice(30_000, '2026-08-01'), 48_000, '2026-09-01'),
    ).toBe('overdue');
  });

  it('springt erst auf bezahlt, wenn die Summe erreicht ist', () => {
    expect(
      paymentStateFrom(invoice(48_000, '2026-12-01'), 48_000, '2026-09-01'),
    ).toBe('paid');
  });

  it('erzeugt „teilweise_bezahlt" unter keiner Konstellation', () => {
    // Die Gegenprobe zur Entscheidung: Wer die Ableitung später wieder
    // aufweicht, macht diesen Test rot.
    const cases = [
      [0, '2026-12-01'],
      [1, '2026-12-01'],
      [47_999, '2026-12-01'],
      [47_999, '2026-01-01'],
      [48_000, '2026-01-01'],
    ] as const;
    for (const [paid, due] of cases) {
      expect(
        paymentStateFrom(invoice(paid, due), 48_000, '2026-09-01'),
      ).not.toBe('partially_paid');
    }
  });
});

describe('Kennzahlen — offen und ueberfaellig ueberschneiden sich nicht', () => {
  /**
   * Naheliegend waere, „offen" als „alles noch nicht Bezahlte" zu lesen —
   * dann enthielte es das Ueberfaellige. Daneben steht aber der Chip „Offen"
   * mit dem STRENGEN Wert, und die Kachel sagte „1 Rechnung", waehrend der
   * Chip „0" zeigt. Genau so stand es beim ersten Blick auf die fertige
   * Seite.
   */
  it('zaehlt eine ueberfaellige Rechnung NICHT auch als offen', async () => {
    const lines = [{ grossAmount: new Prisma.Decimal('480.00') }];
    const rows = [
      // offen: faellig in der Zukunft
      {
        status: 'finalized' as const,
        invoiceDate: new Date('2026-08-01T00:00:00.000Z'),
        dueDate: new Date('2026-12-01T00:00:00.000Z'),
        paidAmount: null,
        lines,
      },
      // ueberfaellig: faellig in der Vergangenheit
      {
        status: 'finalized' as const,
        invoiceDate: new Date('2026-07-01T00:00:00.000Z'),
        dueDate: new Date('2026-07-15T00:00:00.000Z'),
        paidAmount: null,
        lines,
      },
    ];

    const renderer = {
      prisma: { invoice: { findMany: async () => rows } },
    } as unknown as { prisma: { invoice: { findMany: () => Promise<unknown> } } };

    const { InvoiceService } = await import('./invoice.service');
    const metrics = await (
      InvoiceService.prototype.metrics as (
        this: unknown,
        year?: number,
      ) => Promise<{
        openCount: number;
        openCent: number;
        overdueCount: number;
        overdueCent: number;
      }>
    ).call(renderer, 2026);

    expect(metrics.openCount).toBe(1);
    expect(metrics.openCent).toBe(48_000);
    expect(metrics.overdueCount).toBe(1);
    expect(metrics.overdueCent).toBe(48_000);
  });
});
