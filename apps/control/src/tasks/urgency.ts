import { datePlusDays } from '@saas-instant/shared';
import type { Urgency } from './tasks.types';

/** Ab wie vielen Tagen vor der Fälligkeit eine Aufgabe „mittel" wird. */
export const LEAD_MEDIUM_DAYS = 7;

/**
 * Dringlichkeit aus der Fälligkeit — an EINER Stelle, damit alle Arten
 * dieselbe Skala benutzen. Überfällig ist immer „hoch", auch um einen Tag.
 */
export function urgencyFrom(
  dueAt: string,
  todayDay: string,
): Urgency {
  if (dueAt <= todayDay) return 'high';
  if (dueAt <= datePlusDays(todayDay, LEAD_MEDIUM_DAYS)) return 'medium';
  return 'low';
}
