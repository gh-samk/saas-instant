import 'reflect-metadata';
import { Prisma } from '.prisma/control-client';
import { InvoiceService, retentionEnd, yearInBerlin } from './invoice.service';
import { InvoiceSendService } from './send.service';
import { paymentStateFrom } from './invoice.response';
import { ReminderNotApplicableError } from './invoice.errors';

/**
 * Befunde der Prüfung (H2, N8a, N8b, M15) — ohne Datenbank.
 */

const D = (s: string) => new Prisma.Decimal(s);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('[H2] Stornorechnungen sind nie überfällig', () => {
  const storno = (due: string) => ({
    status: 'finalized' as const,
    dueDate: day(due),
    paidAmount: null,
    cancelledInvoiceId: 'original-1',
  });

  it('bleibt am Folgetag der Ausstellung ohne Mahnstatus', () => {
    // Fälligkeit = Ausstellungstag; am Folgetag war sie bisher „überfällig".
    expect(paymentStateFrom(storno('2026-11-16'), -11_900, '2026-11-16')).toBe('cancelled');
    expect(paymentStateFrom(storno('2026-11-16'), -11_900, '2026-11-17')).toBe('cancelled');
    expect(paymentStateFrom(storno('2026-01-01'), -11_900, '2026-11-17')).toBe('cancelled');
  });

  it('bleibt auch mit vermerkter Erstattung im selben Zustand wie das Original', () => {
    const refunded = { ...storno('2026-11-16'), status: 'paid' as const, paidAmount: D('-119.00') };
    expect(paymentStateFrom(refunded, -11_900, '2026-11-17')).toBe('cancelled');
    expect(
      paymentStateFrom(
        { status: 'cancelled', dueDate: day('2026-10-01'), paidAmount: D('119.00') },
        11_900,
        '2026-11-17',
      ),
    ).toBe('cancelled');
  });

  it('macht auch eine Gutschrift ohne Storno-Verweis nie überfällig', () => {
    const credit = { status: 'finalized' as const, dueDate: day('2026-01-01'), paidAmount: null };
    expect(paymentStateFrom(credit, -5_000, '2026-11-17')).toBe('open');
  });
});

describe('[N8a] Eine Rechnung über 0 € ist ausgeglichen, nie überfällig', () => {
  it('meldet 0 € als bezahlt, auch lange nach der Fälligkeit', () => {
    expect(
      paymentStateFrom(
        { status: 'finalized', dueDate: day('2026-01-01'), paidAmount: null },
        0,
        '2026-11-17',
      ),
    ).toBe('paid');
  });

  it('lässt einen positiven Betrag unverändert überfällig werden', () => {
    expect(
      paymentStateFrom(
        { status: 'finalized', dueDate: day('2026-01-01'), paidAmount: null },
        100,
        '2026-11-17',
      ),
    ).toBe('overdue');
  });
});

describe('[H2] Kennzahlen: Original und Storno fallen symmetrisch heraus', () => {
  async function metrics(rows: unknown[]) {
    const service = new InvoiceService(
      { invoice: { findMany: async () => rows } } as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    return service.metrics(new Date().getFullYear());
  }
  const year = new Date().getFullYear();
  const row = (o: Record<string, unknown>) => ({
    invoiceDate: day(`${year}-02-01`),
    dueDate: day(`${year}-02-15`),
    paidAmount: null,
    cancelledInvoiceId: null,
    ...o,
  });

  it('lässt „Bezahlter Umsatz" nicht negativ werden (Original bezahlt, Erstattung am Storno)', async () => {
    const m = await metrics([
      row({ status: 'cancelled', paidAmount: D('119.00'), lines: [{ grossAmount: D('119.00') }] }),
      row({
        status: 'paid',
        paidAmount: D('-119.00'),
        cancelledInvoiceId: 'x',
        lines: [{ grossAmount: D('-119.00') }],
      }),
    ]);
    expect(m.paidCent).toBe(0);
    expect(m.openCent + m.overdueCent).toBe(0);
  });

  it('zählt ein unbezahltes Storno-Paar weder als offen noch als überfällig', async () => {
    const m = await metrics([
      row({ status: 'cancelled', lines: [{ grossAmount: D('119.00') }] }),
      row({ status: 'finalized', cancelledInvoiceId: 'x', lines: [{ grossAmount: D('-119.00') }] }),
      row({ status: 'sent', lines: [{ grossAmount: D('500.00') }] }),
    ]);
    expect(m.overdueCount).toBe(1);
    expect(m.overdueCent).toBe(50_000);
    expect(m.openCount).toBe(0);
    expect(m.paidCent).toBe(0);
  });

  it('zählt eine 0-€-Rechnung nicht als überfällig', async () => {
    const m = await metrics([row({ status: 'finalized', lines: [{ grossAmount: D('0.00') }] })]);
    expect(m.overdueCount).toBe(0);
    expect(m.openCount).toBe(0);
  });
});

describe('[N8b] Aufbewahrungsfrist nach dem Jahr in Europe/Berlin', () => {
  it('nimmt die Silvesternacht in deutscher Zeit, nicht in UTC', () => {
    // 31.12. 23:30 UTC ist in Berlin schon der 1.1. des Folgejahres.
    expect(yearInBerlin(new Date('2026-12-31T23:30:00Z'))).toBe(2027);
    expect(retentionEnd(new Date('2026-12-31T23:30:00Z'), 8).toISOString().slice(0, 10)).toBe(
      '2035-12-31',
    );
    // 31.12. 22:30 UTC = 23:30 Berlin: noch 2026.
    expect(retentionEnd(new Date('2026-12-31T22:30:00Z'), 8).toISOString().slice(0, 10)).toBe(
      '2034-12-31',
    );
  });

  it('bleibt im Sommer und Winter bei gewöhnlichen Tagen unverändert', () => {
    expect(retentionEnd(new Date('2026-05-04T10:00:00Z'), 8).toISOString().slice(0, 10)).toBe(
      '2034-12-31',
    );
    expect(retentionEnd(new Date('2027-01-01T00:10:00Z'), 8).toISOString().slice(0, 10)).toBe(
      '2035-12-31',
    );
  });
});

describe('[M15][H2] Zahlungserinnerung', () => {
  interface Row {
    status: string;
    cancelledInvoiceId: string | null;
    dueDate: Date;
    paid: string | null;
    gross: string;
  }

  function build(row: Row) {
    const mails: { subject: string; text: string }[] = [];
    const prisma = {
      invoice: {
        findUnique: async () => ({
          companyId: 'c1',
          invoiceNumber: '2026-001',
          status: row.status,
          recipientEmail: 'kunde@example.com',
          recipientName: 'Kunde e. V.',
          issuerCompanyName: 'Testhaus',
          issuerBankDetails: null,
          dueDate: row.dueDate,
          paidAmount: row.paid === null ? null : D(row.paid),
          cancelledInvoiceId: row.cancelledInvoiceId,
          lines: [{ grossAmount: D(row.gross) }],
        }),
      },
      mailDelivery: { create: async () => ({}) },
    };
    const mail = {
      sendPaymentReminder: async (_to: string, subject: string, text: string) => {
        mails.push({ subject, text });
      },
    };
    const documents = {
      getOrCreate: async () => ({ filename: 'x.pdf', pdf: Buffer.from('x') }),
    };
    const audit = { log: async () => undefined };
    // Rechnungsabfrage `getInvoice` am Ende: nicht Teil dieser Prüfung.
    const service = new InvoiceSendService(
      prisma as never,
      audit as never,
      mail as never,
      documents as never,
      {} as never,
    );
    return { service, mails };
  }

  const actor = { userId: null, name: 'sam' };
  const SOURCE = { ip: null, userAgent: null };

  it('lehnt eine Stornorechnung ab', async () => {
    const { service, mails } = build({
      status: 'finalized',
      cancelledInvoiceId: 'o1',
      dueDate: day('2020-01-01'),
      paid: null,
      gross: '-119.00',
    });
    await expect(service.remind('i1', actor, SOURCE)).rejects.toBeInstanceOf(
      ReminderNotApplicableError,
    );
    expect(mails).toEqual([]);
  });

  it('lehnt Summen ≤ 0 und eine vollständig bezahlte Rechnung ab', async () => {
    for (const gross of ['0.00', '-5.00']) {
      const { service } = build({
        status: 'finalized',
        cancelledInvoiceId: null,
        dueDate: day('2020-01-01'),
        paid: null,
        gross,
      });
      await expect(service.remind('i1', actor, SOURCE)).rejects.toBeInstanceOf(
        ReminderNotApplicableError,
      );
    }
    const { service } = build({
      status: 'finalized',
      cancelledInvoiceId: null,
      dueDate: day('2020-01-01'),
      paid: '119.00',
      gross: '119.00',
    });
    await expect(service.remind('i1', actor, SOURCE)).rejects.toBeInstanceOf(
      ReminderNotApplicableError,
    );
  });

  it('lehnt ab, solange die Rechnung noch nicht fällig ist (auch am Fälligkeitstag)', async () => {
    const todayText = new Date().toLocaleDateString('sv-SE');
    for (const due of ['2999-01-01', todayText]) {
      const { service, mails } = build({
        status: 'sent',
        cancelledInvoiceId: null,
        dueDate: day(due),
        paid: null,
        gross: '119.00',
      });
      await expect(service.remind('i1', actor, SOURCE)).rejects.toThrow(/fällig/);
      expect(mails).toEqual([]);
    }
  });

  it('nennt im Mailtext Rechnungsbetrag, bereits Gezahltes und den offenen Rest', () => {
    const { service } = build({
      status: 'sent',
      cancelledInvoiceId: null,
      dueDate: day('2020-01-01'),
      paid: null,
      gross: '1.00',
    });
    const text = service.reminderText({
      recipientName: 'Kunde',
      invoiceNumber: '2026-001',
      sumGrossCent: 11_900,
      paidCent: 5_000,
      dueDate: '2026-10-01',
      issuerCompanyName: 'Testhaus',
    });
    expect(text).toContain('Rechnungsbetrag: 119,00 €');
    expect(text).toContain('Bereits gezahlt: 50,00 €');
    expect(text).toContain('Noch offen: 69,00 €');
    // Der volle Betrag steht nicht als „offener" Betrag da.
    expect(text).not.toContain('Offener Betrag: 119,00 €');
  });

  it('nennt ohne Teilzahlung nur den offenen Betrag', () => {
    const { service } = build({
      status: 'sent',
      cancelledInvoiceId: null,
      dueDate: day('2020-01-01'),
      paid: null,
      gross: '1.00',
    });
    const text = service.reminderText({
      recipientName: 'Kunde',
      invoiceNumber: '2026-001',
      sumGrossCent: 11_900,
      paidCent: 0,
      dueDate: '2026-10-01',
      issuerCompanyName: 'Testhaus',
    });
    expect(text).toContain('Offener Betrag: 119,00 €');
    expect(text).not.toContain('Bereits gezahlt');
  });
});

describe('[M12][N8e] DTOs kennen Nachweis und erwarteten Stand', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { plainToInstance } = require('class-transformer') as typeof import('class-transformer');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { validateSync } = require('class-validator') as typeof import('class-validator');
  const options = { whitelist: true, forbidNonWhitelisted: true };

  it('TransferDto nimmt currentPassword und totpCode an (sonst 400 am Guard vorbei)', async () => {
    const { TransferDto } = await import('./dto/invoice.dto');
    expect(
      validateSync(
        plainToInstance(TransferDto, { transferStatus: 'an DATEV', currentPassword: 'x', totpCode: '1' }),
        options,
      ),
    ).toEqual([]);
  });

  it('PaymentDto verlangt den erwarteten bisherigen Stand in ganzen Cent', async () => {
    const { PaymentDto } = await import('./dto/invoice.dto');
    const base = { paymentDate: '2026-11-16', paidAmountCent: 100 };
    expect(
      validateSync(plainToInstance(PaymentDto, { ...base, expectedPaidCent: 0 }), options),
    ).toEqual([]);
    expect(validateSync(plainToInstance(PaymentDto, base), options).length).toBeGreaterThan(0);
    expect(
      validateSync(plainToInstance(PaymentDto, { ...base, expectedPaidCent: 1.5 }), options).length,
    ).toBeGreaterThan(0);
  });
});
