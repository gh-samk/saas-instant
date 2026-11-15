import { today, toDate } from '@saas-instant/shared';
import type { DbClient } from '../prisma/db-client';

/**
 * Legt eine SYSTEMERZEUGTE Notiz an (`bySystem: true`).
 *
 * Eine Stelle für alle automatischen Notizen — Statuswechsel von Hand,
 * Statuswechsel durch den Zeitplan, Wechsel der Ansprechpartnerin, erneute
 * Anfrage über das Formular. Sie sind der Verlauf, den niemand nachpflegen
 * muss, und sie sind deshalb weder bearbeitbar noch löschbar
 * (`NoteService.bearbeiten` / `.loeschen`).
 *
 * `db` ist ein Transaktions-Client, wenn die Notiz zusammen mit der Änderung
 * geschrieben werden muss, die sie beschreibt. Genau so ist es überall
 * gedacht: eine Änderung ohne ihre Notiz darf es nicht geben.
 */
export async function writeSystemNote(
  db: DbClient,
  companyId: string,
  text: string,
  day: string = today(),
): Promise<{ id: string }> {
  return db.note.create({
    data: {
      companyId,
      date: toDate(day),
      text,
      bySystem: true,
    },
    select: { id: true },
  });
}
