/**
 * Fristen der Verwaltung — an EINER Stelle, weil mehrere Module sie brauchen:
 * `ScheduleService` sucht damit die fälligen Organisationen, `tasks` und die
 * Preisprüfung (`pricing.service`) richten sich nach derselben Zahl.
 */

/** Die Testphase dauert 14 Tage ab Instanzstart, danach „Zahlend". */
export const TRIAL_DAYS = 14;
