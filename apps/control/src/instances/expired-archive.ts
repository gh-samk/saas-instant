import type { Prisma } from '.prisma/control-client';
import { PURGE_DAYS, datePlusDays, toDate, today } from '@saas-instant/shared';

/** Organisation seit mindestens `PURGE_DAYS` Tagen beendet (`endedAt`); ein Neustart setzt `endedAt` zurück. */
export function endedCompany(day: string = today()): Prisma.InstanceWhereInput {
  return { company: { status: 'ended', endedAt: { not: null, lte: toDate(datePlusDays(day, -PURGE_DAYS)) } } };
}

/** Archivierte Instanzen, deren Löschfrist (`PURGE_DAYS` nach `archivedAt`) heute erreicht oder vorbei ist — gleich welchen Status die Organisation hat. */
export function dueArchive(day: string = today()): Prisma.InstanceWhereInput {
  return {
    status: 'archived',
    archivedAt: { not: null, lte: toDate(datePlusDays(day, -PURGE_DAYS)) },
  };
}

/** Gelöscht wird nur, wenn BEIDES gilt: Instanz seit 90 Tagen archiviert UND Organisation seit 90 Tagen beendet. Warnung, Coolify, Plan, Bestätigung und Löschung prüfen alle dies. */
export function expiredArchive(day: string = today()): Prisma.InstanceWhereInput {
  return { ...dueArchive(day), ...endedCompany(day) };
}

/**
 * Fällig UND Coolify-Anwendung schon gelöscht: erst dann darf der Agent den Speicher leeren
 * (Reihenfolge der Löschung). Grundlage von `purge` im Sicherungsplan und der Bestätigung.
 */
export function expiredArchiveCoolifyGone(day: string = today()): Prisma.InstanceWhereInput {
  return { ...expiredArchive(day), coolifyApplicationId: null };
}
