import type { CompanyStatus, Prisma } from '.prisma/control-client';
import { today, toDate } from '@saas-instant/shared';
import type { AuditAction, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { dayReadable } from '../common/calendar';
import { writeSystemNote } from '../notes/system-note';
import type { PrismaService } from '../prisma/prisma.service';
import { STATUS_LABEL } from './status-label';

/** Ein Statuswechsel, wie ihn Hand und Zeitplan gleichermaßen auslösen. */
export interface StatusChange {
  companyId: string;
  /**
   * ERWARTETER Ist-Stand. Er ist die Bedingung des Schreibvorgangs, nicht bloß
   * eine Information: stimmt er nicht mehr, passiert nichts.
   */
  fromStatus: CompanyStatus;
  afterStatus: CompanyStatus;
  action: AuditAction;
  actor: string;
  userId: string | null;
  /** Optionaler Zusatz für die Notiz, z. B. „14 Tage nach Instanzstart". */
  reason?: string;
  /** Vorsatz der Notiz. Von Hand „Status gewechselt", automatisch anders. */
  introduction: string;
  /**
   * Weitere Felder, die IM SELBEN bedingten Schreibvorgang gesetzt werden.
   *
   * Gebraucht für den Riegel des Aufnahmelinks (`intakeLinkSentAt`): Er darf
   * nicht in einem zweiten UPDATE landen, sonst könnten zwei gleichzeitige
   * Wechsel zwei Mails auslösen.
   */
  extraData?: Prisma.CompanyUncheckedUpdateInput;
  source?: InquirySource;
}

export type StatusChangeResult = 'changed' | 'unchanged';

/**
 * Vollzieht EINEN Statuswechsel: Status, systemerzeugte Notiz und
 * Audit-Eintrag — in einer Transaktion, oder gar nicht.
 *
 * WARUM EIN BEDINGTES UPDATE UND KEIN „lesen, prüfen, schreiben":
 * Der Zeitplan darf mehrmals am Tag laufen, und die Verwaltung kann von zwei
 * Browsern zugleich bedient werden. Ohne Bedingung schrieben zwei gleichzeitige
 * Wechsel denselben Status zweimal — und hinterließen ZWEI systemerzeugte
 * Notizen und zwei Audit-Einträge für einen einzigen fachlichen Vorgang. Die
 * Bedingung `status = vonStatus` ist der Engpass: Postgres serialisiert die
 * beiden UPDATE auf dieselbe Zeile, der zweite liest anschließend den bereits
 * geänderten Stand und trifft nichts mehr (`count === 0`).
 *
 * Die Invariante betrifft genau EINE Zeile — deshalb reicht das bedingte
 * UPDATE und es braucht kein `SELECT … FOR UPDATE`.
 *
 * Liefert `unchanged`, wenn der Wechsel schon vollzogen war. Das ist kein
 * Fehler, sondern die Idempotenz des Zeitplans.
 */
export async function performStatusChange(
  prisma: PrismaService,
  audit: AuditService,
  change: StatusChange,
): Promise<StatusChangeResult> {
  if (change.fromStatus === change.afterStatus) return 'unchanged';
  const day = today();

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.company.updateMany({
      where: { id: change.companyId, status: change.fromStatus },
      data: {
        status: change.afterStatus,
        lastStatusChangeAt: toDate(day),
        // Die Löschfrist läuft ab dem Wechsel auf `ended`; jeder Wechsel weg davon setzt sie zurück.
        endedAt: change.afterStatus === 'ended' ? toDate(day) : null,
        ...(change.extraData ?? {}),
      },
    });
    if (count === 0) return 'unchanged';

    await writeSystemNote(
      tx,
      change.companyId,
      noteText(change, day),
      day,
    );
    await audit.log(
      {
        userId: change.userId,
        actor: change.actor,
        action: change.action,
        objectType: 'Company',
        objectId: change.companyId,
        beforeValue: { status: change.fromStatus },
        afterValue: {
          status: change.afterStatus,
          lastStatusChangeAt: day,
          ...(change.reason ? { reason: change.reason } : {}),
        },
        ip: change.source?.ip ?? null,
        userAgent: change.source?.userAgent ?? null,
      },
      tx,
    );
    return 'changed';
  });
}

/** „Status gewechselt: Anfrage → Testphase, 31.08.2026 (14 Tage nach Instanzstart)" */
export function noteText(change: StatusChange, day: string): string {
  const core =
    `${change.introduction}: ${STATUS_LABEL[change.fromStatus]} → ` +
    `${STATUS_LABEL[change.afterStatus]}, ${dayReadable(day)}`;
  return change.reason ? `${core} (${change.reason})` : core;
}
