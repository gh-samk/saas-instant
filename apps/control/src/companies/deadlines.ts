import { datePlusMonths } from '../common/calendar';

/**
 * Fristen der Verwaltung — an EINER Stelle, weil zwei Module sie brauchen:
 * `CompanyService` rechnet den Überprüfungstermin beim Speichern aus,
 * `ScheduleService` sucht damit die fälligen Organisationen, und `tasks`
 * meldet, was demnächst ansteht.
 */

/** Der Pilot wird sieben Monate nach dem Beschluss überprüft. */
export const REVIEW_AFTER_MONTHS = 7;

/** Nach 90 Tagen Instanzbetrieb wird aus „Pilot läuft" „Zahlend". */
export const PILOT_TO_PAYING_AFTER_DAYS = 90;

/**
 * Der Überprüfungstermin ist ein ABGELEITETER Wert: Beschlussdatum plus sieben
 * Monate. Er wird immer gerechnet und niemals vom Client entgegengenommen —
 * sonst stünden Termin und Beschlussdatum irgendwann auseinander, und
 * niemand wüsste, welcher von beiden gilt.
 */
export function reviewDateFrom(
  pilotDecisionDate: string | null,
): string | null {
  if (pilotDecisionDate === null) return null;
  return datePlusMonths(pilotDecisionDate, REVIEW_AFTER_MONTHS);
}
