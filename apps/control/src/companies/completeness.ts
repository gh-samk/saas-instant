import type { Company } from '.prisma/control-client';

/**
 * ===========================================================================
 * „VOLLSTÄNDIG" WIRD ABGELESEN, NICHT GESPEICHERT
 * ===========================================================================
 *
 * Das Datenmodell kennt den Begriff nicht: Ausser `name` ist an einer
 * Organisation nichts Pflicht, und das ist richtig — eine Organisation im
 * Status `inquiry` hat naturgemäss fast nichts, und ein halb ausgefüllter
 * Datensatz ist dort der Normalfall, kein Fehler.
 *
 * Gebraucht wird der Begriff trotzdem an drei Stellen: Das Aufnahmeformular
 * muss wissen, was es verlangen soll; die Karte in der Verwaltung soll sagen,
 * was noch fehlt; und der Aufnahmeweg soll nur
 * abschließen, wenn wirklich alles da ist.
 *
 * ES WIRD NICHT GESPEICHERT — dieselbe Entscheidung wie bei „eingeladen" in
 * der Migration `einladungstabelle_entfernt`: Ein Zustand, den niemand
 * pflegen muss, kann auch nicht falsch stehen. Ein Feld `isComplete`
 * wäre ab dem ersten Handeintrag in der Verwaltung veraltet.
 */

/** Eine fehlende Angabe, mit einer Bezeichnung für Menschen. */
export interface MissingDetail {
  /** Der Feldname am Modell — für Formular und Fehlerzuordnung. */
  field: string;
  /** Wie das Feld heisst, wenn ein Mensch es liest. */
  label: string;
}

/**
 * Der Ausschnitt der Organisation, den die Prüfung braucht.
 *
 * Bewusst ein eigener Typ statt `Company`: So lässt sich die Funktion
 * auch auf ein noch nicht gespeichertes Formular anwenden — und genau das tut
 * der Aufnahmeweg, bevor er schreibt.
 */
export type ToCheck = Pick<
  Company,
  | 'name'
  | 'legalForm'
  | 'street'
  | 'houseNumber'
  | 'postalCode'
  | 'city'
  | 'contactName'
  | 'contactEmail'
  | 'contactPhone'
  | 'paymentInterval'
  | 'paymentMethod'
  | 'iban'
  | 'accountHolder'
  | 'sepaMandateGrantedAt'
>;

/** Feld für Feld, in der Reihenfolge, in der das Formular danach fragt. */
const Required: readonly { field: keyof ToCheck; label: string }[] = [
  { field: 'name', label: 'Name der Organisation' },
  { field: 'legalForm', label: 'Rechtsform' },
  { field: 'street', label: 'Straße' },
  { field: 'houseNumber', label: 'Hausnummer' },
  { field: 'postalCode', label: 'Postleitzahl' },
  { field: 'city', label: 'Ort' },
  { field: 'contactName', label: 'Name der Ansprechpartnerin' },
  { field: 'contactEmail', label: 'E-Mail der Ansprechpartnerin' },
  { field: 'contactPhone', label: 'Telefon der Ansprechpartnerin' },
  { field: 'paymentInterval', label: 'Zahlungsrhythmus' },
  { field: 'paymentMethod', label: 'Zahlungsart' },
];

/** Was zusätzlich gebraucht wird, sobald per Lastschrift gezahlt wird. */
const REQUIRED_DIRECT_DEBIT: readonly {
  field: keyof ToCheck;
  label: string;
}[] = [
  { field: 'iban', label: 'IBAN' },
  { field: 'accountHolder', label: 'Kontoinhaberin' },
  { field: 'sepaMandateGrantedAt', label: 'SEPA-Mandat' },
];

function missing(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === 'string' && value.trim() === '';
}

/**
 * Welche Angaben fehlen, damit die Organisation in die Testphase gehen
 * kann.
 *
 * DIE BANKDATEN ZÄHLEN NUR BEI LASTSCHRIFT. Wer jährlich per Überweisung
 * zahlt, braucht kein Mandat — eine IBAN von ihm zu verlangen wäre eine
 * Angabe ohne Zweck, und Bankdaten ohne Zweck sind Bankdaten zu viel.
 */
export function missingDetails(o: ToCheck): MissingDetail[] {
  const toCheck = [
    ...Required,
    ...(o.paymentMethod === 'direct_debit' ? REQUIRED_DIRECT_DEBIT : []),
  ];
  return toCheck
    .filter((entry) => missing(o[entry.field]))
    .map(({ field, label }) => ({ field: String(field), label }));
}

export function isComplete(o: ToCheck): boolean {
  return missingDetails(o).length === 0;
}

/**
 * Lastschrift ohne Bankdaten — die Regel, die `checkPaymentPairing` NICHT
 * prüft und auch nicht prüfen soll.
 *
 * Deren Kommentar begründet ausdrücklich, warum: „SIE GREIFT NUR, WENN BEIDE
 * ANGABEN DASTEHEN. Eine Organisation in der Anfrage hat oft noch keine von
 * beiden, und ein halb ausgefüllter Vertrag ist kein Fehler — er ist der
 * Normalfall am Anfang." Eine IBAN-Pflicht dort einzubauen machte aus dem
 * Normalfall einen Fehler.
 *
 * Hier ist es umgekehrt: Der Aufnahmeweg ist genau der Augenblick, in dem
 * alles dastehen soll.
 */
export function checkDirectDebitComplete(o: ToCheck): MissingDetail[] {
  if (o.paymentMethod !== 'direct_debit') return [];
  return REQUIRED_DIRECT_DEBIT.filter((entry) => missing(o[entry.field])).map(
    ({ field, label }) => ({ field: String(field), label }),
  );
}
