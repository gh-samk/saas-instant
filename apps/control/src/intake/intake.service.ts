import { Injectable, Logger } from '@nestjs/common';
import { today, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { isHttpUrl } from '../common/http-url';
import { writeSystemNote } from '../notes/system-note';
import { performStatusChange } from '../companies/status-change';
import { PrismaService } from '../prisma/prisma.service';
import { IssuerConfigService } from '../invoices/document/issuer.config';
import { assignNextMandateReference } from '../companies/mandate-number-sequence';
import {
  missingDetails,
  type MissingDetail,
} from '../companies/completeness';
import type { IntakeDetails } from './dto/intake.dto';
import { IntakeSendService } from './intake-send.service';
import { IntakeAccessService } from './intake-access.service';
import { mandateText } from './mandate-text';

/** Was beim Absenden herauskommt. */
export type IntakeResult =
  | { kind: 'saved' }
  /** Der Zugang war schon eingelöst — die Angaben sind bereits da. */
  | { kind: 'already_there' }
  | { kind: 'incomplete'; error: MissingDetail[] }
  /** Eine Angabe ist da, aber unzulässig (z. B. eine Website ohne http/https). */
  | { kind: 'invalid'; error: { field: string; message: string }[] };

export const WEBSITE_MESSAGE =
  'Bitte die Website mit http:// oder https:// angeben.';

@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accesses: IntakeAccessService,
    private readonly issuer: IssuerConfigService,
    private readonly send: IntakeSendService,
  ) {}

  /**
   * =======================================================================
   * DAS ABSENDEN — alles oder nichts
   * =======================================================================
   *
   * EINE TRANSAKTION für Einlösung, Mandatsreferenz, Organisation, Notiz und
   * Audit. Scheitert irgendetwas davon, ist auch der Zugang nicht eingelöst
   * und der Link weiterhin gültig. Deshalb braucht es hier kein `gibFrei()`
   * wie beim Notfall-Token: Ein Rollback nimmt die Reservierung mit.
   *
   * DIE PRÜFUNG LÄUFT VOLLSTÄNDIG NOCH EINMAL. Die Schrittprüfungen im
   * Controller sind Bequemlichkeit für die Ausfüllende, keine Zusicherung —
   * ein direkter POST auf den letzten Schritt umgeht sie alle (Regel 2).
   */
  async save(
    token: string,
    details: IntakeDetails,
    source: InquirySource,
  ): Promise<IntakeResult> {
    const checked = await this.accesses.check(token);
    if (!checked) return { kind: 'already_there' };

    const paymentMethod = details['paymentMethod'] ?? null;
    const perDirectDebit = paymentMethod === 'direct_debit';

    // Der Datensatz, wie er nach dem Schreiben aussähe — daran wird geprüft.
    const draft = {
      name: details['name'] ?? '',
      legalForm: details['legalForm'] ?? null,
      street: details['street'] ?? null,
      houseNumber: details['houseNumber'] ?? null,
      postalCode: details['postalCode'] ?? null,
      city: details['city'] ?? null,
      contactName: details['contactName'] ?? null,
      contactEmail: details['contactEmail'] ?? null,
      contactPhone: details['contactPhone'] ?? null,
      paymentInterval: (details['paymentInterval'] ?? null) as never,
      paymentMethod: (paymentMethod ?? null) as never,
      iban: perDirectDebit ? (details['iban'] ?? null) : null,
      accountHolder: perDirectDebit ? (details['accountHolder'] ?? null) : null,
      // Das Mandat gilt als erteilt, sobald das Häkchen steht — geprüft wird
      // SERVERSEITIG: `required` im Markup blockt den Browser, nicht einen
      // direkten POST.
      sepaMandateGrantedAt:
        perDirectDebit && details['mandate'] === 'ja' ? new Date() : null,
    };

    const error = missingDetails(draft);
    if (error.length > 0) return { kind: 'incomplete', error };

    // Die Website wird in der Verwaltung als Link gerendert. Ohne diese
    // Prüfung käme `javascript:…` aus dem öffentlichen Formular dorthin.
    const website = details['website'] ?? '';
    if (website !== '' && !isHttpUrl(website)) {
      return {
        kind: 'invalid',
        error: [{ field: 'website', message: WEBSITE_MESSAGE }],
      };
    }

    const day = today();
    const a = (await this.issuer.current()).issuer;

    const result = await this.prisma.$transaction(async (tx) => {
      // ZUERST einlösen: Trifft das bedingte UPDATE keine Zeile, war jemand
      // schneller, und nichts weiter darf geschehen.
      const redeemed = await this.accesses.resolveA(tx, checked.accessId);
      if (!redeemed) return 'already_there' as const;

      const mandateReference = perDirectDebit
        ? await assignNextMandateReference(tx, Number(day.slice(0, 4)))
        : null;

      // Der Wortlaut entsteht HIER, aus den Werten des Servers — nicht aus
      // dem Formular. Sonst diktierte der Absender seinen eigenen Nachweis.
      const wording =
        perDirectDebit && mandateReference
          ? mandateText({
              creditor: a.name,
              creditorId: a.creditorId,
              mandateReference,
              accountHolder: draft.accountHolder ?? draft.name,
              company: draft.name,
            })
          : null;

      await tx.company.update({
        where: { id: checked.companyId },
        data: {
          ...draft,
          website: details['website'] || null,
          contactRole: details['contactRole'] || null,
          deputyName: details['deputyName'] || null,
          deputyEmail: details['deputyEmail'] || null,
          deputyPhone: details['deputyPhone'] || null,
          ...this.billingAddress(details),
          ...(perDirectDebit
            ? {
                bic: details['bic'] || null,
                sepaMandateReference: mandateReference,
                sepaMandateDate: toDate(day),
                sepaMandateText: wording,
                sepaMandateIp: source.ip,
              }
            : {}),
          intakeCompletedAt: toDate(day),
        },
      });

      // KEIN Fremdtext in der Systemnotiz ([K1]): Sie ist unveränderlich, und
      // was ein Unbeteiligter geschickt hat, gehört nicht hinein.
      await writeSystemNote(
        tx,
        checked.companyId,
        perDirectDebit
          ? `Aufnahmeangaben über das Formular eingegangen, SEPA-Mandat ${mandateReference} erteilt`
          : 'Aufnahmeangaben über das Formular eingegangen',
        day,
      );

      await this.audit.log(
        {
          userId: null,
          actor: 'aufnahmeformular',
          action: AUDIT_ACTION.intakeReceived,
          objectType: 'Company',
          objectId: checked.companyId,
          // NIEMALS die IBAN: Das Audit-Log hat keinen Löschweg.
          //
          // DAS FELD HEISST NICHT `ibanGesetzt`. Der Säuberer des Audit-Logs
          // vergleicht Feldnamen als Teilzeichenkette; `ibanGesetzt` enthält
          // „iban" und wurde deshalb zu `«entfernt»` — nachgemessen am
          // 07.09.2026 am echten Eintrag. Damit war die eine Angabe, die das
          // Feld tragen sollte, gerade nicht mehr ablesbar: `true` und
          // `false` sahen gleich aus. Der Säuberer hat recht und bleibt, wie
          // er ist; der Feldname weicht aus.
          afterValue: {
            paymentInterval: draft.paymentInterval,
            paymentMethod: draft.paymentMethod,
            bankDetailsStored: perDirectDebit,
            ...(mandateReference ? { mandateReference } : {}),
          },
          ...source,
        },
        tx,
      );

      return { kind: 'saved' as const, mandateReference };
    });

    if (result === 'already_there') return { kind: 'already_there' };

    // NACH der Transaktion: Der Statuswechsel ist ein eigener Vorgang mit
    // eigener Systemnotiz und eigenem Audit-Eintrag, und er hat seine eigene
    // Bedingung (`fromStatus`). Ihn in dieselbe Transaktion zu ziehen hiesse,
    // zwei bedingte UPDATE ineinanderzuschachteln, deren Bedingungen
    // unabhaengig scheitern koennen.
    //
    // NUR AUS `pilot_approved`: Steht die Organisation woanders, hat
    // jemand von Hand eingegriffen, und ein automatischer Wechsel waere eine
    // Entscheidung ueber einen Fall, den das System nicht kennt.
    await performStatusChange(this.prisma, this.audit, {
      companyId: checked.companyId,
      fromStatus: 'pilot_approved',
      afterStatus: 'pilot_running',
      action: AUDIT_ACTION.companyStatusChanged,
      actor: 'aufnahmeformular',
      userId: null,
      introduction: 'Status automatisch gewechselt',
      reason: 'Aufnahmeangaben vollständig eingegangen',
      source,
    });

    // ZULETZT und ausserhalb jeder Transaktion: Die Meldung ist der dritte
    // Weg, auf dem die Betreiberin vom Eingang erfährt — nach Systemnotiz und
    // Statuswechsel. Sie scheitert leise; die Angaben stehen bereits.
    await this.send.reportReceipt(
      checked.companyId,
      draft.name,
      result.mandateReference,
    );

    return { kind: 'saved' };
  }

  /**
   * Die Rechnungsadresse — oder nichts, wenn „wie oben" angehakt ist.
   *
   * Bewusst NICHT die Anschrift hineinkopieren: Ein leeres Feld heisst „wie
   * oben" und bleibt richtig, wenn sich die Anschrift ändert. Eine Kopie
   * hätte ab dem ersten Umzug zwei Wahrheiten.
   */
  private billingAddress(details: IntakeDetails): Record<string, unknown> {
    if (details['billingSameAsAbove'] === 'ja') {
      return {
        billingName: null,
        billingStreet: null,
        billingHouseNumber: null,
        billingPostalCode: null,
        billingCity: null,
      };
    }
    return {
      billingName: details['billingName'] || null,
      billingStreet: details['billingStreet'] || null,
      billingHouseNumber: details['billingHouseNumber'] || null,
      billingPostalCode: details['billingPostalCode'] || null,
      billingCity: details['billingCity'] || null,
      billingEmail: details['billingEmail'] || null,
    };
  }
}
