import { ConfigService } from '@nestjs/config';
import type { Prisma } from '.prisma/control-client';
import { datePlusDays, today, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { CompanyService } from '../companies/company.service';
import {
  createCompany,
  newPrefix,
  prisma,
  cleanUp,
  disconnect,
  sendDouble,
} from '../test-support/company-provisioning';
import { IssuerConfigService } from './document/issuer.config';
import { formatNumber, splitNumber } from './number-sequence';
import { PricingConfigService } from './pricing.config';
import { InvoiceService } from './invoice.service';
import {
  InvoiceAlreadyCancelledError,
  InvoiceIsFinalizedError,
  InvoiceIncompleteError,
  CancellationNotCancellableError,
} from './invoice.errors';
import { InvoiceDocumentService } from './document.service';
import type { InvoiceRenderer } from './document/invoice-renderer.client';
import { PaymentService } from './payment.service';

/**
 * DAS RECHNUNGSMODUL GEGEN EINE ECHTE POSTGRES-DATENBANK.
 *
 * Der Kern ist der Nummernkreis unter Nebenläufigkeit. Mit einer
 * In-Memory-Attrappe wäre er nicht zu führen: JavaScript ist einfädig, ein
 * Rennen kann dort gar nicht entstehen. Genau darauf beruht die
 * Aufwandsschätzung des Erkundungsschritts — „der lückenlose Nummernkreis
 * braucht eine DB-Sperre, sonst Lücke oder Doppelnummer".
 *
 * Der entscheidende Test misst deshalb GEGEN DIE KAPUTTE FASSUNG: Die naive
 * Nummernvergabe (`max + 1` ohne Sperre) steht unten in dieser Datei und wird
 * ausdrücklich mitgeprüft. Fiele der Test nur gegen die richtige Fassung,
 * bewiese er nichts.
 *
 * Voraussetzung:
 *   docker compose --profile control up -d control-db
 *   pnpm --filter @saas-instant/control test:integration
 */

jest.setTimeout(120_000);

const PREFIX = newPrefix('etappe4-rechnung');
const SOURCE = { ip: '203.0.113.7', userAgent: 'Jest-Integration' };
const actor = { userId: null, name: 'sam' };

const audit = new AuditService(prisma);
const emptyEnvironment = { get: () => undefined } as unknown as ConfigService;
const prices = new PricingConfigService(emptyEnvironment);
const issuer = new IssuerConfigService(emptyEnvironment);

/**
 * [W1]: Diese Suite rechnet ABSICHTLICH in einem Jahr weit in der Zukunft
 * (siehe `JAHR` unten) — nur so lässt sich der global je Jahr laufende
 * Nummernkreis von anderen Suiten isolieren.
 *
 * Damit läuft sie aus dem Plausibilitätsfenster heraus, das [W1] eingeführt
 * hat. Sie macht es deshalb AUSDRÜCKLICH weit auf. Das ist keine Umgehung der
 * Regel, sondern genau der vorgesehene Weg: Das Fenster steht in der Umgebung,
 * weil es eine betriebliche Entscheidung ist. Dass die REGEL greift, prüft
 * `invoice-date-window.spec.ts` gegen die Vorgabewerte, und die
 * Wirksamkeit beim Festschreiben prüft diese Suite weiter unten mit einem
 * eigenen Dienst.
 */
const wideWindow = {
  get: (name: string) =>
    name === 'CONTROL_INVOICE_DATE_RETROACTIVE_DAYS' ||
    name === 'CONTROL_INVOICE_DATE_AHEAD_DAYS'
      ? '40000'
      : undefined,
} as unknown as ConfigService;

const service = new InvoiceService(
  prisma,
  audit,
  prices,
  issuer,
  wideWindow,
);

/** Derselbe Dienst mit dem VORGABE-Fenster — für die [W1]-Prüfungen. */
const serviceWithWindow = new InvoiceService(
  prisma,
  audit,
  prices,
  issuer,
  emptyEnvironment,
);
const payments = new PaymentService(prisma, audit);
const companies = new CompanyService(prisma, audit, sendDouble());

/**
 * DAS JAHR DIESER SUITE.
 *
 * Die Suiten teilen sich eine Datenbank, und der Nummernkreis ist pro Jahr
 * global — zwei Suiten im selben Jahr zählten gegeneinander. Deshalb rechnet
 * diese Suite in einem Jahr weit in der Zukunft, das im Alltag niemand
 * benutzt, und räumt es am Ende vollständig ab.
 */
const YEAR = 2099;
const INVOICE_DATE = `${YEAR}-03-01`;

interface Created {
  companyId: string;
  invoiceId: string;
}

/** Eine Organisation mit vollständiger Anschrift plus einem Entwurf. */
async function draft(
  label: string,
  override: Partial<Prisma.CompanyUncheckedCreateInput> = {},
  invoiceDate: string = INVOICE_DATE,
): Promise<Created> {
  const company = await createCompany(PREFIX, {
    street: 'Ziegelgasse',
    houseNumber: '14',
    postalCode: '99423',
    city: 'Weimar',
    country: 'Deutschland',
    contactEmail: `${label}@example.com`,
    ...override,
  });
  const invoice = await service.draftCreate(
    company.id,
    {
      invoiceDate,
      servicePeriodFrom: invoiceDate,
      servicePeriodUntil: datePlusDays(invoiceDate, 364),
      lines: [
        {
          label: 'Jahresbeitrag, Stufe 2',
          quantity: 1,
          unitPriceNetCent: 38_500,
          taxRate: 19,
        },
      ],
    },
    actor,
    SOURCE,
  );
  return { companyId: company.id, invoiceId: invoice.id };
}

/**
 * Ein Entwurf mit einem Rechnungsdatum in der JÜNGSTEN VERGANGENHEIT.
 *
 * Zahlungen prüfen die Reihenfolge der Daten: Ein Zahldatum darf weder vor dem
 * Rechnungsdatum noch in der Zukunft liegen. Beides zugleich ist mit dem
 * Prüfjahr 2099 nicht zu haben — deshalb rechnen die Zahlungsprüfungen im
 * laufenden Jahr. Sie treffen keine Aussage über den Nummernkreis und stören
 * die Jahresisolation daher nicht.
 */
async function draftInNow(label: string): Promise<Created> {
  return draft(label, {}, datePlusDays(today(), -10));
}

/** Alle in diesem Jahr vergebenen Nummern, numerisch sortiert. */
async function numbersOfYear(year = YEAR): Promise<number[]> {
  const rows = await prisma.invoice.findMany({
    where: { invoiceNumber: { startsWith: `${year}-` } },
    select: { invoiceNumber: true },
  });
  return rows
    .map((z) => splitNumber(z.invoiceNumber ?? '')?.running ?? -1)
    .sort((a, b) => a - b);
}

afterAll(async () => {
  await cleanUp(PREFIX);
  await disconnect();
});

// ===========================================================================
// 1. DER NUMMERNKREIS
// ===========================================================================

describe('Der Nummernkreis', () => {
  it('vergibt die Nummer ERST beim Festschreiben', async () => {
    const { invoiceId } = await draft('erst-beim-festschreiben');
    const asDraft = await service.get(invoiceId);
    expect(asDraft.invoiceNumber).toBeNull();
    expect(asDraft.status).toBe('draft');
    expect(asDraft.finalizedAt).toBeNull();

    const fest = await service.finalize(invoiceId, actor, SOURCE);
    expect(fest.invoiceNumber).toMatch(new RegExp(`^${YEAR}-\\d{3,}$`));
    expect(fest.status).toBe('finalized');
    expect(fest.finalizedAt).not.toBeNull();
  });

  it('zählt fortlaufend und ohne Lücke', async () => {
    const before = await numbersOfYear();
    const next = Math.max(0, ...before) + 1;

    for (let i = 0; i < 3; i += 1) {
      const { invoiceId } = await draft(`fortlaufend-${i}`);
      const fest = await service.finalize(invoiceId, actor, SOURCE);
      expect(fest.invoiceNumber).toBe(formatNumber(YEAR, next + i));
    }
  });

  /**
   * DER ENTSCHEIDENDE FALL — ZWANZIG GLEICHZEITIGE FESTSCHREIBUNGEN.
   *
   * Verlangt wird beides zugleich, und die beiden Aussagen sind nicht dasselbe:
   * KEINE DOPPELNUMMER (jede Nummer genau einmal) und KEINE LÜCKE (die Folge
   * ist ununterbrochen).
   *
   * Eine Postgres-Sequenz erfüllte nur die erste: `nextval` ist absichtlich
   * transaktionsunabhängig, ein Rollback hinterließe eine Lücke. Die
   * Beratungssperre erfüllt beide, weil die Nummer aus dem entsteht, was
   * TATSÄCHLICH committed in der Tabelle steht.
   */
  it('vergibt bei ZWANZIG gleichzeitigen Festschreibungen jede Nummer genau einmal, ohne Lücke', async () => {
    const before = await numbersOfYear();
    const start = Math.max(0, ...before) + 1;

    const drafts = await Promise.all(
      Array.from({ length: 20 }, (_, i) => draft(`gleichzeitig-${i}`)),
    );

    const results = await Promise.allSettled(
      drafts.map((e) => service.finalize(e.invoiceId, actor, SOURCE)),
    );

    // ALLE ZWANZIG müssen durchkommen. Ein Fehlschlag wäre schon die halbe
    // Miete verloren: Der Entwurf bliebe stehen und müsste von Hand
    // nachgezogen werden.
    const failed = results.filter((e) => e.status === 'rejected');
    expect(failed).toEqual([]);

    const taken = results
      .flatMap((e) => (e.status === 'fulfilled' ? [e.value] : []))
      .map((r) => splitNumber(r.invoiceNumber ?? '')?.running ?? -1)
      .sort((a, b) => a - b);

    // Keine Doppelnummer.
    expect(new Set(taken).size).toBe(20);
    // Keine Lücke: exakt start .. start+19.
    expect(taken).toEqual(
      Array.from({ length: 20 }, (_, i) => start + i),
    );
  });

  /**
   * DIE GEGENPROBE — GEMESSEN AN DER KAPUTTEN FASSUNG.
   *
   * `nextNumberWithoutLock` ist die naheliegende Umsetzung: höchste Nummer
   * lesen, eins draufzählen, schreiben. Sie steht NUR hier im Prüfcode und
   * niemals im Programm.
   *
   * Ohne Sperre lesen mehrere gleichzeitige Transaktionen dieselbe höchste
   * Nummer. Was dann passiert, hängt vom Zufall der Verschachtelung ab —
   * entweder greift der eindeutige Schlüssel auf `rechnungsnummer` und Aufrufe
   * scheitern, oder es entsteht eine Lücke. Beides ist ein Verstoß gegen R2,
   * und der Test verlangt nur, dass ÜBERHAUPT etwas schiefgeht: Ein Test, der
   * eine bestimmte Fehlerart verlangte, wäre selbst vom Zufall abhängig.
   */
  it('fällt gegen die kaputte Fassung um (Gegenprobe ohne Sperre)', async () => {
    const year = YEAR + 1;
    const company = await createCompany(PREFIX);

    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        prisma.$transaction(
          async (tx) => {
            const number = await nextNumberWithoutLock(tx, year);
            return tx.invoice.create({
              data: {
                companyId: company.id,
                invoiceNumber: number,
                status: 'finalized',
                invoiceDate: toDate(`${year}-03-01`),
                servicePeriodFrom: toDate(`${year}-03-01`),
                servicePeriodUntil: toDate(`${year}-03-31`),
                dueDate: toDate(`${year}-03-15`),
                recipientName: 'Gegenprobe',
                recipientAddress: 'Weg 1\n00000 Ort',
                issuerCompanyName: 'Gegenprobe',
                issuerAddress: 'Weg 1\n00000 Ort',
              },
              select: { invoiceNumber: true },
            });
          },
          { isolationLevel: 'ReadCommitted', timeout: 20_000 },
        ),
      ),
    );

    const succeeded = attempts
      .flatMap((v) => (v.status === 'fulfilled' ? [v.value] : []))
      .map((r) => splitNumber(r.invoiceNumber ?? '')?.running ?? -1)
      .sort((a, b) => a - b);

    const gaplessAndComplete =
      succeeded.length === 20 &&
      succeeded.every((value, i) => value === (succeeded[0] ?? 0) + i);

    // Die kaputte Fassung schafft es NICHT. Wäre sie hier grün, prüfte der
    // Test oben nichts.
    expect(gaplessAndComplete).toBe(false);

    // Aufräumen: Diese Zeilen gehören zu keiner der übrigen Prüfungen.
    await prisma.invoice.deleteMany({
      where: { invoiceNumber: { startsWith: `${year}-` } },
    });
  });

  /**
   * DER JAHRESWECHSEL SETZT DEN ZÄHLER ZURÜCK, OHNE DIE ALTEN NUMMERN ZU
   * BERÜHREN.
   *
   * Und zwar ohne dass irgendwo etwas zurückgesetzt werden müsste: Die Sperre
   * gilt pro Jahr, und die höchste Nummer wird pro Jahr gesucht. Es gibt
   * keinen Silvesterlauf, der schiefgehen könnte.
   */
  it('beginnt im neuen Jahr wieder bei 001 und lässt die alten Nummern stehen', async () => {
    const nextYear = YEAR + 2;
    const oldYear = YEAR + 3;

    // Erst eine Rechnung im ALTEN Jahr.
    const old = await draft('jahreswechsel-alt', {}, `${oldYear}-12-31`);
    const oldInvoice = await service.finalize(
      old.invoiceId,
      actor,
      SOURCE,
    );
    expect(oldInvoice.invoiceNumber).toBe(formatNumber(oldYear, 1));

    // Dann eine im NEUEN Jahr.
    const fresh = await draft(
      'jahreswechsel-neu',
      {},
      `${nextYear}-01-02`,
    );
    const newInvoice = await service.finalize(
      fresh.invoiceId,
      actor,
      SOURCE,
    );
    expect(newInvoice.invoiceNumber).toBe(formatNumber(nextYear, 1));

    // Die alte Nummer steht unverändert.
    expect((await service.get(old.invoiceId)).invoiceNumber).toBe(
      formatNumber(oldYear, 1),
    );
  });

  /**
   * DER NUMMERNKREIS HÄNGT AM RECHNUNGSDATUM, NICHT AM HEUTIGEN TAG.
   *
   * Eine am 2. Januar geschriebene Rechnung mit Datum vom 31. Dezember gehört
   * in den Kreis des alten Jahres. Andernfalls entstünde dort eine Lücke: Die
   * Nummer wäre vergeben, die Rechnung stünde im neuen Jahr.
   */
  it('richtet sich nach dem Rechnungsdatum, nicht nach heute', async () => {
    const retroactive = YEAR + 4;
    const { invoiceId } = await draft(
      'rueckwirkend',
      {},
      `${retroactive}-12-31`,
    );
    const fest = await service.finalize(invoiceId, actor, SOURCE);
    expect(fest.invoiceNumber?.startsWith(`${retroactive}-`)).toBe(true);
  });

  it('verbraucht bei einem gescheiterten Festschreiben KEINE Nummer', async () => {
    const before = await numbersOfYear();

    // Organisation ohne Anschrift: Das Festschreiben scheitert an den
    // Pflichtangaben nach § 14 UStG.
    const withoutAddress = await createCompany(PREFIX, {
      street: null,
      postalCode: null,
      city: null,
    });
    const draftWithout = await service.draftCreate(
      withoutAddress.id,
      {
        invoiceDate: INVOICE_DATE,
        servicePeriodFrom: INVOICE_DATE,
        servicePeriodUntil: datePlusDays(INVOICE_DATE, 30),
        lines: [
          {
            label: 'Etwas',
            quantity: 1,
            unitPriceNetCent: 1000,
            taxRate: 19,
          },
        ],
      },
      actor,
      SOURCE,
    );

    await expect(
      service.finalize(draftWithout.id, actor, SOURCE),
    ).rejects.toBeInstanceOf(InvoiceIncompleteError);

    // KEINE LÜCKE: Der Kreis steht genau da, wo er vorher stand.
    expect(await numbersOfYear()).toEqual(before);

    // Und die nächste gelungene Festschreibung bekommt die Nummer, die die
    // gescheiterte gehabt hätte.
    const { invoiceId } = await draft('nach-fehlschlag');
    const fest = await service.finalize(invoiceId, actor, SOURCE);
    expect(splitNumber(fest.invoiceNumber ?? '')?.running).toBe(
      Math.max(0, ...before) + 1,
    );
  });
});

// ===========================================================================
// 2. R2 — UNVERÄNDERLICH NACH DEM FESTSCHREIBEN
// ===========================================================================

describe('Eine festgeschriebene Rechnung', () => {
  it('lässt sich NICHT ändern', async () => {
    const { invoiceId } = await draft('nicht-aenderbar');
    await service.finalize(invoiceId, actor, SOURCE);

    await expect(
      service.draftUpdate(
        invoiceId,
        {
          invoiceDate: INVOICE_DATE,
          servicePeriodFrom: INVOICE_DATE,
          servicePeriodUntil: INVOICE_DATE,
          lines: [
            {
              label: 'Heimlich billiger',
              quantity: 1,
              unitPriceNetCent: 1,
              taxRate: 19,
            },
          ],
        },
        actor,
        SOURCE,
      ),
    ).rejects.toBeInstanceOf(InvoiceIsFinalizedError);

    // Und der Betrag steht unverändert.
    const after = await service.get(invoiceId);
    expect(after.sumGross).toBe('458.15');
  });

  it('lässt sich NICHT löschen', async () => {
    const { invoiceId } = await draft('nicht-loeschbar');
    await service.finalize(invoiceId, actor, SOURCE);

    await expect(
      service.draftDelete(invoiceId, actor, SOURCE),
    ).rejects.toBeInstanceOf(InvoiceIsFinalizedError);

    expect(
      await prisma.invoice.count({ where: { id: invoiceId } }),
    ).toBe(1);
  });

  it('lässt einen DRAFT dagegen ändern und löschen', async () => {
    const { invoiceId } = await draft('entwurf-veraenderlich');

    const updated = await service.draftUpdate(
      invoiceId,
      {
        invoiceDate: INVOICE_DATE,
        servicePeriodFrom: INVOICE_DATE,
        servicePeriodUntil: INVOICE_DATE,
        lines: [
          {
            label: 'Einrichtungshonorar',
            quantity: 1,
            unitPriceNetCent: 49_000,
            taxRate: 19,
          },
        ],
      },
      actor,
      SOURCE,
    );
    expect(updated.sumGross).toBe('583.10');
    expect(updated.lines).toHaveLength(1);

    await expect(
      service.draftDelete(invoiceId, actor, SOURCE),
    ).resolves.toEqual({ deleted: true });
    expect(await prisma.invoice.count({ where: { id: invoiceId } })).toBe(0);
  });

  /**
   * DER SCHNAPPSCHUSS BLEIBT STEHEN.
   *
   * R2, wörtlich: „alle Werte werden zum Zeitpunkt des Festschreibens
   * hineinkopiert. Niemals per Relation zur Organisation gerendert."
   */
  it('behält ihren Schnappschuss, wenn sich die Organisation danach ändert', async () => {
    const { companyId, invoiceId } = await draft('schnappschuss');
    const fest = await service.finalize(invoiceId, actor, SOURCE);
    const nameBefore = fest.recipientName;
    expect(fest.recipientAddress).toContain('Ziegelgasse 14');

    await companies.update(
      companyId,
      {
        name: `${PREFIX} Umbenannt und umgezogen`,
        street: 'Neue Gasse',
        houseNumber: '99',
        postalCode: '10115',
        city: 'Berlin',
      },
      actor,
      SOURCE,
    );

    const after = await service.get(invoiceId);
    expect(after.recipientName).toBe(nameBefore);
    expect(after.recipientAddress).toContain('Ziegelgasse 14');
    expect(after.recipientAddress).not.toContain('Neue Gasse');
    expect(after.recipientAddress).not.toContain('Berlin');
  });

  /**
   * ZEHN JAHRE AUFBEWAHRUNG STICHEN DAS LÖSCHVERLANGEN.
   *
   * Die Kontaktdatenlöschung aus Etappe 2 räumt Felder der Organisation und
   * löscht Notizen. Sie darf keine einzige Rechnung anfassen — und sie kann es
   * auch nicht: Der Fremdschlüssel steht auf `onDelete: Restrict`, und der
   * Beleg trägt seine Angaben selbst.
   */
  it('überlebt die Kontaktdatenlöschung unverändert', async () => {
    const company = await createCompany(PREFIX, {
      street: 'Ziegelgasse',
      houseNumber: '14',
      postalCode: '99423',
      city: 'Weimar',
      country: 'Deutschland',
      contactName: 'Marlene Ostermann',
      contactEmail: 'loeschung@example.com',
    });
    const created = await service.draftCreate(
      company.id,
      {
        invoiceDate: INVOICE_DATE,
        servicePeriodFrom: INVOICE_DATE,
        servicePeriodUntil: datePlusDays(INVOICE_DATE, 30),
        lines: [
          {
            label: 'Jahresbeitrag',
            quantity: 1,
            unitPriceNetCent: 38_500,
            taxRate: 19,
          },
        ],
      },
      actor,
      SOURCE,
    );
    const fest = await service.finalize(created.id, actor, SOURCE);

    await companies.contactDataDelete(
      company.id,
      company.name,
      actor,
      SOURCE,
    );

    const after = await service.get(fest.id);
    expect(after.invoiceNumber).toBe(fest.invoiceNumber);
    expect(after.sumGross).toBe('458.15');
    // Der Beleg trägt weiterhin Name und Anschrift der Empfängerin — die
    // steuerliche Aufbewahrungspflicht verlangt genau das.
    expect(after.recipientAddress).toContain('Ziegelgasse 14');
    expect(after.status).toBe('finalized');
  });
});

// ===========================================================================
// 3. STORNO
// ===========================================================================

describe('Storno', () => {
  it('erzeugt eine zweite Rechnung, beide bleiben, der Verweis geht in beide Richtungen', async () => {
    const { invoiceId } = await draft('storno-grundfall');
    const original = await service.finalize(invoiceId, actor, SOURCE);

    const { original: afterCancellation, cancellation } = await service.cancel(
      invoiceId,
      'Tippfehler bei der Preisstufe',
      actor,
      SOURCE,
    );

    // BEIDE BLEIBEN BESTEHEN.
    expect(await prisma.invoice.count({ where: { id: original.id } })).toBe(1);
    expect(await prisma.invoice.count({ where: { id: cancellation.id } })).toBe(1);

    // Die Stornorechnung hat eine EIGENE, fortlaufende Nummer.
    expect(cancellation.invoiceNumber).not.toBe(original.invoiceNumber);
    expect(cancellation.invoiceNumber).not.toBeNull();

    // NEGATIVER BETRAG, betragsgleich zum Original.
    expect(cancellation.sumGrossCent).toBe(-original.sumGrossCent);
    expect(cancellation.sumGross).toBe('-458.15');

    // DER VERWEIS GEHT IN BEIDE RICHTUNGEN.
    expect(cancellation.cancelledInvoiceId).toBe(original.id);
    expect(cancellation.isCancellation).toBe(true);
    expect(afterCancellation.cancellationInvoiceId).toBe(cancellation.id);
    expect(afterCancellation.status).toBe('cancelled');
    expect(afterCancellation.paymentState).toBe('cancelled');

    // Der Grund steht auf der Stornorechnung.
    expect(cancellation.cancellationReason).toBe('Tippfehler bei der Preisstufe');
  });

  it('kopiert den Schnappschuss vom ORIGINAL, nicht aus der Organisation', async () => {
    const { companyId, invoiceId } = await draft('storno-schnappschuss');
    const original = await service.finalize(invoiceId, actor, SOURCE);

    await companies.update(
      companyId,
      { street: 'Ganz woanders', houseNumber: '1', postalCode: '10115', city: 'Berlin' },
      actor,
      SOURCE,
    );

    const { cancellation } = await service.cancel(
      invoiceId,
      'Nach dem Umzug storniert',
      actor,
      SOURCE,
    );

    // Eine Stornorechnung mit der NEUEN Adresse höbe die alte Rechnung nicht
    // sichtbar auf — sie sähe aus wie ein zweiter Vorgang.
    expect(cancellation.recipientAddress).toBe(original.recipientAddress);
    expect(cancellation.recipientAddress).toContain('Ziegelgasse 14');
  });

  it('lässt sich nicht zweimal stornieren', async () => {
    const { invoiceId } = await draft('storno-nur-einmal');
    await service.finalize(invoiceId, actor, SOURCE);
    await service.cancel(invoiceId, 'Erster Storno', actor, SOURCE);

    await expect(
      service.cancel(invoiceId, 'Zweiter Storno', actor, SOURCE),
    ).rejects.toBeInstanceOf(Error);
  });

  it('weist TWO GLEICHZEITIGE Stornierungen bis auf eine ab', async () => {
    const { invoiceId } = await draft('storno-gleichzeitig');
    await service.finalize(invoiceId, actor, SOURCE);

    const results = await Promise.allSettled([
      service.cancel(invoiceId, 'A', actor, SOURCE),
      service.cancel(invoiceId, 'B', actor, SOURCE),
    ]);

    expect(results.filter((e) => e.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.invoice.count({ where: { cancelledInvoiceId: invoiceId } }),
    ).toBe(1);
  });

  it('storniert keine Stornorechnung', async () => {
    const { invoiceId } = await draft('storno-vom-storno');
    await service.finalize(invoiceId, actor, SOURCE);
    const { cancellation } = await service.cancel(
      invoiceId,
      'Grund',
      actor,
      SOURCE,
    );

    await expect(
      service.cancel(cancellation.id, 'Und nochmal', actor, SOURCE),
    ).rejects.toBeInstanceOf(CancellationNotCancellableError);
  });

  it('storniert keinen Entwurf — der wird gelöscht', async () => {
    const { invoiceId } = await draft('storno-vom-entwurf');
    await expect(
      service.cancel(invoiceId, 'Grund', actor, SOURCE),
    ).rejects.toBeInstanceOf(Error);
  });

  it('nennt beim zweiten Versuch die Nummer der bestehenden Stornorechnung', async () => {
    const { invoiceId } = await draft('storno-meldung');
    await service.finalize(invoiceId, actor, SOURCE);
    const { cancellation } = await service.cancel(invoiceId, 'A', actor, SOURCE);

    // Der Zustand `storniert` schlägt zuerst zu; die Meldung mit der Nummer
    // greift, sobald der Zustand passt. Beide Wege enden bei einem Konflikt —
    // geprüft wird, dass keiner davon eine zweite Stornorechnung erzeugt.
    await expect(
      service.cancel(invoiceId, 'B', actor, SOURCE),
    ).rejects.toBeInstanceOf(Error);
    expect(
      await prisma.invoice.findMany({
        where: { cancelledInvoiceId: invoiceId },
        select: { id: true },
      }),
    ).toEqual([{ id: cancellation.id }]);
  });
});

// ===========================================================================
// 4. ZAHLUNGEN
// ===========================================================================

describe('Zahlungen', () => {
  it('vermerkt eine vollständige Zahlung', async () => {
    const { invoiceId } = await draftInNow('zahlung-voll');
    await service.finalize(invoiceId, actor, SOURCE);

    const paid = await payments.note(
      invoiceId,
      today(),
      45_815,
      actor,
      SOURCE,
    );
    expect(paid.status).toBe('paid');
    expect(paid.paymentState).toBe('paid');
    expect(paid.paidAmount).toBe('458.15');
    expect(paid.openAmount).toBe('0.00');
  });

  it('HAELT ONE TEILZAHLUNG FEST, LAESST DIE RECHNUNG ABER OFFEN', async () => {
    // Entscheidung des Auftraggebers beim Durchgang zum Redesign, woertlich:
    // „Ich muss Zahlungen ja manuell erfassen — es wird kein echtes Konto
    // gegengeprueft. Daher gibt es nur Offen oder Gezahlt."
    //
    // Der BETRAG bleibt trotzdem stehen: Er gehoert zum Beleg und steht in
    // der Ansicht. Nur der Zustand kennt kein Dazwischen mehr — und zwar in
    // BEIDEN Feldern, damit sie sich nicht widersprechen.
    const { invoiceId } = await draftInNow('zahlung-teil');
    await service.finalize(invoiceId, actor, SOURCE);

    const part = await payments.note(
      invoiceId,
      today(),
      20_000,
      actor,
      SOURCE,
    );
    expect(part.status).toBe('finalized');
    expect(part.paymentState).toBe('open');
    // Was gezahlt wurde, ist festgehalten — und was noch aussteht, stimmt.
    expect(part.paidAmount).toBe('200.00');
    expect(part.openAmount).toBe('258.15');
  });

  it('meldet eine überfällige Rechnung als überfällig — ohne sie anzufassen', async () => {
    const past = datePlusDays(today(), -40);
    const { invoiceId } = await draft('zahlung-ueberfaellig', {}, past);
    const fest = await service.finalize(invoiceId, actor, SOURCE);

    // Der GESCHRIEBENE Status bleibt `festgeschrieben`; „überfällig" ist
    // abgeleitet. Ein nächtlicher Lauf, der ihn setzte, wäre ein
    // automatischer Schreibvorgang mit Geldfolge — genau das schließt R5 aus.
    expect(fest.status).toBe('finalized');
    expect(fest.paymentState).toBe('overdue');
  });

  it('weist einen Zahlbetrag weit über dem Rechnungsbetrag ab', async () => {
    const { invoiceId } = await draftInNow('zahlung-zahlendreher');
    await service.finalize(invoiceId, actor, SOURCE);
    await expect(
      payments.note(invoiceId, today(), 458_150, actor, SOURCE),
    ).rejects.toThrow(/über dem Rechnungsbetrag/);
  });

  it('weist ein Zahldatum vor dem Rechnungsdatum ab', async () => {
    const { invoiceId } = await draftInNow('zahlung-zu-frueh');
    await service.finalize(invoiceId, actor, SOURCE);
    await expect(
      payments.note(
        invoiceId,
        datePlusDays(today(), -20),
        45_815,
        actor,
        SOURCE,
      ),
    ).rejects.toThrow(/vor dem Rechnungsdatum/);
  });

  it('vermerkt keine Zahlung an einem Entwurf', async () => {
    const { invoiceId } = await draft('zahlung-am-entwurf');
    await expect(
      payments.note(invoiceId, today(), 100, actor, SOURCE),
    ).rejects.toBeInstanceOf(Error);
  });

  it('lässt eine falsch erfasste Zahlung berichtigen', async () => {
    const { invoiceId } = await draftInNow('zahlung-berichtigen');
    await service.finalize(invoiceId, actor, SOURCE);
    await payments.note(invoiceId, today(), 45_815, actor, SOURCE);

    const back = await payments.note(invoiceId, today(), 0, actor, SOURCE);
    expect(back.status).toBe('finalized');
    expect(back.paidAmount).toBeNull();
    expect(back.paymentDate).toBeNull();
  });
});

// ===========================================================================
// 5. AUDIT-LOG (R6)
// ===========================================================================

describe('Audit-Log', () => {
  it('protokolliert Entwurf, Festschreiben und Storno getrennt', async () => {
    const { invoiceId } = await draft('audit');
    await service.finalize(invoiceId, actor, SOURCE);
    await service.cancel(invoiceId, 'Grund', actor, SOURCE);

    const entries = await prisma.auditLog.findMany({
      where: { objectId: invoiceId },
      orderBy: { timestamp: 'asc' },
      select: { action: true, afterValue: true },
    });
    expect(entries.map((e) => e.action)).toEqual([
      AUDIT_ACTION.invoiceDraftCreated,
      AUDIT_ACTION.invoiceFinalized,
      AUDIT_ACTION.invoiceCancelled,
    ]);
  });

  /**
   * KEINE ZAHLUNGSDATEN UND KEINE PERSONENBEZOGENEN ANGABEN IM KLARTEXT.
   *
   * Die Sperrliste aus Etappe 2 greift von selbst: `name`, `email`, `strasse`,
   * `plz`, `ort` und `iban` stehen darin. Das Audit-Log hat keinen Löschweg —
   * stünden diese Werte hier, überlebten sie jede Kontaktdatenlöschung, und
   * die zugesagte Löschung wäre eine Behauptung.
   */
  it('schreibt weder Empfängernamen noch Anschrift in den Nachweis', async () => {
    const company = await createCompany(PREFIX, {
      name: `${PREFIX} Geheimhof e. V.`,
      street: 'Ziegelgasse',
      houseNumber: '14',
      postalCode: '99423',
      city: 'Weimar',
    });
    const past = datePlusDays(today(), -10);
    const created = await service.draftCreate(
      company.id,
      {
        invoiceDate: past,
        servicePeriodFrom: past,
        servicePeriodUntil: past,
        lines: [
          {
            label: 'Etwas',
            quantity: 1,
            unitPriceNetCent: 1000,
            taxRate: 19,
          },
        ],
      },
      actor,
      SOURCE,
    );
    await service.finalize(created.id, actor, SOURCE);
    await payments.note(created.id, today(), 1190, actor, SOURCE);

    const entries = await prisma.auditLog.findMany({
      where: { objectId: created.id },
      select: { beforeValue: true, afterValue: true },
    });
    const asText = JSON.stringify(entries);
    expect(asText).not.toContain('Geheimhof');
    expect(asText).not.toContain('Ziegelgasse');
    expect(asText).not.toContain('Weimar');
    expect(asText).not.toContain('DE705305');
  });
});

// ===========================================================================
// DIE KAPUTTE FASSUNG — NUR IM PRÜFCODE
// ===========================================================================

/**
 * Die naheliegende und falsche Nummernvergabe: höchste Nummer lesen, eins
 * draufzählen. OHNE `pg_advisory_xact_lock`.
 *
 * Sie steht ausschließlich hier. `invoice-immutable.spec.ts` und
 * `build-content.spec.ts` stellen zusammen sicher, dass Prüfcode nicht ins
 * Auslieferungsartefakt gerät.
 */
async function nextNumberWithoutLock(
  tx: Prisma.TransactionClient,
  year: number,
): Promise<string> {
  const taken = await tx.invoice.findMany({
    where: { invoiceNumber: { startsWith: `${year}-` } },
    select: { invoiceNumber: true },
  });
  const highest = taken.reduce((largest, row) => {
    const split = splitNumber(row.invoiceNumber ?? '');
    if (split === null || split.year !== year) return largest;
    return Math.max(largest, split.running);
  }, 0);
  return formatNumber(year, highest + 1);
}

/**
 * ===========================================================================
 * [W1] — DIE SCHRANKE STEHT VOR DER NUMMERNVERGABE
 * ===========================================================================
 *
 * Gemessen wurde `1970-001`, `2019-001`, `2062-001` — unlöschbar
 * festgeschrieben, weil das Rechnungsdatum den Nummernkreis steuert und keine
 * Grenze hatte.
 *
 * Diese Suite benutzt `serviceWithWindow`, also die VORGABEWERTE. Die
 * Nummernkreis-Prüfungen oben laufen bewusst mit weit geöffnetem Fenster;
 * hier geht es um die Regel selbst.
 */
describe('[W1] Ein fremdes Geschäftsjahr lässt sich nicht eröffnen', () => {
  const TODAY = today();

  async function companyWithAddress() {
    return createCompany(PREFIX, {
      street: 'Ziegelgasse',
      houseNumber: '14',
      postalCode: '99423',
      city: 'Weimar',
      country: 'Deutschland',
      contactEmail: 'w1@example.com',
    });
  }

  function draftData(invoiceDate: string) {
    return {
      invoiceDate,
      servicePeriodFrom: invoiceDate,
      servicePeriodUntil: datePlusDays(invoiceDate, 364),
      lines: [
        {
          label: 'Jahresbeitrag, Stufe 2',
          quantity: 1,
          unitPriceNetCent: 38_500,
          taxRate: 19,
        },
      ],
    };
  }

  it.each(['1970-01-01', '2019-06-30', '2062-12-31'])(
    'legt zu %s gar keinen Entwurf an',
    async (date) => {
      const company = await companyWithAddress();
      await expect(
        serviceWithWindow.draftCreate(
          company.id,
          draftData(date),
          actor,
          SOURCE,
        ),
      ).rejects.toMatchObject({ errorCode: 'invoice_date_outside' });

      expect(
        await prisma.invoice.count({ where: { companyId: company.id } }),
      ).toBe(0);
    },
  );

  /**
   * DIE EIGENTLICHE SCHRANKE. Ein Entwurf kann aus der Zeit vor [W1] stammen
   * oder wochenlang liegen geblieben sein — geprüft werden MUSS unmittelbar
   * vor der Nummernvergabe, denn danach gibt es keine Korrektur mehr.
   */
  it('vergibt für einen Entwurf ausserhalb des Fensters KEINE Nummer', async () => {
    const company = await companyWithAddress();
    // Angelegt mit weit geöffnetem Fenster — so, wie ein Altbestand aussähe.
    const created = await service.draftCreate(
      company.id,
      draftData('2062-12-31'),
      actor,
      SOURCE,
    );

    await expect(
      serviceWithWindow.finalize(created.id, actor, SOURCE),
    ).rejects.toMatchObject({ errorCode: 'invoice_date_outside' });

    const after = await prisma.invoice.findUniqueOrThrow({
      where: { id: created.id },
      select: { invoiceNumber: true, status: true },
    });
    // Keine Nummer verbraucht, kein Kreis eröffnet, der Entwurf bleibt Entwurf.
    expect(after.invoiceNumber).toBeNull();
    expect(after.status).toBe('draft');
    expect(
      await prisma.invoice.count({
        where: { invoiceNumber: { startsWith: '2062-' } },
      }),
    ).toBe(0);
  });

  it('lässt ein Datum im Fenster unverändert durch', async () => {
    const company = await companyWithAddress();
    const created = await serviceWithWindow.draftCreate(
      company.id,
      draftData(datePlusDays(TODAY, -5)),
      actor,
      SOURCE,
    );
    expect(created.id).toBeDefined();
  });
});

/**
 * ===========================================================================
 * [W2] — „IDEMPOTENT" WAR EIN CHECK-THEN-ACT OHNE SPERRE
 * ===========================================================================
 *
 * Gemessen mit fünf gleichzeitigen `GET /invoices/:id/dokument`:
 * ```
 * 200/5c0b033d 200/b1746166 200/8fd81539 200/ec4c31b1 200/8fd81539
 * verschiedene PDF-Fassungen derselben Rechnungsnummer: 4
 * ```
 * Vier Bytefolgen herausgegeben, eine gespeichert. Ein Doppelklick während des
 * Versands, und die Kundin hält eine andere Ausfertigung als das Archiv.
 *
 * DIE INVARIANTE, die dieser Test festhält: *Was ausgegeben wird, ist immer
 * das, was im Archiv liegt.* Er fällt gegen die Fassung ohne bedingten
 * Schreibvorgang.
 */
describe('[W2] Ein Beleg hat genau eine Ausfertigung', () => {
  /**
   * Ein Rechnungsdienst, der bei jedem Aufruf eine ANDERE Bytefolge liefert —
   * so wie es ein echter tut, der einen Zeitstempel in die PDF-Metadaten
   * schreibt. Genau dadurch wurde der Fehler überhaupt sichtbar.
   */
  function flakyRenderer(): { renderer: InvoiceRenderer; calls: () => number } {
    let number = 0;
    return {
      renderer: {
        isConfigured: () => true,
        create: async () => {
          // DIE EIGENE NUMMER VOR DEM `await` FESTHALTEN. Läse der Ausdruck
          // unten `nummer` erneut, stünde dort längst der Stand des letzten
          // Aufrufs — alle fünf bekämen dieselbe Bytefolge, und der Test
          // bewiese nichts. (Genau das ist beim ersten Anlauf passiert.)
          const my = (number += 1);
          // Kurz warten, damit sich die Aufrufe wirklich überlappen.
          await new Promise((done) => setTimeout(done, 25));
          return Buffer.from(`%PDF-fassung-${my}-${'x'.repeat(64)}`, 'utf8');
        },
      },
      calls: () => number,
    };
  }

  it('gibt bei fünf gleichzeitigen Abrufen fünfmal DIESELBE Bytefolge aus', async () => {
    const created = await draft('w2-dokument');
    const finalized = await service.finalize(
      created.invoiceId,
      actor,
      SOURCE,
    );
    expect(finalized.invoiceNumber).not.toBeNull();

    const { renderer, calls } = flakyRenderer();
    const documents = new InvoiceDocumentService(
      prisma,
      audit,
      issuer,
      renderer,
    );

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        documents.getOrCreate(created.invoiceId, actor, SOURCE),
      ),
    );

    const versions = new Set(results.map((e) => e.pdf.toString('utf8')));
    expect(versions.size).toBe(1);

    // Und die ausgegebene Fassung ist die GESPEICHERTE.
    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: created.invoiceId },
      select: { pdfContent: true },
    });
    expect(Buffer.from(stored.pdfContent!).toString('utf8')).toBe(
      [...versions][0],
    );
    // Dass der Dienst mehrfach gerufen wurde, ist erlaubt — verworfen werden
    // muss nur alles ausser der ersten gespeicherten Fassung.
    expect(calls()).toBeGreaterThanOrEqual(1);
  });

  it('gibt bei einem späteren Abruf weiterhin dieselbe Fassung aus', async () => {
    const created = await draft('w2-spaeter');
    await service.finalize(created.invoiceId, actor, SOURCE);

    const { renderer } = flakyRenderer();
    const documents = new InvoiceDocumentService(prisma, audit, issuer, renderer);

    const first = await documents.getOrCreate(
      created.invoiceId,
      actor,
      SOURCE,
    );
    const later = await documents.getOrCreate(
      created.invoiceId,
      actor,
      SOURCE,
    );
    expect(later.pdf.toString('utf8')).toBe(first.pdf.toString('utf8'));
  });
});

/**
 * [H2] — EIN EINGABEFELD, DAS STILLSCHWEIGEND VERWORFEN WURDE
 *
 * `einheit` wurde entgegengenommen, validiert, bis in `LineInput`
 * gereicht — und nie gespeichert; im XML stand fest `unitCode="C62"`. Auf
 * einem UNVERÄNDERLICHEN Beleg ist das besonders unangenehm: Wer „MON"
 * eintrug und festschrieb, bekam eine Angabe, die er nie gemacht hat, und
 * konnte sie nicht mehr korrigieren.
 */
describe('[H2] Die Mengeneinheit landet auf dem Beleg', () => {
  async function withUnit(label: string, unit?: string) {
    const company = await createCompany(PREFIX, {
      street: 'Ziegelgasse',
      houseNumber: '14',
      postalCode: '99423',
      city: 'Weimar',
      country: 'Deutschland',
      contactEmail: `${label}@example.com`,
    });
    const invoice = await service.draftCreate(
      company.id,
      {
        invoiceDate: INVOICE_DATE,
        servicePeriodFrom: INVOICE_DATE,
        servicePeriodUntil: datePlusDays(INVOICE_DATE, 364),
        lines: [
          {
            label: 'Betreuung',
            quantity: 12,
            unitPriceNetCent: 3_500,
            taxRate: 19,
            ...(unit ? { unit } : {}),
          },
        ],
      },
      actor,
      SOURCE,
    );
    return { companyId: company.id, invoiceId: invoice.id };
  }

  it('speichert die angegebene Einheit am Posten', async () => {
    const { invoiceId } = await withUnit('h2-monat', 'MON');
    const lines = await prisma.invoiceLine.findFirstOrThrow({
      where: { invoiceId },
    });
    expect(lines.unit).toBe('MON');
  });

  it('lässt sie leer, wenn keine angegeben wurde', async () => {
    const { invoiceId } = await withUnit('h2-ohne');
    const lines = await prisma.invoiceLine.findFirstOrThrow({
      where: { invoiceId },
    });
    expect(lines.unit).toBeNull();
  });

  it('nimmt sie in die Stornorechnung mit', async () => {
    const { invoiceId } = await withUnit('h2-storno', 'HUR');
    await service.finalize(invoiceId, actor, SOURCE);
    const { cancellation } = await service.cancel(
      invoiceId,
      'Prüfung der Einheit',
      actor,
      SOURCE,
    );
    const linesOfCancellation = await prisma.invoiceLine.findFirstOrThrow({
      where: { invoiceId: cancellation.id },
    });
    // Ein Storno nimmt dieselbe Leistung zurück — in derselben Einheit.
    expect(linesOfCancellation.unit).toBe('HUR');
  });
});

/**
 * DERSELBE FEHLERTYP WIE [H2] — diesmal an fünf Feldern auf einmal.
 *
 * Der Bearbeiten-Screen brachte drei Texte am Kopf (Einleitung,
 * Zahlungshinweis, interne Notiz) und zwei Daten am Posten (Zeitraum). Sie
 * wurden gespeichert, und der Zusammenbau des Dokuments liess sie fallen: Die
 * Betreiberin tippt einen Satz, das System bestätigt das Speichern, und auf
 * dem PDF steht er nicht.
 *
 * Der Test geht deshalb NICHT bis zur Spalte, sondern bis zum ERZEUGTEN
 * DOKUMENT. Eine Spalte, die niemand rendert, ist kein Feld.
 */
describe('Die Texte des Bearbeiten-Screens stehen auf dem Beleg', () => {
  const INTRODUCTION = 'wie besprochen die Rechnung für das kommende Jahr.';
  const HINT = 'Bitte die Rechnungsnummer im Verwendungszweck angeben.';
  const NOTE = 'Zahlt erfahrungsgemäß spät — im Oktober nachfassen.';

  async function withTexts(label: string) {
    const company = await createCompany(PREFIX, {
      street: 'Ziegelgasse',
      houseNumber: '14',
      postalCode: '99423',
      city: 'Weimar',
      country: 'Deutschland',
      contactEmail: `${label}@example.com`,
    });
    const invoice = await service.draftCreate(
      company.id,
      {
        invoiceDate: INVOICE_DATE,
        servicePeriodFrom: INVOICE_DATE,
        servicePeriodUntil: datePlusDays(INVOICE_DATE, 364),
        introduction: INTRODUCTION,
        paymentNote: HINT,
        internalNote: NOTE,
        lines: [
          {
            label: 'Jahresbeitrag, Stufe 2',
            description: 'Zugang für bis zu 60 Teilhabende',
            quantity: 1,
            unitPriceNetCent: 38_500,
            taxRate: 19,
            periodFrom: INVOICE_DATE,
            periodUntil: datePlusDays(INVOICE_DATE, 364),
          },
        ],
      },
      actor,
      SOURCE,
    );
    return { companyId: company.id, invoiceId: invoice.id };
  }

  /**
   * Gibt XML UND HTML aus, die der Dienst zu sehen bekommt — er wird dabei
   * nachgestellt. Beide Ausgaben werden geprüft: Ein Feld, das nur im XML
   * ankommt, fehlt der Empfängerin auf dem Blatt, das sie liest.
   */
  async function voucherFrom(
    invoiceId: string,
  ): Promise<{ xml: string; html: string }> {
    let seen = { xml: '', html: '' };
    const renderer: InvoiceRenderer = {
      isConfigured: () => true,
      async create(html: string, xml: string) {
        seen = { xml, html };
        return Buffer.from('%PDF-1.7 Prüfstück');
      },
    };
    const documents = new InvoiceDocumentService(prisma, audit, issuer, renderer);
    await documents.getOrCreate(invoiceId, actor, SOURCE);
    return seen;
  }

  it('trägt Einleitung und Zahlungshinweis in das Dokument', async () => {
    const { invoiceId } = await withTexts('texte-beleg');
    await service.finalize(invoiceId, actor, SOURCE);
    const { xml, html } = await voucherFrom(invoiceId);

    expect(xml).toContain(INTRODUCTION);
    expect(xml).toContain(HINT);
    expect(html).toContain(INTRODUCTION);
    expect(html).toContain(HINT);
  });

  it('trägt Beschreibung und Postenzeitraum in das Dokument', async () => {
    const { invoiceId } = await withTexts('posten-beleg');
    await service.finalize(invoiceId, actor, SOURCE);
    const { xml, html } = await voucherFrom(invoiceId);

    expect(xml).toContain('Zugang für bis zu 60 Teilhabende');
    expect(html).toContain('Zugang für bis zu 60 Teilhabende');
    // Zwei Zeiträume: einer am Kopf, einer am Posten.
    expect(xml.match(/<ram:BillingSpecifiedPeriod>/g) ?? []).toHaveLength(2);
  });

  it('LÄSST DIE INTERNE NOTE AUS DEM DOCUMENT HERAUS', async () => {
    // Der Zettel am Vorgang. Er steht auf keinem Beleg und geht in keine
    // Mail — sonst läse die Empfängerin, was über sie notiert wurde.
    const { invoiceId } = await withTexts('notiz-nicht-beleg');
    await service.finalize(invoiceId, actor, SOURCE);
    const { xml, html } = await voucherFrom(invoiceId);

    expect(xml).not.toContain(NOTE);
    expect(html).not.toContain(NOTE);
    expect(xml).not.toContain('nachfassen');
    expect(html).not.toContain('nachfassen');
  });

  it('nimmt Beschreibung und Zeitraum in die Stornorechnung mit', async () => {
    const { invoiceId } = await withTexts('texte-storno');
    await service.finalize(invoiceId, actor, SOURCE);
    const { cancellation } = await service.cancel(
      invoiceId,
      'Falscher Leistungszeitraum',
      actor,
      SOURCE,
    );
    const lines = await prisma.invoiceLine.findFirstOrThrow({
      where: { invoiceId: cancellation.id },
    });
    expect(lines.description).toBe('Zugang für bis zu 60 Teilhabende');
    expect(lines.periodFrom).not.toBeNull();
    expect(lines.periodUntil).not.toBeNull();
  });

  it('weist einen halben Postenzeitraum ab, statt ihn zu verschlucken', async () => {
    const company = await createCompany(PREFIX, {
      street: 'Ziegelgasse',
      houseNumber: '14',
      postalCode: '99423',
      city: 'Weimar',
      country: 'Deutschland',
      contactEmail: 'halber-zeitraum@example.com',
    });
    // Die Meldung des Fehlers ist ein fester Rahmensatz; der WORTLAUT der
    // Beanstandung steht in `detail.missingDetails`. Auf den Rahmensatz zu
    // prüfen hiesse, jeden beliebigen Pflichtfehler zu akzeptieren.
    const attempt = service.draftCreate(
        company.id,
        {
          invoiceDate: INVOICE_DATE,
          servicePeriodFrom: INVOICE_DATE,
          servicePeriodUntil: datePlusDays(INVOICE_DATE, 364),
          lines: [
            {
              label: 'Betreuung',
              quantity: 1,
              unitPriceNetCent: 3_500,
              taxRate: 19,
              periodFrom: INVOICE_DATE,
            },
          ],
        },
        actor,
        SOURCE,
      );
    await expect(attempt).rejects.toMatchObject({
      errorCode: 'invoice_incomplete',
      errorDetail: {
        missingDetails: [
          'Posten 1: Bitte beide Daten des Zeitraums angeben oder beide weglassen.',
        ],
      },
    });
  });
});
