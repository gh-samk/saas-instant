/**
 * Die drei Zahlen der Reiterleiste des Rundmail-Bereichs.
 *
 * Sie stehen in einer eigenen Datei, weil sie zwei Dienste zusammenfassen und
 * an keinen von beiden gehören: `VorlageService` weiss nichts von
 * Einwilligungen, `EinwilligungService` nichts von Vorlagen.
 */
export interface BroadcastCount {
  /** Vorlagen insgesamt, beide Kanäle. */
  templates: number;
  /** Adressen mit bestätigter Einwilligung — Stand jetzt. */
  confirmed: number;
  /** Adressen auf der Sperrliste. */
  blocked: number;
}
