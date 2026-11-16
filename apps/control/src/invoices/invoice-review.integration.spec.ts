import { ConfigService } from '@nestjs/config';
import { datePlusDays, today, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import {
  createCompany,
  newPrefix,
  prisma,
  cleanUp,
  disconnect,
} from '../test-support/company-provisioning';
import { IssuerConfigService } from './document/issuer.config';
import { PricingConfigService } from './pricing.config';
import { InvoiceService } from './invoice.service';
import { InvoiceIncompleteError, PaymentChangedMeanwhileError } from './invoice.errors';
import { PaymentService } from './payment.service';
import { LINE_ORDER } from './invoice.query';

/**
 * Die Befunde der Prüfung gegen eine echte Postgres-Datenbank:
 * M10 (Steuer), M11 (Reihenfolge), M13/M14 (Zahlung berichtigen, Status),
 * M16 (Fälligkeit), N8a, N8c, N8d, N8e.
 *
 * Die GoBD-Trigger sind scharf: jede Prüfung läuft gegen dieselben
 * Datenbankregeln wie im Betrieb.
 */

jest.setTimeout(120_000);

const PREFIX = newPrefix('pruefung-rechnung');
const SOURCE = { ip: '203.0.113.7', userAgent: 'Jest-Integration' };
const actor = { userId: null, name: 'sam' };

const audit = new AuditService(prisma);
const emptyEnvironment = { get: () => undefined } as unknown as ConfigService;
const prices = new PricingConfigService(emptyEnvironment);

const ISSUER_ENV: Record<string, string> = {
  CONTROL_INVOICE_ISSUER: 'Testhaus Software GmbH & Co. KG',
  CONTROL_INVOICE_STREET: 'Werkstattweg 7',
  CONTROL_INVOICE_POSTAL_CODE: '36037',
  CONTROL_INVOICE_CITY: 'Fulda',
  CONTROL_INVOICE_SEAT: 'Fulda',
  CONTROL_INVOICE_USTIDNR: 'DE811569869',
  CONTROL_INVOICE_COMMERCIAL_REGISTER_A: 'HRA 12345',
  CONTROL_INVOICE_REGISTER_COURT: 'Amtsgericht Fulda',
  CONTROL_INVOICE_GENERAL_PARTNER: 'Testhaus Verwaltungs GmbH',
  CONTROL_INVOICE_GENERAL_PARTNER_SEAT: 'Fulda',
  CONTROL_INVOICE_GENERAL_PARTNER_GERICHT: 'Amtsgericht Fulda',
  CONTROL_INVOICE_COMMERCIAL_REGISTER_B: 'HRB 54321',
  CONTROL_INVOICE_MANAGING_DIRECTOR: 'Erika Beispiel',
  CONTROL_INVOICE_CONTACT_NAME: 'Rechnungsstelle Testhaus',
  CONTROL_INVOICE_PHONE: '+49 661 000000',
  CONTROL_INVOICE_EMAIL: 'rechnung@testhaus.example.com',
  CONTROL_INVOICE_BANK: 'Testbank Fulda',
  CONTROL_INVOICE_IBAN: 'DE89370400440532013000',
  CONTROL_INVOICE_BIC: 'COBADEFFXXX',
};
const issuer = new IssuerConfigService({
  get: (name: string) => ISSUER_ENV[name],
} as unknown as ConfigService);

const wideWindow = {
  get: (name: string) =>
    name === 'CONTROL_INVOICE_DATE_RETROACTIVE_DAYS' ||
    name === 'CONTROL_INVOICE_DATE_AHEAD_DAYS'
      ? '40000'
      : undefined,
} as unknown as ConfigService;

const service = new InvoiceService(prisma, audit, prices, issuer, wideWindow);
const payments = new PaymentService(prisma, audit);

const YEAR = 2098;

type LineInput = {
  label: string;
  quantity: number;
  unitPriceNetCent: number;
  taxRate: number;
};
const line = (label: string, unitPriceNetCent = 38_500): LineInput => ({
  label,
  quantity: 1,
  unitPriceNetCent,
  taxRate: 19,
});

async function companyWithAddress(label: string, override = {}) {
  return createCompany(PREFIX, {
    street: 'Ziegelgasse',
    houseNumber: '14',
    postalCode: '99423',
    city: 'Weimar',
    country: 'Deutschland',
    contactEmail: `${label}@example.com`,
    ...override,
  });
}

async function draft(
  label: string,
  options: {
    invoiceDate?: string;
    lines?: LineInput[];
    dueDate?: string;
    company?: Record<string, unknown>;
  } = {},
) {
  const company = await companyWithAddress(label, options.company);
  const invoiceDate = options.invoiceDate ?? `${YEAR}-03-01`;
  const created = await service.draftCreate(
    company.id,
    {
      invoiceDate,
      servicePeriodFrom: invoiceDate,
      servicePeriodUntil: datePlusDays(invoiceDate, 364),
      ...(options.dueDate ? { dueDate: options.dueDate } : {}),
      lines: options.lines ?? [line('Jahresbeitrag')],
    },
    actor,
    SOURCE,
  );
  return { companyId: company.id, invoiceId: created.id };
}

/** Festgeschriebene Rechnung mit heutigem Rechnungsdatum minus zehn Tage (Zahlungen). */
async function finalizedRecently(label: string, lines?: LineInput[]) {
  const made = await draft(label, {
    invoiceDate: datePlusDays(today(), -10),
    ...(lines ? { lines } : {}),
  });
  await service.finalize(made.invoiceId, actor, SOURCE);
  return made;
}

afterAll(async () => {
  await cleanUp(PREFIX);
  await disconnect();
});

describe('[M10] Eine Rechenregel: Steuer je Satz aus der Nettosumme', () => {
  it('speichert 2 × 12,50 € zu 19 % als 29,75 € — Posten, Summe und Beleg stimmen überein', async () => {
    const { invoiceId } = await draft('steuer', {
      lines: [line('A', 1250), line('B', 1250)],
    });
    const invoice = await service.get(invoiceId);
    expect(invoice.sumNet).toBe('25.00');
    expect(invoice.sumTax).toBe('4.75');
    expect(invoice.sumGross).toBe('29.75');
    // Die Summe der gespeicherten Postensteuern (Grundlage von Beleg/XML und
    // Zahlungsabgleich) ist genau die Gruppensteuer.
    const stored = await prisma.invoiceLine.findMany({ where: { invoiceId } });
    const taxCent = stored.reduce((s, p) => s + Math.round(Number(p.taxAmount) * 100), 0);
    expect(taxCent).toBe(475);
  });
});

describe('[M11] Postenreihenfolge', () => {
  it('liefert die Posten in Eingabereihenfolge, nicht in Id-Reihenfolge', async () => {
    // Zufällige UUIDv4-Ids: bei zehn Rechnungen mit je fünf Posten ist eine
    // zufällig passende Id-Reihenfolge für ALLE praktisch ausgeschlossen.
    const labels = ['1 Grundgebühr', '2 Zusatzmodul', '3 Rabatt', '4 Einrichtung', '5 Sonstiges'];
    for (let i = 0; i < 10; i++) {
      const { invoiceId } = await draft(`reihe-${i}`, { lines: labels.map((l) => line(l)) });
      const invoice = await service.get(invoiceId);
      expect(invoice.lines.map((l) => l.label)).toEqual(labels);
      const stored = await prisma.invoiceLine.findMany({
        where: { invoiceId },
        orderBy: LINE_ORDER,
        select: { label: true, position: true },
      });
      expect(stored.map((l) => l.position)).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it('behält die Reihenfolge beim Ändern des Entwurfs und im Storno', async () => {
    const labels = ['Zeta', 'Alpha', 'Mitte'];
    const { invoiceId, companyId } = await draft('reihe-storno', {
      lines: labels.map((l) => line(l)),
    });
    const reordered = ['Mitte', 'Zeta', 'Alpha'];
    await service.draftUpdate(
      invoiceId,
      {
        invoiceDate: `${YEAR}-03-01`,
        servicePeriodFrom: `${YEAR}-03-01`,
        servicePeriodUntil: `${YEAR}-12-31`,
        lines: reordered.map((l) => line(l)),
      },
      actor,
      SOURCE,
    );
    await service.finalize(invoiceId, actor, SOURCE);
    const { cancellation } = await service.cancel(invoiceId, 'Tippfehler', actor, SOURCE);
    // Nicht alphabetisch (das war die alte Sortierung des Storno): Reihenfolge des Originals.
    expect(cancellation.lines.map((l) => l.label)).toEqual(reordered.map((l) => `Storno: ${l}`));
    expect(companyId).toBeTruthy();
  });

  it('sortiert Altposten ohne Position nach den Posten mit Position, dann nach Id', async () => {
    const { invoiceId } = await draft('reihe-alt', { lines: [line('neu-0'), line('neu-1')] });
    // Ein Altposten (ohne Position) am Entwurf: Drafts dürfen geändert werden.
    await prisma.invoiceLine.create({
      data: {
        invoiceId,
        label: 'alt',
        quantity: 1,
        unitPriceNet: 1,
        taxRate: 19,
        netAmount: 1,
        taxAmount: 0.19,
        grossAmount: 1.19,
      },
    });
    const invoice = await service.get(invoiceId);
    expect(invoice.lines.map((l) => l.label)).toEqual(['neu-0', 'neu-1', 'alt']);
  });

  it('lässt den GoBD-Trigger gegen eine nachträgliche Positionsänderung stehen', async () => {
    const { invoiceId } = await draft('reihe-trigger', { lines: [line('x'), line('y')] });
    await service.finalize(invoiceId, actor, SOURCE);
    await expect(
      prisma.invoiceLine.updateMany({ where: { invoiceId }, data: { position: 9 } }),
    ).rejects.toThrow(/GoBD|unveraenderlich/);
  });
});

describe('[M16] Fälligkeit folgt dem Rechnungsdatum', () => {
  it('weist eine Fälligkeit vor dem Rechnungsdatum ab', async () => {
    const company = await companyWithAddress('faellig-vor');
    await expect(
      service.draftCreate(
        company.id,
        {
          invoiceDate: `${YEAR}-03-10`,
          servicePeriodFrom: `${YEAR}-03-01`,
          servicePeriodUntil: `${YEAR}-03-31`,
          dueDate: `${YEAR}-03-09`,
          lines: [line('x')],
        },
        actor,
        SOURCE,
      ),
    ).rejects.toBeInstanceOf(InvoiceIncompleteError);
  });

  it('rechnet eine abgeleitete Fälligkeit beim Ändern des Rechnungsdatums neu', async () => {
    const { invoiceId } = await draft('faellig-wandert', { invoiceDate: `${YEAR}-03-01` });
    const before = await service.get(invoiceId);
    expect(before.dueDateManual).toBe(false);
    const moved = await service.draftUpdate(
      invoiceId,
      {
        invoiceDate: `${YEAR}-04-01`,
        servicePeriodFrom: `${YEAR}-04-01`,
        servicePeriodUntil: `${YEAR}-12-31`,
        lines: [line('x')],
      },
      actor,
      SOURCE,
    );
    expect(moved.dueDate).toBe(datePlusDays(`${YEAR}-04-01`, prices.read().paymentDueDays));
    expect(moved.dueDateManual).toBe(false);
  });

  it('behält eine von Hand gesetzte Fälligkeit', async () => {
    const { invoiceId } = await draft('faellig-hand', { dueDate: `${YEAR}-06-30` });
    const row = await service.get(invoiceId);
    expect(row.dueDate).toBe(`${YEAR}-06-30`);
    expect(row.dueDateManual).toBe(true);
    const fest = await service.finalize(invoiceId, actor, SOURCE);
    expect(fest.dueDate).toBe(`${YEAR}-06-30`);
  });

  it('bildet beim Festschreiben eine abgeleitete Fälligkeit aus dem Rechnungsdatum neu', async () => {
    const { invoiceId } = await draft('faellig-fest', { invoiceDate: `${YEAR}-03-01` });
    // Ein veralteter Stand (z. B. aus einem früheren Zahlungsziel): abgeleitet, aber falsch.
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { dueDate: toDate(`${YEAR}-03-02`) },
    });
    const fest = await service.finalize(invoiceId, actor, SOURCE);
    expect(fest.dueDate).toBe(datePlusDays(`${YEAR}-03-01`, prices.read().paymentDueDays));
  });

  it('weist beim Festschreiben eine nachträglich unzulässige Fälligkeit ab, ohne Nummer zu verbrauchen', async () => {
    const { invoiceId } = await draft('faellig-fest-hand', { dueDate: `${YEAR}-06-30` });
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { dueDate: toDate(`${YEAR}-02-01`) },
    });
    await expect(service.finalize(invoiceId, actor, SOURCE)).rejects.toBeInstanceOf(
      InvoiceIncompleteError,
    );
    const still = await service.get(invoiceId);
    expect(still.status).toBe('draft');
    expect(still.invoiceNumber).toBeNull();
  });
});

describe('[N8d] Festschreiben liest Zahlungsart und Mandat frisch', () => {
  it('übernimmt ein nach dem Entwurf eingetragenes Mandat', async () => {
    const { invoiceId, companyId } = await draft('mandat-neu');
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(before.paymentMeansCode).toBe('58');
    await prisma.company.update({
      where: { id: companyId },
      data: { paymentMethod: 'direct_debit', sepaMandateReference: 'MANDAT-2098-1' },
    });
    await service.finalize(invoiceId, actor, SOURCE);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(after.paymentMeansCode).toBe('59');
    expect(after.directDebitMandateReference).toBe('MANDAT-2098-1');
  });

  it('kündigt keinen Einzug an, wenn das Mandat nach dem Entwurf wegfiel', async () => {
    const { invoiceId, companyId } = await draft('mandat-weg', {
      company: { paymentMethod: 'direct_debit', sepaMandateReference: 'MANDAT-2098-2' },
    });
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(before.paymentMeansCode).toBe('59');
    await prisma.company.update({
      where: { id: companyId },
      data: { paymentMethod: 'bank_transfer', sepaMandateReference: null },
    });
    await service.finalize(invoiceId, actor, SOURCE);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(after.paymentMeansCode).toBe('58');
    expect(after.directDebitMandateReference).toBeNull();
  });
});

describe('[M14][M13] Zahlungsstand: Status behalten, Berichtigung', () => {
  it('lässt eine versendete Rechnung nach einer Teilzahlung `sent`', async () => {
    const { invoiceId } = await finalizedRecently('m14-teil');
    await service.sendNote(invoiceId);
    expect((await service.get(invoiceId)).status).toBe('sent');
    const part = await payments.note(invoiceId, today(), 20_000, actor, SOURCE, 0);
    expect(part.status).toBe('sent');
    expect(part.paymentState).toBe('open');
  });

  it('geht bei der Berichtigung einer `paid`-Rechnung auf `sent` zurück, wenn sie versendet wurde', async () => {
    const { invoiceId } = await finalizedRecently('m14-sent');
    await service.sendNote(invoiceId);
    await audit.log({
      userId: null,
      actor: 'sam',
      action: AUDIT_ACTION.invoiceSent,
      objectType: 'Invoice',
      objectId: invoiceId,
      ...SOURCE,
    });
    const paid = await payments.note(invoiceId, today(), 45_815, actor, SOURCE, 0);
    expect(paid.status).toBe('paid');
    const back = await payments.note(invoiceId, today(), 10_000, actor, SOURCE, 45_815);
    expect(back.status).toBe('sent');
    expect(back.paidAmount).toBe('100.00');
    const zero = await payments.note(invoiceId, today(), 0, actor, SOURCE, 10_000);
    expect(zero.status).toBe('sent');
    expect(zero.paidAmount).toBeNull();
  });

  it('geht bei der Berichtigung einer nie versendeten `paid`-Rechnung auf `finalized` zurück', async () => {
    const { invoiceId } = await finalizedRecently('m14-fin');
    await payments.note(invoiceId, today(), 45_815, actor, SOURCE, 0);
    const back = await payments.note(invoiceId, today(), 0, actor, SOURCE, 45_815);
    expect(back.status).toBe('finalized');
  });

  it('hält eine Berichtigung im Audit-Log fest', async () => {
    const { invoiceId } = await finalizedRecently('m13-audit');
    await payments.note(invoiceId, today(), 45_815, actor, SOURCE, 0);
    await payments.note(invoiceId, today(), 5_000, actor, SOURCE, 45_815);
    const rows = await prisma.auditLog.findMany({
      where: { objectId: invoiceId, action: AUDIT_ACTION.invoicePaymentNoted },
      orderBy: { timestamp: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]!.afterValue).toMatchObject({ paidAmountCent: 5_000, correction: true });
    expect(rows[1]!.beforeValue).toMatchObject({ paidAmountCent: 45_815 });
  });
});

describe('[N8e] Zahlungsstand: Schutz gegen verlorene Aktualisierung', () => {
  it('lehnt mit 409 ab, wenn der erwartete Stand nicht mehr stimmt', async () => {
    const { invoiceId } = await finalizedRecently('n8e');
    // Tab A und Tab B sehen beide „nichts erfasst".
    await payments.note(invoiceId, today(), 10_000, actor, SOURCE, 0);
    const error = await payments
      .note(invoiceId, today(), 20_000, actor, SOURCE, 0)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentChangedMeanwhileError);
    expect((error as { getStatus: () => number }).getStatus()).toBe(409);
    // Nichts wurde überschrieben.
    expect((await service.get(invoiceId)).paidAmount).toBe('100.00');
  });

  it('lässt von zwei gleichzeitigen Aufrufen genau einen durch', async () => {
    const { invoiceId } = await finalizedRecently('n8e-parallel');
    const results = await Promise.allSettled([
      payments.note(invoiceId, today(), 10_000, actor, SOURCE, 0),
      payments.note(invoiceId, today(), 20_000, actor, SOURCE, 0),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

describe('[N8a] Rechnung über 0 €', () => {
  it('gilt als bezahlt und wird nie überfällig', async () => {
    const made = await draft('null-euro', {
      invoiceDate: datePlusDays(today(), -60),
      lines: [line('Kulanz', 0)],
    });
    const fest = await service.finalize(made.invoiceId, actor, SOURCE);
    expect(fest.sumGrossCent).toBe(0);
    expect(fest.paymentState).toBe('paid');
  });
});

describe('[N8c] Übertragungsvermerk atomar mit dem Nachweis', () => {
  it('schreibt Vermerk und Audit-Eintrag zusammen', async () => {
    const { invoiceId } = await finalizedRecently('n8c-ok');
    const updated = await payments.noteTransfer(invoiceId, ' lexoffice 11/2098 ', actor, SOURCE);
    expect(updated.transferStatus).toBe('lexoffice 11/2098');
    const rows = await prisma.auditLog.findMany({
      where: { objectId: invoiceId, action: AUDIT_ACTION.invoiceTransferNoted },
    });
    expect(rows).toHaveLength(1);
  });

  it('lässt den Vermerk nicht stehen, wenn der Nachweis nicht geschrieben werden kann', async () => {
    const { invoiceId } = await finalizedRecently('n8c-fehler');
    const failing = {
      log: async () => {
        throw new Error('Audit nicht erreichbar');
      },
    } as unknown as AuditService;
    const broken = new PaymentService(prisma, failing);
    await expect(broken.noteTransfer(invoiceId, 'übertragen', actor, SOURCE)).rejects.toThrow(
      /Audit/,
    );
    expect((await service.get(invoiceId)).transferStatus).toBeNull();
  });
});
