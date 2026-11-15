/**
 * Die Angaben aus dem Aufnahmeformular, nachdem der Controller sie auf
 * bekannte Feldnamen eingegrenzt hat.
 *
 * BEWUSST KEIN class-validator-DTO. Der Weg hierher ist ein HTML-Formular
 * ohne JavaScript: Es schickt Zeichenketten, und jede fehlende Angabe muss
 * als SEITE zurückkommen, mit den übrigen Eingaben erhalten. Eine
 * `ValidationPipe`, die mit 400 und JSON antwortet, wäre für diesen Aufrufer
 * eine weisse Seite mit geschweiften Klammern.
 *
 * Geprüft wird deshalb im Dienst, gegen `vollstaendigkeit.ts` — dieselbe
 * Quelle, aus der auch die Karte in der Verwaltung liest.
 */
export interface IntakeDetails {
  readonly [field: string]: string;
}
