/**
 * Die Preisstufen der Verwaltung — als DATEN, nicht als Verzweigung im Code.
 *
 * Der Auftrag verlangt ausdrücklich konfigurierbare Werte. Der Grund ist
 * nicht Bequemlichkeit: Preise und Schwellen ändern sich, und eine Änderung,
 * die ein Deployment braucht, wird entweder verschleppt oder von Hand in der
 * Datenbank vorgenommen. Beides ist schlechter als eine Umgebungsvariable.
 *
 * BETRÄGE DURCHGEHEND IN GANZEN CENT. Der Erkundungsschritt nennt den Grund:
 * 490,00 € mal 19 % ergibt in Gleitkomma 93,09999999999999, und solche Reste
 * summieren sich zu Abweichungen, die jeder ZUGFeRD-Validator als Rechenfehler
 * meldet.
 */
export interface PriceTier {
  /** Stabiler Schlüssel, wie er in `Organisation.preisstufe` steht. */
  key: string;
  /** Was auf der Rechnung und in der Oberfläche steht. */
  label: string;
  /**
   * Obere Schwelle EINSCHLIESSLICH, gemessen an aktiven Personen.
   * `null` = nach oben offen; genau eine Stufe darf das haben, und es muss
   * die letzte sein.
   */
  maxPersons: number | null;
  /** Netto je Monat bei monatlicher Zahlweise. */
  monthlyCent: number;
  /** Netto je Halbjahr (fünfeinhalb Monatsraten, zu Gunsten der Kundin gerundet). */
  halfYearlyCent: number;
  /** Netto je Jahr bei jährlicher Zahlweise (elf Monatsraten). */
  yearlyCent: number;
  /** Einmaliges Einrichtungshonorar, netto. */
  setupCent: number;
}

/** Die vollständige Preistafel. */
export interface PriceTable {
  tiers: PriceTier[];
  /** Umsatzsteuersatz in Prozent. */
  taxRate: number;
  /**
   * Tage, über die der Durchschnitt der aktiven Personen gebildet wird.
   *
   * Der Auftrag nennt 90 Tage Messzeitraum und die Begründung gleich mit: „damit niemand
   * wegen einer einzelnen Woche über die Schwelle kippt".
   */
  averageDays: number;
  /** Zahlungsziel in Tagen ab Rechnungsdatum. */
  paymentDueDays: number;
}

/** Warum kein Stufenvorschlag zustande kam. */
export type SuggestionBlocker =
  | 'no_instance'
  | 'no_metrics'
  | 'instance_too_young';

/**
 * Was der VERTRAG der Organisation festlegt: Preisstufe und Zahlungsweise, so
 * wie die Betreiberin sie an der Organisation eingetragen hat.
 *
 * Getrennt von `tier` (aus der Messung abgeleitet): Der Vertrag ist, was
 * vereinbart wurde, die Messung ist, was die Instanz tatsächlich nutzt. Eine
 * Rechnung folgt dem Vertrag; die Messung ist nur Entscheidungshilfe.
 */
export interface ContractTerms {
  /** `Organisation.preisstufe` — `null`, wenn keine hinterlegt ist. */
  tierKey: string | null;
  /**
   * Die Stufe zu diesem Schlüssel aus der Preisliste, auch eine archivierte.
   * `null`, wenn kein Schlüssel hinterlegt ist ODER die Preisliste ihn nicht
   * (mehr) kennt — dann gibt es keinen Preis, den man anbieten dürfte.
   */
  tier: PriceTier | null;
  /** Rhythmus der Abrechnung — `null`, wenn keiner hinterlegt ist. */
  paymentInterval: 'yearly' | 'half_yearly' | 'monthly' | null;
}

/**
 * Der VORSCHLAG — R5, wörtlich: Er wird angezeigt, die Benutzerin bestätigt.
 *
 * Deshalb gibt dieser Typ auch her, WORAUS der Vorschlag entstanden ist
 * (Durchschnitt, Zahl der Messtage, Zeitraum). Ein Vorschlag, dessen Grundlage
 * man nicht sieht, ist keine Entscheidungshilfe, sondern eine Zumutung: man
 * kann ihn nur annehmen oder raten.
 */
export interface PriceSuggestion {
  /** Die vorgeschlagene Stufe — `null`, wenn die Datenlage keine hergibt. */
  tier: PriceTier | null;
  /** Was der Datenlage fehlt. Leer, wenn ein Vorschlag zustande kam. */
  blockers: SuggestionBlocker[];
  /** Durchschnitt der aktiven Personen, kaufmännisch gerundet. */
  averageActivePersons: number | null;
  /** Wie viele Tage im Zeitraum überhaupt eine Messung geliefert haben. */
  measurementDays: number;
  /** Betrachteter Zeitraum als Tagesdaten. */
  period: { from: string; until: string };
  /**
   * Abweichender Betrag der Organisation (ermäßigte Instanz), als
   * Zeichenkette in Euro — oder `null`.
   *
   * Er STICHT die Stufe: liegt er vor, ist der Vorschlag nur noch Information.
   */
  customAmount: string | null;
  /** Ab wann das Abo berechenbar ist (Instanz-Start plus 14 Tage). */
  subscriptionCalculableFrom: string | null;
  /** Ist das Abo heute schon berechenbar? */
  subscriptionCalculable: boolean;
  /**
   * Die Einrichtung ist SOFORT berechenbar — unabhängig vom Abo.
   *
   * Das ist die Pilotlogik des Auftrags: die Einrichtungsleistung ist mit dem
   * Aufsetzen der Instanz erbracht, das Abo erst nach der Pilotphase.
   */
  setupCalculable: boolean;
  /** Steht ein Einrichtungsposten schon auf einer gültigen festgeschriebenen Rechnung? Dann ist `setupCalculable` falsch. */
  setupInvoiced: boolean;
  /** Der Vertrag der Organisation — Grundlage für „Posten aus Vertrag übernehmen". */
  contract: ContractTerms;
}
