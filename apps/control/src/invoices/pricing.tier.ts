import type { PriceTier } from './pricing.types';

/**
 * Die Stufenzuordnung — reine Funktionen, ohne Datenbank und ohne NestJS.
 *
 * Bewusst getrennt vom Dienst: Die Frage „welche Stufe bei 30,4 Personen?" ist
 * die einzige Stelle mit einer Schwelle, und Schwellen sind der Ort, an dem
 * sich Fehler um genau eins verstecken.
 */

/**
 * Erste Stufe, deren obere Schwelle nicht überschritten ist.
 *
 * SCHWELLE EINSCHLIESSLICH: „bis 10" heißt, dass 10 noch Stufe 1 ist und erst
 * 11 in Stufe 2 fällt — genau der Wortlaut des Auftrags („bis 10 / 11–30 /
 * ab 31").
 *
 * Der Durchschnitt wird VOR dem Vergleich kaufmännisch gerundet. Sonst fiele
 * ein Durchschnitt von 10,4 in Stufe 2, obwohl an keinem einzigen Tag mehr als
 * zehn Personen aktiv waren.
 */
export function tierFor(
  averageActivePersons: number,
  tiers: PriceTier[],
): PriceTier | null {
  const rounded = Math.round(averageActivePersons);
  return (
    tiers.find((s) => s.maxPersons === null || rounded <= s.maxPersons) ?? null
  );
}

/**
 * Durchschnitt der aktiven Personen über die gelieferten Messwerte.
 *
 * ES ZÄHLEN NUR ECHTE MESSUNGEN. `Kennzahl.aktivePersonen` ist seit Etappe 3
 * nullbar, und das ist dort ausdrücklich begründet: Eine fehlgeschlagene
 * Abfrage wird gespeichert, hat aber keine Zahlen; eine 0 an dieser Stelle
 * wäre eine Falschaussage.
 *
 * Für den Preisvorschlag hat das eine unmittelbare Folge: Wer fehlgeschlagene
 * Abfragen als 0 mitzählte, zöge den Durchschnitt nach unten und schlüge eine
 * zu billige Stufe vor — eine Woche Netzstörung beim Kunden wäre ein Rabatt.
 * Deshalb gehen nur Tage mit einer tatsächlichen Zahl ein, und die Zahl der
 * Messtage wird mitgeliefert, damit eine dünne Datenlage sichtbar ist.
 */
export function averageActivePersons(
  measurements: readonly (number | null)[],
): { average: number | null; measurementDays: number } {
  const numbers = measurements.filter((value): value is number => value !== null);
  if (numbers.length === 0) return { average: null, measurementDays: 0 };
  const sum = numbers.reduce((s, value) => s + value, 0);
  return { average: sum / numbers.length, measurementDays: numbers.length };
}
