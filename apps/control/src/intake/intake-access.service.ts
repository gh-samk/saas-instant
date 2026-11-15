import { Injectable, Logger } from '@nestjs/common';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { generateToken, hashToken } from '../common/one-time-token';
import type { DbClient } from '../prisma/db-client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ===========================================================================
 * DER EINMAL-ZUGANG ZUM AUFNAHMEFORMULAR
 * ===========================================================================
 *
 * VIERZEHN TAGE, und die Begründung ist dieselbe wie bei
 * `EINLADUNG_GUELTIG_MS` in `emergency.service.ts`: Der Link wird
 * weitergegeben — per Mail an den Vorstand, im Gespräch, in der nächsten
 * Kreissitzung. Eine kurze Frist wäre in der Praxis fast immer verstrichen,
 * und jede verstrichene Frist kostet einen Anruf.
 *
 * HÖCHSTENS EIN OFFENER ZUGANG je Organisation. Ein neuer zieht den alten
 * zurück; sonst gäbe es zwei gültige Links auf denselben Datensatz, und beim
 * Ablaufen des einen wüsste niemand, ob der andere noch geht.
 */
export const ACCESS_VALID_MS = 14 * 24 * 60 * 60 * 1000;

/** Ein frisch erzeugter Zugang. Der Klartext-Token steht NUR hier. */
export interface GeneratedAccess {
  accessId: string;
  /** Der Klartext — er verlässt den Prozess genau einmal. */
  token: string;
  expiresAt: Date;
}

/** Ein Zugang, wie ihn die Verwaltung sieht: Zustand, nie der Token. */
export interface AccessState {
  present: boolean;
  expiresAt: Date | null;
  redeemedAt: Date | null;
  lastSentAt: Date | null;
  sendCount: number;
  expired: boolean;
}

/** Ein geprüfter, noch nicht eingelöster Zugang. */
export interface CheckedAccessToken {
  accessId: string;
  companyId: string;
  /** Nur der Name — mehr zeigt das Formular nicht an. Siehe `formular`. */
  companyName: string;
}

@Injectable()
export class IntakeAccessService {
  private readonly logger = new Logger(IntakeAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Erzeugt einen Zugang und zieht einen etwaigen offenen zurück.
   *
   * `db` ist optional, damit der Automatikversand beim Statuswechsel den
   * Zugang IN DERSELBEN Transaktion anlegen kann — sonst gäbe es einen
   * Augenblick, in dem der Status schon steht und der Link noch fehlt.
   */
  async create(
    companyId: string,
    actor: string,
    userId: string | null,
    now: Date = new Date(),
    db?: DbClient,
  ): Promise<GeneratedAccess> {
    const tx = db ?? this.prisma;
    const token = generateToken();
    const expiresAt = new Date(now.getTime() + ACCESS_VALID_MS);

    // ZURÜCKZIEHEN und nicht löschen: Der Nachweis, dass es ihn gab, bleibt.
    // `revokedAt` ist ausdrücklich nicht `redeemedAt` — eine
    // Entscheidung des Systems, keine Handlung der Kundin.
    await tx.intakeAccess.updateMany({
      where: {
        companyId,
        redeemedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });

    const entry = await tx.intakeAccess.create({
      data: {
        companyId,
        tokenHash: hashToken(token),
        createdAt: now,
        expiresAt,
      },
      select: { id: true },
    });

    await this.audit.log(
      {
        userId,
        actor,
        action: AUDIT_ACTION.intakeAccessGenerated,
        objectType: 'IntakeAccess',
        objectId: entry.id,
        // NIEMALS der Token. Das Audit-Log hat keinen Löschweg.
        afterValue: { companyId, expiresAt: expiresAt.toISOString() },
      },
      db,
    );

    return { accessId: entry.id, token, expiresAt };
  }

  /**
   * Prüft einen Token, OHNE ihn zu verbrauchen.
   *
   * Liefert `null` bei unbekannt, abgelaufen, eingelöst oder zurückgezogen —
   * ALLE VIER ununterscheidbar. Wer einen fremden Token ausprobiert, soll
   * nicht erfahren, ob er nie existierte oder gerade abgelaufen ist.
   */
  async check(
    token: string,
    now: Date = new Date(),
  ): Promise<CheckedAccessToken | null> {
    const row = await this.prisma.intakeAccess.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        companyId: true,
        expiresAt: true,
        redeemedAt: true,
        revokedAt: true,
        company: { select: { name: true } },
      },
    });
    if (!row) return null;
    if (row.redeemedAt !== null) return null;
    if (row.revokedAt !== null) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;

    return {
      accessId: row.id,
      companyId: row.companyId,
      companyName: row.company.name,
    };
  }

  /**
   * Löst den Zugang ein — ATOMAR und nur einmal.
   *
   * Das bedingte `updateMany` ist der Engpass: Von zwei gleichzeitigen
   * Absenden trifft genau eines eine Zeile. Dasselbe Muster wie in
   * `emergency.service.ts` und `status-wechsel.ts`; hier braucht es kein
   * `gibFrei()`, weil der Aufruf in derselben Transaktion steht wie das
   * Schreiben — scheitert das Schreiben, rollt die Einlösung mit zurück.
   */
  async resolveA(
    db: DbClient,
    accessId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const { count } = await db.intakeAccess.updateMany({
      where: { id: accessId, redeemedAt: null },
      data: { redeemedAt: now },
    });
    return count === 1;
  }

  /** Vermerkt einen Versand des Links. Für die Karte in der Verwaltung. */
  async noteSend(
    accessId: string,
    now: Date = new Date(),
    db?: DbClient,
  ): Promise<void> {
    await (db ?? this.prisma).intakeAccess.update({
      where: { id: accessId },
      data: { lastSentAt: now, sendCount: { increment: 1 } },
    });
  }

  /**
   * Der Zustand für die Oberfläche — NIE der Token.
   *
   * Den Klartext gibt es genau einmal, beim Erzeugen. Diese Antwort sagt, ob
   * ein Zugang offen ist, bis wann und wie oft er hinausging; wer den Link
   * selbst braucht, erzeugt einen neuen.
   */
  async state(
    companyId: string,
    now: Date = new Date(),
  ): Promise<AccessState> {
    const row = await this.prisma.intakeAccess.findFirst({
      where: { companyId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        expiresAt: true,
        redeemedAt: true,
        lastSentAt: true,
        sendCount: true,
      },
    });
    if (!row) {
      return {
        present: false,
        expiresAt: null,
        redeemedAt: null,
        lastSentAt: null,
        sendCount: 0,
        expired: false,
      };
    }
    return {
      present: true,
      expiresAt: row.expiresAt,
      redeemedAt: row.redeemedAt,
      lastSentAt: row.lastSentAt,
      sendCount: row.sendCount,
      expired:
        row.redeemedAt === null &&
        row.expiresAt.getTime() <= now.getTime(),
    };
  }
}
