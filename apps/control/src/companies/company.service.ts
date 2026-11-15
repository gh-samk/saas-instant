import { Injectable } from '@nestjs/common';
import {
  IntakeSendService,
  type IntakeLinkSend,
} from '../intake/intake-send.service';
import type {
  CompanyStatus,
  Prisma,
  InvoiceStatus,
  PaymentMethod,
  PaymentInterval,
} from '.prisma/control-client';
import { today, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { dayReadable } from '../common/calendar';
import { writeSystemNote } from '../notes/system-note';
import { PrismaService } from '../prisma/prisma.service';
import { decimalAsCent } from '../invoices/invoice.amount';
import { sum, paymentStateFrom } from '../invoices/invoice.response';
import {
  asResponse,
  type InquiriesResponse,
  asPaymentDetails,
  dayOrNull,
  type CompanyResponse,
  type CompanyShort,
  type CompanyRow,
  type PaymentDetailsResponse,
} from './company.response';
import { createAfterPrisma, masterDataAfterPrisma } from './company.data';
import {
  ConfirmationMatchesNotError,
  MonthlyOnlyDirectDebitError,
  CompanyNotFoundError,
  CompanyNotDeletableError,
  StatusUnchangedError,
  type DeletionBlocker,
} from './company.errors';
import { performStatusChange } from './status-change';
import type {
  ContactPersonChangeDto,
  CompanyCreateDto,
  CompanyUpdateDto,
  CompanyListDto,
  PaymentDetailsDto,
} from './dto/company.dto';

/**
 * Wer handelt — aus der Sitzung, nicht aus dem Body.
 *
 * `userId` darf `null` sein: es gibt Akteure ohne Konto (der Zeitplan, das
 * öffentliche Formular). Der Klartextname steht deshalb immer daneben, genau
 * dafür hat `AuditLog.akteur` sein eigenes Feld.
 */
export interface Actor {
  userId: string | null;
  name: string;
}

const PER_PAGE_DEFAULT = 25;

/**
 * Rechnungszustaende, die kein Geld fordern: ein Entwurf noch nicht, eine
 * stornierte Rechnung nicht mehr.
 *
 * Bewusst eine veraenderliche Liste und kein `as const`: Prisma nimmt fuer
 * `notIn` nur ein `InvoiceStatus[]`.
 */
const NOT_DEMANDING: InvoiceStatus[] = ['draft', 'cancelled'];

/** Felder der Kurzform. Die Liste zeigt keine Bank- und Rechnungsdaten. */
const SHORT_SELECT = {
  id: true,
  name: true,
  status: true,
  city: true,
  contactName: true,
  contactEmail: true,
  reviewDueDate: true,
  lastStatusChangeAt: true,
  createdAt: true,
  // Fuer die Spalte „Instanz". 1:1-Beziehung, also hoechstens eine Zeile.
  instance: { select: { status: true } },
  // Fuer die Spalte „Offen". Entwuerfe und Stornos bleiben draussen: ein
  // Entwurf fordert kein Geld, eine stornierte Rechnung keines mehr.
  invoices: {
    where: { status: { notIn: NOT_DEMANDING } },
    select: {
      status: true,
      dueDate: true,
      paidAmount: true,
      lines: { select: { grossAmount: true } },
    },
  },
} as const;


/**
 * Offener Betrag einer Organisation und ob davon etwas ueberfaellig ist.
 *
 * DIE ABLEITUNG WIRD AUFGERUFEN, NICHT WIEDERHOLT. `paymentStateFrom` ist die
 * einzige Stelle, die entscheidet, ob eine Rechnung offen ist — sie kennt die
 * Sonderfaelle (Storno sticht alles, Gutschrift gilt als ausgeglichen, sobald
 * erstattet wurde). Eine zweite Fassung hier waere die Stelle, an der Liste
 * und Rechnungsansicht eines Tages verschiedene Betraege zeigen.
 */
function openState(
  invoices: readonly {
    status: InvoiceStatus;
    dueDate: Date;
    paidAmount: Prisma.Decimal | null;
    lines: readonly { grossAmount: Prisma.Decimal }[];
  }[],
  todayDay: string,
): { openAmountCent: number; openOverdue: boolean } {
  let openAmountCent = 0;
  let openOverdue = false;

  for (const invoice of invoices) {
    const gross = sum(invoice.lines, 'grossAmount');
    const state = paymentStateFrom(invoice, gross, todayDay);
    if (state !== 'open' && state !== 'overdue') continue;
    // Was schon gezahlt wurde, ist nicht mehr offen — auch wenn der Rest es
    // noch ist.
    openAmountCent += gross - (decimalAsCent(invoice.paidAmount) ?? 0);
    if (state === 'overdue') openOverdue = true;
  }

  return { openAmountCent, openOverdue };
}

/**
 * MONATLICH GEHT NUR PER LASTSCHRIFT — die Regel der Webseite, serverseitig.
 *
 * „Halbjährlich und jährlich per Überweisung oder Lastschrift, monatlich per
 * Lastschrift" (Preis- und Zahlungsbedingungen des Produkts). Zwölf einzelne Überweisungen im Jahr sind für
 * beide Seiten Aufwand ohne Gegenwert.
 *
 * SIE GREIFT NUR, WENN BEIDE ANGABEN DASTEHEN. Eine Organisation in der
 * Anfrage hat oft noch keine von beiden, und ein halb ausgefüllter Vertrag
 * ist kein Fehler — er ist der Normalfall am Anfang. Verlangt wird nur, dass
 * die beiden Angaben zueinander passen, sobald es sie gibt.
 */
export function checkPaymentPairing(
  way: PaymentInterval | null | undefined,
  kind: PaymentMethod | null | undefined,
): void {
  if (way === 'monthly' && kind === 'bank_transfer') {
    throw new MonthlyOnlyDirectDebitError();
  }
}

@Injectable()
export class CompanyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly intakeSend: IntakeSendService,
  ) {}

  /**
   * Liste mit Statusfilter und Freitextsuche über Name, Ansprechpartnerin,
   * deren E-Mail und Ort — ohne Beachtung der Groß-/Kleinschreibung.
   */
  async list(filter: CompanyListDto): Promise<{
    companies: CompanyShort[];
    total: number;
    page: number;
    perPage: number;
    /**
     * Menge je Status — die Zahlen der Filterchips. Sie beachten die SUCHE,
     * aber nicht den Statusfilter.
     */
    countPerStatus: Record<CompanyStatus, number>;
  }> {
    const page = filter.page ?? 1;
    const perPage = filter.perPage ?? PER_PAGE_DEFAULT;
    const search = filter.search?.trim();

    // ZWEI Bedingungen, und der Unterschied ist wesentlich: `where` filtert
    // die Liste, `searchCondition` zaehlt die Chips. Zaehlte man die Chips mit
    // dem Statusfilter, zeigte jeder Chip ausser dem gewaehlten eine Null —
    // die Leiste waere genau dann nutzlos, wenn man sie braucht.
    const searchCondition: Prisma.CompanyWhereInput = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { contactName: { contains: search, mode: 'insensitive' } },
            { contactEmail: { contains: search, mode: 'insensitive' } },
            { city: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

    const where: Prisma.CompanyWhereInput = {
      ...searchCondition,
      ...(filter.status && filter.status.length > 0
        ? { status: { in: filter.status } }
        : {}),
    };

    // EINMAL je Abfrage, nicht je Zeile: Sonst koennte eine Liste, die ueber
    // Mitternacht gerendert wird, zwei verschiedene „heute" benutzen.
    const todayDay = today();

    const [rows, total, perStatus] = await this.prisma.$transaction([
      this.prisma.company.findMany({
        where,
        select: SHORT_SELECT,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.company.count({ where }),
      this.prisma.company.groupBy({
        by: ['status'],
        where: searchCondition,
        _count: true,
        orderBy: { status: 'asc' },
      }),
    ]);

    return {
      companies: rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        city: row.city,
        contactName: row.contactName,
        contactEmail: row.contactEmail,
        reviewDueDate: dayOrNull(row.reviewDueDate),
        lastStatusChangeAt: dayOrNull(row.lastStatusChangeAt),
        createdAt: row.createdAt.toISOString(),
        instanceStatus: row.instance?.status ?? null,
        ...openState(row.invoices, todayDay),
      })),
      total,
      page,
      perPage,
      countPerStatus: Object.fromEntries(
        perStatus.map((z) => [z.status, z._count]),
      ) as Record<CompanyStatus, number>,
    };
  }

  async detail(id: string): Promise<CompanyResponse> {
    const row = await this.prisma.company.findUnique({ where: { id } });
    if (!row) throw new CompanyNotFoundError();
    return asResponse(row as CompanyRow);
  }

  /** Die Anfragen über die Webseite, älteste zuerst. */
  async inquiries(id: string): Promise<InquiriesResponse> {
    const present = await this.prisma.company.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!present) throw new CompanyNotFoundError();
    const rows = await this.prisma.inquiry.findMany({
      where: { companyId: id },
      orderBy: { receivedAt: 'asc' },
      select: { kind: true, outcome: true, receivedAt: true },
    });
    return {
      inquiries: rows.map((z) => ({
        kind: z.kind,
        outcome: z.outcome,
        receivedAt: z.receivedAt.toISOString(),
      })),
    };
  }

  async create(
    dto: CompanyCreateDto,
    actor: Actor,
    source: InquirySource,
  ): Promise<CompanyResponse> {
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.company.create({
        data: createAfterPrisma(dto),
      });
      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.companyCreated,
          objectType: 'Company',
          objectId: created.id,
          beforeValue: null,
          afterValue: asResponse(created as CompanyRow),
          ...source,
        },
        tx,
      );
      return created;
    });
    return asResponse(row as CompanyRow);
  }

  /**
   * Ändert Stammdaten. NICHT den Status und NICHT die Ansprechpartnerin — für
   * beides gibt es eigene Endpunkte, weil beides eine systemerzeugte Notiz
   * nach sich zieht. Wäre es hier mit erlaubt, ließe sich die Notizpflicht
   * schlicht umgehen.
   *
   * Lesen und Schreiben stecken in EINER Transaktion mit Zeilensperre: sonst
   * könnte der Audit-Eintrag ein „vorher" behaupten, das zum Zeitpunkt des
   * Schreibens längst nicht mehr galt.
   */
  async update(
    id: string,
    dto: CompanyUpdateDto,
    actor: Actor,
    source: InquirySource,
  ): Promise<CompanyResponse> {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Company" WHERE "id" = ${id} FOR UPDATE`;
      const before = await tx.company.findUnique({ where: { id } });
      if (!before) throw new CompanyNotFoundError();

      // GEPRÜFT WIRD GEGEN DEN ZUSTAND NACH DER ÄNDERUNG, nicht gegen den
      // Rumpf allein: Wer nur `paymentInterval` schickt, ändert die Paarung
      // genauso wie jemand, der nur `paymentMethod` schickt. Ein Blick auf das
      // eine Feld ohne das andere übersähe die Hälfte der Fälle.
      checkPaymentPairing(
        dto.paymentInterval ?? before.paymentInterval,
        dto.paymentMethod ?? before.paymentMethod,
      );

      const after = await tx.company.update({
        where: { id },
        data: masterDataAfterPrisma(dto),
      });

      const { old, newValue } = differences(
        asResponse(before as CompanyRow),
        asResponse(after as CompanyRow),
      );
      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.companyUpdated,
          objectType: 'Company',
          objectId: id,
          beforeValue: old,
          afterValue: newValue,
          ...source,
        },
        tx,
      );
      return after;
    });
    return asResponse(row as CompanyRow);
  }

  /**
   * Statuswechsel von Hand.
   *
   * Eigener Endpunkt und kein Feld-Update: jeder Wechsel hinterlässt eine
   * systemerzeugte Notiz und einen Audit-Eintrag mit Vorher/Nachher (R6).
   */
  async statusChange(
    id: string,
    targetStatus: CompanyStatus,
    actor: Actor,
    source: InquirySource,
  ): Promise<CompanyResponse & { intakeLink: IntakeLinkSend | null }> {
    const before = await this.prisma.company.findUnique({
      where: { id },
      select: {
        status: true,
        name: true,
        contactEmail: true,
        intakeLinkSentAt: true,
      },
    });
    if (!before) throw new CompanyNotFoundError();

    /**
     * =====================================================================
     * DER AUFNAHMELINK GEHT GENAU EINMAL HINAUS [A.35]
     * =====================================================================
     *
     * Ausloeser ist der Wechsel auf `pilot_approved`. Der Riegel ist
     * `intakeLinkSentAt` und ausdruecklich NICHT der Status: Es gibt
     * keine Vorwaerts-Regel, jeder Status laesst sich auf jeden anderen
     * setzen (`StatuswechselDialog.tsx` begruendet, warum bewusst keine
     * Zustandsmaschine erfunden wurde). Ein Hin und Her zwischen Status
     * loeste die Mail sonst erneut aus.
     *
     * Das Feld wird IM SELBEN bedingten UPDATE gesetzt wie der Status —
     * dasselbe Muster wie die Quittung der Ueberpruefung ([K2]). Damit
     * koennen auch zwei gleichzeitige Wechsel nicht zwei Mails ausloesen:
     * Nur einer trifft eine Zeile.
     *
     * OHNE ADRESSE GEHT NICHTS HINAUS, und das Feld bleibt LEER. Der
     * Automatikversand ist dann noch offen, nicht verbraucht — die Karte in
     * der Verwaltung bietet ihn an, sobald eine Adresse eingetragen ist.
     */
    const linkDue =
      targetStatus === 'pilot_approved' &&
      before.intakeLinkSentAt === null &&
      (before.contactEmail ?? '').trim() !== '';

    const result = await performStatusChange(this.prisma, this.audit, {
      companyId: id,
      fromStatus: before.status,
      afterStatus: targetStatus,
      action: AUDIT_ACTION.companyStatusChanged,
      actor: actor.name,
      userId: actor.userId,
      introduction: 'Status gewechselt',
      // DAS VERLASSEN von `review_pending` IST die Quittung ([K2]).
      // Es gibt bewusst keinen eigenen Knopf „Überprüfung erledigt": die
      // Betreiberin erledigt sie, indem sie den Status weiterstellt, und
      // genau das ist der Augenblick, den der Zeitplan künftig respektieren
      // muss. Ein zweiter Knopf wäre ein zweiter Weg, denselben Sachverhalt
      // zu behaupten — und einer davon bliebe irgendwann liegen.
      extraData: {
        ...(before.status === 'review_pending'
          ? { reviewDoneAt: toDate(today()) }
          : {}),
        ...(linkDue ? { intakeLinkSentAt: new Date() } : {}),
      },
      source,
    });
    if (result === 'unchanged') {
      throw new StatusUnchangedError(before.status);
    }

    // NACH dem Statuswechsel und AUSSERHALB seiner Transaktion: Ein
    // haengender SMTP-Server darf den Wechsel nicht offen halten, und ein
    // gescheiterter Versand darf ihn nicht zurueckrollen — dieselbe
    // Abwaegung wie beim Anfrageweg.
    const send = linkDue
      ? await this.intakeSend.send(
          id,
          before.name,
          before.contactEmail,
          actor,
          true,
        )
      : null;

    return { ...(await this.detail(id)), intakeLink: send };
  }



  // --- Zahlungsdaten (hinter dem ZweitfaktorGuard) ------------------------

  /**
   * Zeigt die Zahlungsdaten — und hält den Zugriff im Nachweis fest.
   *
   * Dass hier auch das LESEN protokolliert wird, ist kein Übereifer: Bei einer
   * Bankverbindung ist der Zugriff selbst die Handlung, nach der später
   * gefragt wird ([W4]).
   */
  async paymentDetails(
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<PaymentDetailsResponse> {
    const row = await this.prisma.company.findUnique({
      where: { id },
      select: {
        id: true,
        iban: true,
        sepaMandateReference: true,
        sepaMandateDate: true,
        customAmount: true,
      },
    });
    if (!row) throw new CompanyNotFoundError();

    await this.audit.log({
      userId: actor.userId,
      actor: actor.name,
      action: AUDIT_ACTION.companyPaymentDetailsRead,
      objectType: 'Company',
      objectId: id,
      // Kein Wert, nur die Tatsache: Der Nachweis soll die Bankverbindung
      // nicht ein zweites Mal speichern.
      afterValue: { viewed: true },
      ...source,
    });
    return asPaymentDetails(row);
  }

  /** Setzt oder leert Zahlungsdaten. Nur über den geschützten Endpunkt. */
  async paymentDetailsSet(
    id: string,
    dto: PaymentDetailsDto,
    actor: Actor,
    source: InquirySource,
  ): Promise<PaymentDetailsResponse> {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Company" WHERE "id" = ${id} FOR UPDATE`;
      const before = await tx.company.findUnique({
        where: { id },
        select: {
          iban: true,
          sepaMandateReference: true,
          sepaMandateDate: true,
          customAmount: true,
        },
      });
      if (!before) throw new CompanyNotFoundError();

      const after = await tx.company.update({
        where: { id },
        data: {
          ...(dto.iban !== undefined ? { iban: dto.iban || null } : {}),
          ...(dto.sepaMandateReference !== undefined
            ? { sepaMandateReference: dto.sepaMandateReference || null }
            : {}),
          ...(dto.sepaMandateDate !== undefined
            ? {
                sepaMandateDate: dto.sepaMandateDate
                  ? toDate(dto.sepaMandateDate)
                  : null,
              }
            : {}),
          ...(dto.customAmount !== undefined
            ? { customAmount: dto.customAmount }
            : {}),
        },
        select: {
          id: true,
          iban: true,
          sepaMandateReference: true,
          sepaMandateDate: true,
          customAmount: true,
        },
      });

      // Welche Felder sich geändert haben, nicht womit: Die Werte fängt
      // ohnehin die Sperrliste des Audit-Logs ab ([W3]); hier stehen sie
      // deshalb gar nicht erst.
      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.companyPaymentDetailsUpdated,
          objectType: 'Company',
          objectId: id,
          afterValue: { changedFields: Object.keys(dto).filter(isDataField) },
          ...source,
        },
        tx,
      );
      return after;
    });
    return asPaymentDetails(row);
  }

  // --- Kontaktdaten löschen (R4: von Hand, nie automatisch) ---------------

  /**
   * Löscht die Kontaktdaten einer Organisation — der einzige Weg, hier
   * personenbezogene Daten wieder loszuwerden ([W4]).
   *
   * Vorher gab es ihn NICHT: kein `DELETE`, die Ansprechpartnerin-Felder
   * ausserhalb des PATCH-DTO, der Name serverseitig `@IsNotEmpty`. Zugleich
   * standen dieselben Kontaktdaten wörtlich in unlöschbaren Systemnotizen. Die
   * Löschung nach 24 Monaten, die das Dashboard vorschlägt, war damit technisch
   * nicht durchführbar — und ein Löschverlangen nach Art. 17 DSGVO ebenso
   * wenig.
   *
   * ANONYMISIEREN, NICHT LÖSCHEN: Der Datensatz bleibt stehen, weil Notizen
   * und Nachweise an ihm hängen (`onDelete: Restrict`) und der Statusverlauf
   * seinen Wert behält. Entfernt wird alles, was eine Person bezeichnet.
   *
   * Drei Schritte in EINER Transaktion:
   * 1. Kontaktfelder der Organisation räumen, Name durch einen Platzhalter
   *    ersetzen (`name` ist nicht nullbar).
   * 2. Notizen, die NICHT vom System verfasst sind, löschen — dort steht
   *    Freitext, auch der übermittelte aus dem Formular.
   * 3. Systemnotizen, die Namen tragen (Wechsel der Ansprechpartnerin),
   *    umschreiben. Die übrigen Systemnotizen nennen nur Status und Datum.
   */
  async contactDataDelete(
    id: string,
    confirmation: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{
    cleanedUpFields: string[];
    deletedNotes: number;
    rewrittenNotes: number;
    /** Etappe 5: anonymisierte Versandzeilen. */
    cleanedUpSendRows: number;
    /** Etappe 5: vollstaendig geloeschte Einwilligungen. */
    deletedConsents: number;
    /** Etappe 5: als Sperreintrag STEHENGEBLIEBENE Einwilligungen. */
    remainingBlockEntries: number;
  }> {
    const day = today();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Company" WHERE "id" = ${id} FOR UPDATE`;
      const before = await tx.company.findUnique({ where: { id } });
      if (!before) throw new CompanyNotFoundError();
      if (confirmation.trim() !== before.name.trim()) {
        throw new ConfirmationMatchesNotError();
      }

      const cleanedUpFields = ContactFields.filter(
        (field) => (before as unknown as Record<string, unknown>)[field] !== null,
      );

      await tx.company.update({
        where: { id },
        data: {
          ...Object.fromEntries(ContactFields.map((field) => [field, null])),
          name: `${NAME_AFTER_DELETION} (${dayReadable(day)})`,
          // Etappe 5: Die ANZEIGE des Einwilligungsstandes gehoert zur
          // Person, nicht zur Organisation. Sie steht nicht in
          // KONTAKTFELDER, weil `audit.service.spec.ts` diese Liste gegen die
          // Sperrliste des Audit-Logs haelt und der Feldname dort nicht
          // vorkommt — geraeumt wird sie trotzdem.
          newsletterConsentStatus: null,
        },
      });

      const { count: deletedNotes } = await tx.note.deleteMany({
        where: { companyId: id, bySystem: false },
      });

      const withNames = await tx.note.findMany({
        where: { companyId: id, bySystem: true },
        select: { id: true, text: true },
      });
      let rewrittenNotes = 0;
      for (const note of withNames) {
        if (!note.text.startsWith('Ansprechpartnerin ')) continue;
        await tx.note.update({
          where: { id: note.id },
          data: {
            text:
              'Ansprechpartnerin gewechselt — Namen bei der ' +
              `Kontaktdatenlöschung entfernt, ${dayReadable(day)}`,
          },
        });
        rewrittenNotes += 1;
      }

      // ---------------------------------------------------------------
      // ETAPPE 5: MailVersand und Einwilligung — und der Zielkonflikt darin
      // ---------------------------------------------------------------
      //
      // Bis hierher war die Loeschung unvollstaendig: Die Adresse der
      // Ansprechpartnerin stand weiter in jeder Versandzeile, und der
      // Wortlaut jeder verschickten Mail nannte sie beim Namen. Das war in
      // Etappe 2 als offener Punkt vermerkt und wird hier nachgeholt.
      //
      // DER ZIELKONFLIKT: „Nichts darf uebrig bleiben" steht gegen „der
      // Sperreintrag muss ueberleben". Loeschte man die Einwilligungszeile
      // einer abgemeldeten Person mit, waere sie nach dem naechsten Import
      // wieder im Verteiler — der Widerspruch waere praktisch wirkungslos,
      // und die Person bekaeme genau die Post, gegen die sie sich gewehrt hat.
      //
      // AUFGELOEST WIRD ER NACH DEM ZWECK, nicht nach dem Datentyp:
      //
      // - VERSANDZEILEN werden ANONYMISIERT, nicht geloescht. Die Zeile
      //   belegt, DASS etwas hinausging — ein Nachweis, der zur Rechnung
      //   gehoert und zehn Jahre aufzubewahren ist. Adresse und Wortlaut
      //   werden ersetzt; beides bezeichnet die Person, die Tatsache des
      //   Versands nicht.
      // - EINWILLIGUNGEN OHNE SPERRWIRKUNG (`unbestaetigt`, `bestaetigt`)
      //   werden VOLLSTAENDIG GELOESCHT. Eine Erlaubnis, die niemand mehr
      //   ausueben darf, ist kein Nachweis, sondern nur noch ein Datensatz.
      // - SPERREINTRAEGE (`abgemeldet`, `hart_abgewiesen`, `spam_gemeldet`)
      //   BLEIBEN — aber reduziert auf das, was die Sperre braucht: die
      //   Adresse und den Grund. IP, Formulartext, Quelle und beide Token
      //   fallen weg, der Bezug zur Organisation wird gekappt.
      //
      //   Dass die ADRESSE dabei stehenbleibt, ist die eigentliche Abwaegung.
      //   Sie ist der Schluessel der Sperre; ohne sie gibt es keine. Art. 17
      //   Abs. 3 DSGVO und Art. 21 Abs. 3 tragen genau das: Die Verarbeitung
      //   bleibt zulaessig, soweit sie erforderlich ist, um dem Widerspruch
      //   dauerhaft Geltung zu verschaffen. Benutzt wird der Eintrag fuer
      //   nichts anderes — er kann nur eines: verhindern.
      const consents = await tx.consent.findMany({
        where: { companyId: id },
        select: { id: true, status: true },
      });
      const consentIds = consents.map((row) => row.id);

      // Zuerst die Versandzeilen: Solange eine auf eine Einwilligung zeigt,
      // laesst sich diese nicht loeschen (`onDelete: Restrict`).
      const { count: cleanedUpSendRows } = await tx.mailDelivery.updateMany({
        where:
          consentIds.length > 0
            ? {
                OR: [
                  { companyId: id },
                  { consentId: { in: consentIds } },
                ],
              }
            : { companyId: id },
        data: {
          recipientAddress: ADDRESS_AFTER_DELETION,
          contentSnapshot: `Wortlaut bei der Kontaktdatenlöschung entfernt, ${dayReadable(day)}`,
          consentId: null,
        },
      });

      let deletedConsents = 0;
      let remainingBlockEntries = 0;
      for (const entry of consents) {
        const blocking =
          entry.status === 'unsubscribed' ||
          entry.status === 'hard_bounced' ||
          entry.status === 'spam_reported';
        if (blocking) {
          await tx.consent.update({
            where: { id: entry.id },
            data: {
              companyId: null,
              ipAtSubscription: null,
              ipAtConfirmation: null,
              confirmationToken: null,
              unsubscribeToken: null,
              origin: null,
              // DER ANLASS IST EIN FREITEXT ÜBER EINE PERSON und geht mit den
              // Kontaktdaten. Genau deshalb steht er an der Einwilligung und
              // nicht im Audit-Log: Dort gäbe es keinen Weg, ihn zu
              // entfernen. Was die Sperre trägt, ist der STATUS — der bleibt.
              blockReason: null,
              formText: BLOCK_ENTRY_NOTE,
            },
          });
          remainingBlockEntries += 1;
        } else {
          await tx.consent.delete({ where: { id: entry.id } });
          deletedConsents += 1;
        }
      }

      await writeSystemNote(
        tx,
        id,
        `Kontaktdaten gelöscht, ${dayReadable(day)}`,
        day,
      );

      // NUR DIE FELDNAMEN, niemals die Werte: Das Audit-Log hat keinen
      // Löschweg. Stünden die Daten hier, wäre die Löschung eine Behauptung.
      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.companyContactDataDeleted,
          objectType: 'Company',
          objectId: id,
          beforeValue: { cleanedUpFields },
          afterValue: {
            deletedNotes,
            rewrittenNotes,
            cleanedUpSendRows,
            deletedConsents,
            remainingBlockEntries,
            day,
          },
          ...source,
        },
        tx,
      );

      return {
        cleanedUpFields,
        deletedNotes,
        rewrittenNotes,
        cleanedUpSendRows,
        deletedConsents,
        remainingBlockEntries,
      };
    });
  }

  // --- Organisation vollständig löschen (R4: von Hand, nie automatisch) ----

  /**
   * ========================================================================
   * DIE ORGANISATION GANZ ENTFERNEN — der einzige Weg, auf dem in diesem
   * System ein Stammdatensatz verschwindet.
   * ========================================================================
   *
   * WOFÜR ES IHN GIBT. Jede Anfrage über das öffentliche Formular legt eine
   * Organisation an, jede Demo-Nutzung auch. Ohne diesen Weg sammelt sich
   * jeder Probelauf für immer im Register — und ein Register, in dem niemand
   * mehr die echten Kunden von den verworfenen Versuchen unterscheidet, ist
   * keines mehr.
   *
   * WIE ER SICH VON `contactDataDelete` UNTERSCHEIDET. Dort bleibt der
   * Datensatz stehen und wird anonymisiert, weil Belege an ihm hängen. Hier
   * gibt es diese Belege gerade NICHT — und wo nichts zu tragen ist, muss
   * auch kein Träger bleiben. Die Prüfung darauf ist die ganze Sicherung
   * dieses Weges, deshalb steht sie in derselben Transaktion wie die Löschung
   * und hinter `FOR UPDATE`: Zwischen „ist unbelastet" und „ist weg" darf
   * keine Rechnung und keine Instanz entstehen.
   *
   * WAS BLOCKIERT — und was ausdrücklich nicht:
   *
   * - INSTANZ (auch eine archivierte): blockiert. Nach R1 wird eine Instanz
   *   nie gelöscht; sie bliebe als Zeile ohne Organisation zurück.
   * - RECHNUNGEN: blockieren, auch der Entwurf. Nach R2 ist eine Rechnung
   *   unveränderlich, und schon der Entwurf trägt einen Empfängerschnappschuss.
   *   Wer ihn loswerden will, hat dafür `DELETE /invoices/:id/entwurf`.
   * - WERBLICHE MAILS: blockieren. Der Nachweis, dass eine Rundmail unter
   *   einer bestimmten Einwilligung hinausging, gehört zu R3.
   * - TRANSAKTIONSMAILS: blockieren NICHT, sie werden mitgelöscht. Das ist
   *   die eine Stelle, an der ich über die beiden von dir genannten
   *   Bedingungen hinausgehe, und zwar weil sie sonst leerliefen: Der
   *   öffentliche Anfrageweg legt bei JEDER Anfrage eine `MailVersand`-Zeile
   *   an (`public.service.ts`, Bestätigungsmail). Blockierte sie, wäre
   *   genau der Fall nicht löschbar, für den du diesen Weg willst —
   *   „Organisation nach Anfrage und Demo-Nutzung".
   * - EINWILLIGUNGEN OHNE SPERRWIRKUNG: werden mitgelöscht.
   * - SPERREINTRÄGE (`abgemeldet`, `hart_abgewiesen`, `spam_gemeldet`):
   *   werden ABGEKOPPELT, nicht gelöscht — dieselbe Abwägung wie in
   *   `contactDataDelete`. Eine Abmeldung, die mit der Testorganisation
   *   verschwindet, wäre beim nächsten Import wieder im Verteiler.
   *
   * WAS DAS AUDIT-LOG BEHÄLT — UND WAS NICHT. Der Eintrag bleibt; er ist die
   * einzige Spur, die diese Organisation je gegeben hat, und R6 kennt keinen
   * Löschweg. Er nennt den Namen aber NICHT: `saeubereFuerAudit` schwärzt
   * jedes Feld, dessen Name auf eine Person deuten könnte, und `name` steht
   * auf dieser Liste.
   *
   * Beim ersten Entwurf stand er hier drin, mit der Begründung „sonst ist das
   * Protokoll wertlos". Der Test hat ihn als «entfernt» zurückgegeben, und
   * die Schwärzung hat recht: Der Sinn der Löschung ist, dass die Angaben
   * verschwinden. Ein Protokolleintrag, der sie behält, macht sie zunichte —
   * und er hat keinen Löschweg, an dem sich das später korrigieren ließe.
   *
   * Was R6 braucht, steht ohnehin da: WER (eigene Spalte, wird nicht
   * gesäubert), WANN, WELCHES Objekt (die Kennung), und WIE VIEL daran hing.
   * Der Name geht als Rückgabewert an die Oberfläche, damit die Bestätigung
   * ihn nennen kann — dort ist er flüchtig.
   */
  async completeDelete(
    id: string,
    confirmation: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{
    name: string;
    deletedNotes: number;
    deletedPreviews: number;
    deletedSendRows: number;
    deletedConsents: number;
    detachedBlockEntries: number;
  }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Company" WHERE "id" = ${id} FOR UPDATE`;
      const before = await tx.company.findUnique({ where: { id } });
      if (!before) throw new CompanyNotFoundError();
      if (confirmation.trim() !== before.name.trim()) {
        throw new ConfirmationMatchesNotError();
      }

      // ALLE HINDERNISSE AUF EINMAL, nicht das erste. Wer drei Anläufe
      // braucht, um zu erfahren, was alles im Weg steht, hört nach dem
      // zweiten auf.
      const [instance, invoices, marketingMails] = await Promise.all([
        tx.instance.count({ where: { companyId: id } }),
        tx.invoice.count({ where: { companyId: id } }),
        tx.mailDelivery.count({
          where: { companyId: id, channel: 'marketing' },
        }),
      ]);
      const blockers: DeletionBlocker[] = [];
      if (instance > 0) blockers.push('instance');
      if (invoices > 0) blockers.push('invoices');
      if (marketingMails > 0) blockers.push('marketingMails');
      if (blockers.length > 0) {
        throw new CompanyNotDeletableError(blockers);
      }

      // REIHENFOLGE IST PFLICHT, nicht Geschmack: Jede Fremdschlüsselzeile
      // steht auf `onDelete: Restrict`. Die Organisation geht zuletzt, und
      // die Versandzeilen gehen VOR den Einwilligungen — solange eine
      // Versandzeile auf eine Einwilligung zeigt, lässt sich diese nicht
      // löschen.
      const { count: deletedNotes } = await tx.note.deleteMany({
        where: { companyId: id },
      });
      const { count: deletedPreviews } =
        await tx.instancePreview.deleteMany({ where: { companyId: id } });
      const { count: deletedSendRows } = await tx.mailDelivery.deleteMany(
        { where: { companyId: id } },
      );

      const consents = await tx.consent.findMany({
        where: { companyId: id },
        select: { id: true, status: true },
      });
      let deletedConsents = 0;
      let detachedBlockEntries = 0;
      for (const entry of consents) {
        const blocking =
          entry.status === 'unsubscribed' ||
          entry.status === 'hard_bounced' ||
          entry.status === 'spam_reported';
        if (blocking) {
          // Der Eintrag verliert die Organisation und den Freitext über die
          // Person. Was die Sperre trägt — Adresse und Status — bleibt.
          await tx.consent.update({
            where: { id: entry.id },
            data: {
              companyId: null,
              ipAtSubscription: null,
              ipAtConfirmation: null,
              origin: null,
              blockReason: null,
              formText: BLOCK_ENTRY_NOTE,
            },
          });
          detachedBlockEntries += 1;
        } else {
          await tx.consent.delete({ where: { id: entry.id } });
          deletedConsents += 1;
        }
      }

      await tx.company.delete({ where: { id } });

      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.companyDeleted,
          objectType: 'Company',
          objectId: id,
          // KEIN `name` — er würde ohnehin als «entfernt» ankommen, und ihn
          // hinzuschreiben täuschte einen Inhalt vor, den der Eintrag nicht
          // hat. Die Kennung steht in `objectId`.
          beforeValue: {
            status: before.status,
            createdAt: dayOrNull(before.createdAt),
          },
          afterValue: {
            deletedNotes,
            deletedPreviews,
            deletedSendRows,
            deletedConsents,
            detachedBlockEntries,
            day: today(),
          },
          ...source,
        },
        tx,
      );

      return {
        name: before.name,
        deletedNotes,
        deletedPreviews,
        deletedSendRows,
        deletedConsents,
        detachedBlockEntries,
      };
    });
  }

  /**
   * Wechsel der Ansprechpartnerin: der Datensatz wird ERSETZT, nicht ergänzt.
   *
   * Nicht mitgeschickte Felder werden geleert. Sonst blieben Telefonnummer
   * oder Funktion der Vorgängerin am Datensatz der Nachfolgerin stehen — eine
   * falsche Angabe, die niemand mehr als solche erkennt.
   *
   * Dabei entsteht die Notiz „Ansprechpartnerin gewechselt: Anna Berg → Tim
   * Roth, 12.03.2027". Lesen und Schreiben liegen in einer Transaktion mit
   * Zeilensperre, damit der Wortlaut der Notiz zum tatsächlich ersetzten
   * Datensatz passt und nicht zu einem, der zwischenzeitlich schon weg war.
   */
  async contactPersonChange(
    id: string,
    dto: ContactPersonChangeDto,
    actor: Actor,
    source: InquirySource,
  ): Promise<CompanyResponse> {
    const day = today();
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Company" WHERE "id" = ${id} FOR UPDATE`;
      const before = await tx.company.findUnique({
        where: { id },
        select: {
          contactName: true,
          contactEmail: true,
          contactPhone: true,
          contactRole: true,
        },
      });
      if (!before) throw new CompanyNotFoundError();

      const after = await tx.company.update({
        where: { id },
        data: {
          contactName: dto.name,
          contactEmail: dto.email ?? null,
          contactPhone: dto.phone ?? null,
          contactRole: dto.functionValue ?? null,
        },
      });

      await writeSystemNote(
        tx,
        id,
        changeText(before.contactName, dto.name, day),
        day,
      );
      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.companyContactPersonChanged,
          objectType: 'Company',
          objectId: id,
          beforeValue: before,
          afterValue: {
            contactName: after.contactName,
            contactEmail: after.contactEmail,
            contactPhone: after.contactPhone,
            contactRole: after.contactRole,
          },
          ...source,
        },
        tx,
      );
      return after;
    });
    return asResponse(row as CompanyRow);
  }
}

/**
 * Wortlaut der Notiz beim Wechsel der Ansprechpartnerin.
 *
 * Gab es vorher keine, ist es kein Wechsel — dann steht dort „Ansprechpartnerin
 * gesetzt: Tim Roth, 12.03.2027". „(keine) → Tim Roth" wäre wörtlicher, aber
 * es behauptet einen Vorgang, den es nicht gab.
 */
export function changeText(
  before: string | null,
  after: string,
  day: string,
): string {
  if (before === null || before.trim() === '') {
    return `Ansprechpartnerin gesetzt: ${after}, ${dayReadable(day)}`;
  }
  return `Ansprechpartnerin gewechselt: ${before} → ${after}, ${dayReadable(day)}`;
}

/** Nur die tatsächlich geänderten Felder — das ist das Vorher/Nachher aus R6. */
export function differences(
  before: CompanyResponse,
  after: CompanyResponse,
): { old: Record<string, unknown>; newValue: Record<string, unknown> } {
  const old: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  const beforeRaw = before as unknown as Record<string, unknown>;
  const afterRaw = after as unknown as Record<string, unknown>;
  for (const field of Object.keys(afterRaw)) {
    // Der technische Zeitstempel ändert sich bei jedem Speichern und sagt
    // über die Änderung selbst nichts aus.
    if (field === 'updatedAt') continue;
    if (beforeRaw[field] !== afterRaw[field]) {
      old[field] = beforeRaw[field];
      newValue[field] = afterRaw[field];
    }
  }
  return { old, newValue };
}

/**
 * Felder, die eine PERSON bezeichnen und bei der Kontaktdatenlöschung geräumt
 * werden. `name` steht nicht dabei: er ist nicht nullbar und wird durch einen
 * Platzhalter ersetzt.
 */
export const ContactFields = [
  'contactName',
  'contactEmail',
  'contactPhone',
  'contactRole',
  'deputyName',
  'deputyEmail',
  'deputyPhone',
  'deputyRole',
  'street',
  'houseNumber',
  'postalCode',
  'city',
  'website',
  'billingName',
  'billingStreet',
  'billingHouseNumber',
  'billingPostalCode',
  'billingCity',
  'billingEmail',
  'iban',
  'sepaMandateReference',
  'notes',
] as const;

/** Was anstelle des Namens stehenbleibt. */
export const NAME_AFTER_DELETION = 'Kontaktdaten gelöscht';

/**
 * Was anstelle der Empfaengeradresse in einer Versandzeile stehenbleibt.
 *
 * `.invalid` ist die von RFC 2606 dafuer reservierte Endung: Sie kann nie
 * jemandem gehoeren, und eine Mail dorthin kann nie ankommen.
 */
export const ADDRESS_AFTER_DELETION = 'geloescht@invalid';

/**
 * Was anstelle des Formulartextes in einem verbliebenen Sperreintrag steht.
 *
 * Der Eintrag ist ab hier KEIN Einwilligungsnachweis mehr — er ist nur noch
 * eine Sperre. Der Vermerk sagt das, damit niemand ihn spaeter fuer einen
 * Nachweis haelt.
 */
export const BLOCK_ENTRY_NOTE =
  'Kein Einwilligungsnachweis mehr — bei der Kontaktdatenlöschung auf einen ' +
  'reinen Sperreintrag reduziert. Die Adresse bleibt gespeichert, damit der ' +
  'Widerspruch wirksam bleibt (Art. 21 Abs. 3, Art. 17 Abs. 3 DSGVO).';

/** Ist das ein Datenfeld der Zahlungsdaten — und nicht der Nachweis? */
function isDataField(field: string): boolean {
  return field !== 'currentPassword' && field !== 'totpCode';
}
