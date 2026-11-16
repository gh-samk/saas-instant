import { datePlusDays, dateStringFromDate } from '@saas-instant/shared';
import { AUDIT_ACTION } from '../../audit/audit.service';
import { urgencyFrom } from '../urgency';
import type { SourceResult, Task, TasksContext, TaskSource } from '../tasks.types';

/** Nach wie vielen Tagen ohne Meldung die Sicherung der Verwaltung als überfällig gilt. */
export const CONTROL_BACKUP_MISSING_AFTER_DAYS = 3;

const PARTS = [
  { kind: 'control', label: 'Verwaltungs-Datenbank' },
  { kind: 'invoices', label: 'Rechnungsarchiv' },
] as const;

const DAY_MS = 86_400_000;

/**
 * „SICHERUNG DER VERWALTUNG ÜBERFÄLLIG".
 *
 * Ist ein Sicherungsziel eingerichtet (Zeile `BackupTarget`), meldet der Agent
 * nach jedem gelungenen Lauf die Sicherung der Verwaltungs-Datenbank
 * (`kind: control`) und des Rechnungsarchivs (`kind: invoices`) als
 * `backup.reported` ins Audit-Log. Ist die letzte Meldung einer der beiden
 * älter als drei Tage oder fehlt sie, entsteht EINE Aufgabe.
 *
 * Wie bei den Instanz-Sicherungen ist das Signal die Stille; es gibt keinen
 * grünen Haken. Ohne eingerichtetes Ziel gibt es keine Aufgabe (dort ist
 * nichts zu erwarten). Die Quelle liest nur und löst nichts aus (R1).
 */
export const controlBackupMissing: TaskSource = {
  kind: 'control_backup_missing',

  async collect(context: TasksContext): Promise<SourceResult> {
    const target = await context.prisma.backupTarget.findUnique({
      where: { id: 'singleton' },
      select: { id: true },
    });
    if (target === null) return { tasks: [], total: 0 };

    const limit = new Date(context.now.getTime() - CONTROL_BACKUP_MISSING_AFTER_DAYS * DAY_MS);
    const overdue: { label: string; last: Date | null }[] = [];
    // `afterValue` ist verschluesselt: Der Pfadfilter in der Datenbank geht
    // nicht. Die Meldungen kommen neueste zuerst in Stuecken und werden im
    // Speicher nach `kind` ausgewertet, bis jede Art ihre juengste Meldung hat.
    const latestByKind = new Map<string, Date>();
    const BATCH = 200;
    for (let skip = 0; latestByKind.size < PARTS.length; skip += BATCH) {
      const batch = await context.prisma.auditLog.findMany({
        where: { action: AUDIT_ACTION.backupReported },
        orderBy: { timestamp: 'desc' },
        skip,
        take: BATCH,
        select: { timestamp: true, afterValue: true },
      });
      for (const entry of batch) {
        const value = entry.afterValue as { kind?: unknown } | null;
        const kind = typeof value?.kind === 'string' ? value.kind : null;
        if (kind !== null && !latestByKind.has(kind)) {
          latestByKind.set(kind, entry.timestamp);
        }
      }
      if (batch.length < BATCH) break;
    }
    for (const part of PARTS) {
      const last = latestByKind.has(part.kind)
        ? { timestamp: latestByKind.get(part.kind)! }
        : null;
      if (last === null || last.timestamp < limit) {
        overdue.push({ label: part.label, last: last?.timestamp ?? null });
      }
    }
    if (overdue.length === 0) return { tasks: [], total: 0 };

    // Fällig wurde sie an dem Tag, an dem die älteste Meldung drei Tage alt wurde;
    // fehlt eine ganz, ist sie seit heute fällig.
    const never = overdue.some((o) => o.last === null);
    const oldest = overdue
      .map((o) => o.last)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const dueAt =
      never || oldest === undefined
        ? context.todayDay
        : datePlusDays(dateStringFromDate(oldest), CONTROL_BACKUP_MISSING_AFTER_DAYS);

    const detail = overdue
      .map((o) =>
        o.last === null
          ? `${o.label}: noch nie gemeldet`
          : `${o.label}: zuletzt am ${dateStringFromDate(o.last)}`,
      )
      .join('; ');
    const task: Task = {
      kind: 'control_backup_missing',
      dueAt,
      urgency: urgencyFrom(dueAt, context.todayDay),
      title: 'Sicherung der Verwaltung überfällig',
      reason:
        `Seit mehr als ${CONTROL_BACKUP_MISSING_AFTER_DAYS} Tagen keine gemeldete Sicherung (${detail}). ` +
        'Bitte unter Einstellungen → Sicherung den Zustand des Agents und des Ziels prüfen.',
      action: {
        kind: 'company_open',
        label: 'Sicherung prüfen',
        target: '/settings?tab=backup',
      },
    };
    return { tasks: [task], total: 1 };
  },
};
