import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CONFIRMATION_VALID_HOURS } from './consent.service';

export interface CleanupResult {
  checked: number;
  deleted: number;
  /** Zeilen, die trotz Ablauf bestehen blieben (siehe `uebersprungen`). */
  skipped: number;
}

/**
 * ===========================================================================
 * DIE EINZIGE AUTOMATISCHE LÖSCHUNG IM GANZEN PROJEKT
 * ===========================================================================
 *
 * R4 lautet: nichts wird automatisch gelöscht. Löschungen sind im CRM
 * durchgehend Handlungen eines Menschen, und das aus gutem Grund — ein
 * nächtlicher Lauf, der Daten entfernt, ist der Vorgang, der am längsten
 * unbemerkt bleibt.
 *
 * HIER GILT DIE AUSNAHME, und sie ist ausdrücklich beauftragt: Eine
 * unbestätigte Eintragung wird nach 72 Stunden gelöscht.
 *
 * WARUM DIE AUSNAHME RICHTIG IST — und warum sie die Regel nicht aufweicht:
 *
 * 1. DER DATENSATZ IST NICHT UNSERER. Eine unbestätigte Eintragung entsteht
 *    ohne jeden Beleg, dass der Inhaber der Adresse davon weiss. Jeder kann
 *    jede fremde Adresse in ein Formular tippen. Was dabei entsteht, ist
 *    keine Einwilligung, sondern eine BEHAUPTUNG über eine fremde Person —
 *    und für deren Aufbewahrung gibt es keine Grundlage.
 * 2. SIE AUFZUHEBEN WÄRE DER SCHADEN, NICHT SIE ZU LÖSCHEN. Eine Sammlung
 *    unbestätigter Adressen ist genau das Verzeichnis, das nie hätte
 *    entstehen dürfen.
 * 3. ES GEHT NICHTS VERLOREN, WAS EIN NACHWEIS WÄRE. Bestätigte
 *    Einwilligungen, Abmeldungen und Stilllegungen bleiben unangetastet —
 *    sie sind der Nachweis und die Sperrliste, und die überleben alles.
 * 4. SIE IST SICHTBAR. Jeder Lauf schreibt einen Audit-Eintrag mit der Zahl
 *    der gelöschten Zeilen, jede gelöschte Zeile einen eigenen mit ihrer
 *    Kennung. Eine automatische Löschung ohne Spur wäre nicht zu verantworten.
 *
 * Die Löschung ist VOLLSTÄNDIG: keine Anonymisierung, kein Rest. Der einzige
 * Rückstand ist die Kennung im Audit-Log — sie bezeichnet niemanden.
 */
@Injectable()
export class ConsentCleanupService {
  private readonly logger = new Logger(ConsentCleanupService.name);
  /** Schützt gegen Überlappung im selben Prozess. */
  private runs = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /**
   * STÜNDLICH, nicht täglich.
   *
   * Die Frist ist eine Zusage an die Person („wird der Link nicht benutzt,
   * löschen wir die Eintragung"). Ein täglicher Lauf machte daraus je nach
   * Uhrzeit 72 bis 96 Stunden. Stündlich ist der Rest klein genug, dass die
   * Zusage stimmt, und der Lauf selbst kostet nichts: Er trifft an den
   * meisten Stunden gar keine Zeile.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'einwilligung-aufraeumen' })
  async hourlyRun(): Promise<void> {
    if (this.config.get<string>('CONTROL_CONSENT_CLEANUP', 'ja') === 'nein') {
      return;
    }
    if (this.runs) {
      this.logger.warn('Vorheriger Aufräumlauf ist noch nicht fertig.');
      return;
    }
    this.runs = true;
    try {
      await this.execute('zeitplan');
    } finally {
      this.runs = false;
    }
  }

  /**
   * Führt einen Durchgang aus. Öffentlich, damit er sich prüfen und von Hand
   * nachholen lässt — dieselbe Begründung wie beim Zeitplan aus Etappe 2.
   */
  async execute(actor: string): Promise<CleanupResult> {
    const limit = new Date(
      Date.now() - CONFIRMATION_VALID_HOURS * 60 * 60 * 1000,
    );

    const due = await this.prisma.consent.findMany({
      where: {
        status: 'unconfirmed',
        // `angemeldetAm` ist bei jeder über das Formular entstandenen Zeile
        // gesetzt. Eine ohne Zeitpunkt liesse sich nicht fristgerecht
        // löschen — sie wird deshalb bewusst NICHT angefasst und fällt im
        // Ergebnis als „übersprungen" auf.
        subscribedAt: { lt: limit },
      },
      select: { id: true, companyId: true, _count: { select: { deliveries: true } } },
    });

    let deleted = 0;
    let skipped = 0;

    for (const row of due) {
      // Eine unbestätigte Eintragung kann keine Versandzeile haben — sie
      // bekommt nichts, und die Bestätigungsmail wird bewusst nicht
      // protokolliert. Sollte doch eine existieren, hinge daran ein Nachweis
      // (`onDelete: Restrict`), und der wiegt schwerer als die Frist.
      if (row._count.deliveries > 0) {
        skipped += 1;
        this.logger.warn(
          `Einwilligung ${row.id} ist abgelaufen, hängt aber an ` +
            `${row._count.deliveries} Versandzeilen und bleibt deshalb stehen.`,
        );
        continue;
      }

      await this.prisma.$transaction(async (tx) => {
        // Der Audit-Eintrag steht VOR der Löschung und überlebt sie. Er ist
        // das Einzige, was von der Zeile bleibt — und er bezeichnet niemanden.
        await this.audit.log(
          {
            userId: null,
            actor,
            action: AUDIT_ACTION.consentUnconfirmedDeleted,
            objectType: 'Consent',
            objectId: row.id,
            afterValue: {
              reason: 'unbestaetigt_nach_stunden',
              hours: CONFIRMATION_VALID_HOURS,
            },
            ip: null,
            userAgent: null,
          },
          tx,
        );
        if (row.companyId) {
          await tx.company.update({
            where: { id: row.companyId },
            data: { newsletterConsentStatus: null },
          });
        }
        // Bedingt löschen: Wer in der Zwischenzeit bestätigt hat, wird nicht
        // mehr getroffen. Ohne die Bedingung entstünde genau hier das Rennen,
        // gegen das der Rest dieses Moduls gebaut ist.
        const { count } = await tx.consent.deleteMany({
          where: { id: row.id, status: 'unconfirmed' },
        });
        if (count === 0) {
          throw new ConfirmationCameInBetween(row.id);
        }
      }).then(
        () => {
          deleted += 1;
        },
        (exception: unknown) => {
          if (exception instanceof ConfirmationCameInBetween) {
            skipped += 1;
            return;
          }
          throw exception;
        },
      );
    }

    if (deleted > 0 || skipped > 0) {
      this.logger.log(
        `Aufräumlauf: ${deleted} unbestätigte Eintragungen gelöscht, ` +
          `${skipped} übersprungen.`,
      );
    }
    return { checked: due.length, deleted, skipped };
  }
}

/**
 * Zwischen Auswahl und Löschung wurde bestätigt. Rollt die Transaktion samt
 * ihres Audit-Eintrags zurück — es ist ja nichts gelöscht worden.
 */
class ConfirmationCameInBetween extends Error {
  constructor(readonly consentId: string) {
    super(`Einwilligung ${consentId} wurde inzwischen bestätigt.`);
  }
}
