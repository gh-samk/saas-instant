/**
 * ===========================================================================
 * DIE SECHS SCHRITTE DES AUFNAHMEFORMULARS
 * ===========================================================================
 *
 * WARUM MEHRSCHRITTIG. In einem Zug wären es rund fünfundzwanzig Felder —
 * eine Wand, vor der man abbricht. Gegliedert ist jeder Schritt eine Frage,
 * die man beantworten kann, ohne die nächste zu kennen.
 *
 * WARUM OHNE ZWISCHENSPEICHER. Der Zustand reist im Formular selbst: Jeder
 * Schritt rendert die Angaben aller vorherigen als `<input type="hidden">`
 * mit. Kein Serverspeicher, keine Sitzung, kein Cookie, kein JavaScript.
 *
 * Das ist nicht nur bequem, sondern die Bedingung des Auftrags: Wer die Seite
 * schliesst, soll nichts hinterlassen. Ein serverseitiger Zwischenstand hiesse
 * halbe Datensätze an der Organisation — genau das Problem, das
 * `vollstaendigkeit.ts` löst, nur eine Ebene früher wieder eingeführt.
 *
 * DER TOKEN BLEIBT DABEI UNANGETASTET. Kein Zwischenschritt verbraucht ihn;
 * eingelöst wird erst beim Absenden in Schritt 6, in derselben Transaktion wie
 * das Schreiben. Ein abgebrochenes Formular lässt den Link gültig.
 */

/** Ein Feld des Formulars. */
export interface Field {
  name: string;
  label: string;
  kind: 'text' | 'email' | 'tel' | 'select' | 'checkbox';
  /** Muss es beim Weitergehen ausgefüllt sein? */
  required: boolean;
  /** Für `auswahl`: die zulässigen Werte mit ihrer Beschriftung. */
  options?: readonly { value: string; text: string }[];
  /** Hilfstext unter dem Feld. */
  hint?: string;
  /** `autocomplete`-Kennung, damit der Browser sinnvoll vorschlägt. */
  autocomplete?: string;
}

export interface Step {
  /** 1-basiert, wie es auf der Seite steht („Schritt 3 von 6"). */
  number: number;
  title: string;
  introduction: string;
  fields: readonly Field[];
}

const PaymentIntervals = [
  { value: 'yearly', text: 'Jährlich — günstigster Preis' },
  { value: 'half_yearly', text: 'Halbjährlich' },
  { value: 'monthly', text: 'Monatlich — nur per Lastschrift' },
] as const;

const PaymentMethods = [
  { value: 'bank_transfer', text: 'Überweisung' },
  { value: 'direct_debit', text: 'Lastschrift' },
] as const;

/**
 * Die Schritte 1 bis 5. Schritt 6 ist die Prüfansicht und hat keine eigenen
 * Felder — er zeigt, was in den fünf davor entstanden ist.
 */
export const Steps: readonly Step[] = [
  {
    number: 1,
    title: 'Eure Organisation',
    introduction:
      'Diese Angaben stehen später auf euren Rechnungen. Der Name sollte so ' +
      'lauten wie im Register.',
    fields: [
      { name: 'name', label: 'Name der Organisation', kind: 'text', required: true, autocomplete: 'organization' },
      { name: 'legalForm', label: 'Rechtsform', kind: 'text', required: true, hint: 'z. B. eingetragene Genossenschaft, e. V., GmbH' },
      { name: 'website', label: 'Website', kind: 'text', required: false },
      { name: 'street', label: 'Straße', kind: 'text', required: true, autocomplete: 'address-line1' },
      { name: 'houseNumber', label: 'Hausnummer', kind: 'text', required: true },
      { name: 'postalCode', label: 'Postleitzahl', kind: 'text', required: true, autocomplete: 'postal-code' },
      { name: 'city', label: 'Ort', kind: 'text', required: true, autocomplete: 'address-level2' },
    ],
  },
  {
    number: 2,
    title: 'Rechnungsadresse',
    introduction:
      'Nur ausfüllen, wenn die Rechnung woandershin soll als an die Anschrift ' +
      'oben — etwa an eine Buchhaltung oder einen Trägerverein.',
    fields: [
      { name: 'billingSameAsAbove', label: 'Rechnungsadresse ist dieselbe wie oben', kind: 'checkbox', required: false },
      { name: 'billingName', label: 'Name auf der Rechnung', kind: 'text', required: false },
      { name: 'billingStreet', label: 'Straße', kind: 'text', required: false },
      { name: 'billingHouseNumber', label: 'Hausnummer', kind: 'text', required: false },
      { name: 'billingPostalCode', label: 'Postleitzahl', kind: 'text', required: false },
      { name: 'billingCity', label: 'Ort', kind: 'text', required: false },
      { name: 'billingEmail', label: 'E-Mail für Rechnungen', kind: 'email', required: false, hint: 'Leer lassen, wenn die Rechnung an die Ansprechpartnerin gehen soll.' },
    ],
  },
  {
    number: 3,
    title: 'Wer ist ansprechbar?',
    introduction:
      'Die Ansprechpartnerin bekommt die Zugangsdaten und alle Nachrichten zu ' +
      'eurer Instanz. Die Stellvertretung ist freiwillig, aber hilfreich — ' +
      'Urlaub, Wechsel, Krankheit.',
    fields: [
      { name: 'contactName', label: 'Name', kind: 'text', required: true, autocomplete: 'name' },
      { name: 'contactEmail', label: 'E-Mail', kind: 'email', required: true, autocomplete: 'email' },
      { name: 'contactPhone', label: 'Telefon', kind: 'tel', required: true, autocomplete: 'tel' },
      { name: 'contactRole', label: 'Funktion im Kreis', kind: 'text', required: false, hint: 'z. B. Kreisleitung, Vorstand' },
      { name: 'deputyName', label: 'Stellvertretung: Name', kind: 'text', required: false },
      { name: 'deputyEmail', label: 'Stellvertretung: E-Mail', kind: 'email', required: false },
      { name: 'deputyPhone', label: 'Stellvertretung: Telefon', kind: 'tel', required: false },
    ],
  },
  {
    number: 4,
    title: 'Wie wollt ihr zahlen?',
    introduction:
      'Monatlich geht nur per Lastschrift — bei zwölf Überweisungen im Jahr ' +
      'steht der Aufwand in keinem Verhältnis zum Betrag.',
    fields: [
      { name: 'paymentInterval', label: 'Rhythmus', kind: 'select', required: true, options: PaymentIntervals },
      { name: 'paymentMethod', label: 'Zahlungsart', kind: 'select', required: true, options: PaymentMethods, hint: 'Bei monatlicher Zahlung ist nur Lastschrift möglich.' },
    ],
  },
  {
    number: 5,
    title: 'SEPA-Lastschriftmandat',
    introduction:
      'Damit wir den Beitrag einziehen dürfen, brauchen wir eure ' +
      'Ermächtigung. Ihr könnt sie jederzeit widerrufen.',
    fields: [
      { name: 'accountHolder', label: 'Kontoinhaberin', kind: 'text', required: true, hint: 'Nur ausfüllen, wenn das Konto auf einen anderen Namen läuft als die Organisation — sonst denselben Namen eintragen.' },
      { name: 'iban', label: 'IBAN', kind: 'text', required: true },
      { name: 'bic', label: 'BIC', kind: 'text', required: false, hint: 'Im Inland meist nicht nötig.' },
      {
        name: 'mandate',
        // KEIN LEERER TEXT MEHR. Hier stand '' — auf der Seite blieb ein
        // Haken ohne jede Beschriftung stehen, und daneben nichts, was ihn
        // erklaerte. Gemeldet am 07.09.2026: „das versteht kein Mensch."
        //
        // Der eigentliche Mandatswortlaut steht darueber im Kasten, gebaut
        // aus `mandateText()` — derselben Funktion, aus der auch der
        // gespeicherte Nachweis entsteht. Diese Zeile ist die
        // Zustimmungserklaerung dazu, nicht ihr Ersatz.
        label:
          'Ich habe das Lastschriftmandat gelesen und erteile es hiermit. ' +
          'Ich bin berechtigt, über das angegebene Konto zu verfügen.',
        kind: 'checkbox',
        required: true,
      },
    ],
  },
];

/**
 * ===========================================================================
 * MONATLICH GEHT NUR PER LASTSCHRIFT
 * ===========================================================================
 *
 * Die Regel steht auf der Webseite, im Datenmodell (`checkPaymentPairing`)
 * und in `docs/operations/billing.md`. Im Formular fehlte sie: „Monatlich"
 * und „Überweisung" liessen sich zusammen waehlen und kamen bis zum
 * Absenden durch. Gemeldet am 07.09.2026.
 *
 * WARUM EINE PRUEFUNG UND KEINE GEKUERZTE AUSWAHLLISTE: Ohne JavaScript
 * kann sich die zweite Liste nicht aendern, wenn die erste umgestellt wird.
 * Eine Liste, die beim Laden der Seite passte und nach der Auswahl nicht
 * mehr, waere schlimmer als eine, die alles zeigt und danach erklaert,
 * was nicht zusammengeht. Der Hinweis unter dem Feld sagt es vorher, die
 * Meldung sagt es nachher.
 */
export function checkPaymentPairingInForm(
  paymentInterval: string | undefined,
  paymentMethod: string | undefined,
): { field: string; message: string } | null {
  if (paymentInterval !== 'monthly') return null;
  if (paymentMethod !== 'bank_transfer') return null;
  return {
    field: 'paymentMethod',
    message:
      'Monatlich geht nur per Lastschrift. Wählt entweder Lastschrift, ' +
      'oder stellt den Rhythmus auf halbjährlich oder jährlich um.',
  };
}

/** Die Prüfansicht. Kein eigener Schritt in `Steps` — sie hat keine Felder. */
export const CheckStep = 6;
export const STEPS_TOTAL = 6;

/**
 * Wird Schritt 5 überhaupt gezeigt?
 *
 * Nur bei Lastschrift. Wer jährlich überweist, braucht kein Mandat — ihn
 * danach zu fragen wäre eine Frage ohne Zweck, und Bankdaten ohne Zweck sind
 * Bankdaten zu viel.
 */
export function needsMandate(paymentMethod: string | undefined): boolean {
  return paymentMethod === 'direct_debit';
}

/**
 * Der nächste Schritt nach `from` — überspringt Schritt 5 ohne Lastschrift.
 *
 * Gibt `CheckStep` zurück, wenn es keinen weiteren Eingabeschritt gibt.
 */
export function nextStep(
  from: number,
  paymentMethod: string | undefined,
): number {
  if (from >= CheckStep) return CheckStep;
  const candidate = from + 1;
  if (candidate === 5 && !needsMandate(paymentMethod)) return CheckStep;
  return candidate;
}

/** Der vorherige Schritt — dieselbe Auslassung rückwärts. */
export function previousStep(
  from: number,
  paymentMethod: string | undefined,
): number {
  if (from <= 1) return 1;
  const candidate = from - 1;
  if (candidate === 5 && !needsMandate(paymentMethod)) return 4;
  return candidate;
}

/** Alle Felder aller Schritte, die für diese Zahlungsart gelten. */
export function allFields(paymentMethod: string | undefined): readonly Field[] {
  return Steps.filter(
    (s) => s.number !== 5 || needsMandate(paymentMethod),
  ).flatMap((s) => s.fields);
}
