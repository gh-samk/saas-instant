import { Injectable } from '@nestjs/common';
import { dateStringFromDate, today, toDate } from '@saas-instant/shared';
import { AUDIT_ACTION, AuditService } from '../audit/audit.service';
import type { InquirySource } from '../common/inquiry-source';
import { CompanyNotFoundError } from '../companies/company.errors';
import type { Actor } from '../companies/company.service';
import { PrismaService } from '../prisma/prisma.service';
import type { NoteCreateDto, NoteUpdateDto } from './dto/note.dto';
import { NoteNotFoundError, NoteBySystemError } from './note.errors';

/**
 * Eine Notiz, wie sie über die API geht.
 *
 * `date` ist das FACHLICHE Tagesdatum `YYYY-MM-DD` (Regel 1 der Projektkonventionen),
 * `createdAt` der technische Zeitstempel des Schreibvorgangs. Beides gehört
 * hinaus: das Datum zum Anzeigen, der Zeitstempel, damit die Oberfläche
 * dieselbe Reihenfolge herstellen kann wie der Server.
 */
export interface NoteResponse {
  id: string;
  companyId: string;
  date: string;
  text: string;
  bySystem: boolean;
  createdAt: string;
}

@Injectable()
export class NoteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Chronologischer Verlauf einer Organisation, das Neueste zuerst.
   *
   * Zweite Sortierung nach `consequence`: innerhalb eines Tages entscheidet die
   * Reihenfolge des Schreibens. Vorher stand dort `id DESC` — eine zufällige
   * UUID —, und genau der häufigste Fall wurde dadurch falsch dargestellt:
   * Statuswechsel und Wechsel der Ansprechpartnerin passieren am selben Tag,
   * werden beide vom System geschrieben, und die spätere Änderung stand mit
   * gleicher Wahrscheinlichkeit über wie unter der früheren.
   *
   * NICHT nach `createdAt`: das löst auf Millisekunden auf, und zwei Notizen
   * derselben Millisekunde sind kein Sonderfall — der öffentliche Anfrageweg
   * schreibt zwei Notizen in einer Transaktion. Dann war die Reihenfolge
   * wieder offen ([W9]). Eine Sequenz kann nicht kollidieren.
   */
  async history(companyId: string): Promise<NoteResponse[]> {
    await this.checkCompany(companyId);
    const rows = await this.prisma.note.findMany({
      where: { companyId },
      orderBy: [{ date: 'desc' }, { sequence: 'desc' }],
    });
    return rows.map(asNoteResponse);
  }

  async create(
    dto: NoteCreateDto,
    actor: Actor,
    source: InquirySource,
  ): Promise<NoteResponse> {
    await this.checkCompany(dto.companyId);
    const day = dto.date ?? today();

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.note.create({
        data: {
          companyId: dto.companyId,
          date: toDate(day),
          text: dto.text,
          // Von Hand erfasst — und damit später auch änderbar.
          bySystem: false,
        },
      });
      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.noteCreated,
          objectType: 'Note',
          objectId: created.id,
          beforeValue: null,
          afterValue: {
            companyId: created.companyId,
            date: day,
            text: created.text,
          },
          ...source,
        },
        tx,
      );
      return created;
    });
    return asNoteResponse(row);
  }

  /** Ändert eine SELBST ERFASSTE Notiz. Systemnotizen weist der Server ab. */
  async update(
    id: string,
    dto: NoteUpdateDto,
    actor: Actor,
    source: InquirySource,
  ): Promise<NoteResponse> {
    const row = await this.prisma.$transaction(async (tx) => {
      const before = await tx.note.findUnique({ where: { id } });
      if (!before) throw new NoteNotFoundError();
      if (before.bySystem) throw new NoteBySystemError();

      const after = await tx.note.update({
        where: { id },
        data: {
          ...(dto.text !== undefined ? { text: dto.text } : {}),
          ...(dto.date !== undefined ? { date: toDate(dto.date) } : {}),
        },
      });
      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.noteUpdated,
          objectType: 'Note',
          objectId: id,
          beforeValue: {
            date: dateStringFromDate(before.date),
            text: before.text,
          },
          afterValue: {
            date: dateStringFromDate(after.date),
            text: after.text,
          },
          ...source,
        },
        tx,
      );
      return after;
    });
    return asNoteResponse(row);
  }

  /**
   * Löscht eine SELBST ERFASSTE Notiz.
   *
   * Kein Widerspruch zu R4 („nichts wird automatisch gelöscht"): das hier ist
   * ausdrücklich von Hand ausgelöst. Automatisch löscht in diesem System
   * nichts und niemand.
   */
  async delete(
    id: string,
    actor: Actor,
    source: InquirySource,
  ): Promise<{ deleted: true }> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.note.findUnique({ where: { id } });
      if (!before) throw new NoteNotFoundError();
      if (before.bySystem) throw new NoteBySystemError();

      await tx.note.delete({ where: { id } });
      await this.audit.log(
        {
          userId: actor.userId,
          actor: actor.name,
          action: AUDIT_ACTION.noteDeleted,
          objectType: 'Note',
          objectId: id,
          beforeValue: {
            companyId: before.companyId,
            date: dateStringFromDate(before.date),
            text: before.text,
          },
          afterValue: null,
          ...source,
        },
        tx,
      );
    });
    return { deleted: true };
  }

  private async checkCompany(companyId: string): Promise<void> {
    const present = await this.prisma.company.count({
      where: { id: companyId },
    });
    if (present === 0) throw new CompanyNotFoundError();
  }
}

export function asNoteResponse(row: {
  id: string;
  companyId: string;
  date: Date;
  text: string;
  bySystem: boolean;
  createdAt: Date;
}): NoteResponse {
  return {
    id: row.id,
    companyId: row.companyId,
    date: dateStringFromDate(row.date),
    text: row.text,
    bySystem: row.bySystem,
    // Technischer Zeitstempel, deshalb ISO — kein Tagesdatum.
    createdAt: row.createdAt.toISOString(),
  };
}
