import type { Issuer } from './issuer.config';

/**
 * DAS DOKUMENTMODELL — die Zwischenform zwischen Datenbankzeile und Ausgabe.
 *
 * Es entsteht AUSSCHLIESSLICH aus dem Schnappschuss der festgeschriebenen
 * Rechnung, niemals aus der Organisation. Das ist der Punkt, an dem R2
 * praktisch wird: Ein Renderer, der eine Relation lesen könnte, würde eine
 * Rechnung von 2026 im Jahr 2031 mit der Adresse von 2031 drucken.
 *
 * Übernommen aus `tools/invoice-renderer/daten/beispielrechnung.mjs`, mit
 * Typen versehen. Die Feldnamen bleiben, damit sich die Ausgabe dieses Moduls
 * mit der belegten Fassung des Erkundungsschritts vergleichen lässt.
 */
export interface DocumentLine {
  /** Positionsnummer als Zeichenkette — so verlangt es CII (BT-126). */
  row: string;
  label: string;
  description?: string;
  quantity: number;
  /** UN/ECE Rec. 20, z. B. `C62`. */
  unit: string;
  unitPriceCent: number;
  netCent: number;
  taxCategory: string;
  taxRate: number;
  /** BT-120 der Position; nur für E/AE/K/G/O. */
  taxExemptionReason?: string;
  period?: { from: string; until: string };
}

export interface DocumentTaxShare {
  category: string;
  record: number;
  /** BT-120. */
  exemptionReason?: string;
  basisCent: number;
  taxCent: number;
}

export interface DocumentRecipient {
  name: string;
  address: { street: string; postalCode: string; city: string; country: string };
  email?: string;
  /** BT-48, Umsatzsteuer-Identifikationsnummer der Empfängerin. */
  vatId?: string;
  /** BT-49 mit Schema (`EM`, `0204`, …). */
  electronicAddress?: { id: string; scheme: string };
  buyerType?: 'business' | 'authority' | 'consumer';
}

/** Lastschrift: Angaben für BG-19 (BT-89, BT-90, BT-91). */
export interface DocumentDirectDebit {
  /** BT-89 Mandatsreferenz. */
  mandateReference: string;
  /** BT-90 Gläubiger-Identifikationsnummer. */
  creditorId: string;
  /** BT-91 Konto der Zahlerin; im Schnappschuss nicht enthalten, daher optional. */
  debtorIban?: string;
}

/** Ausgabeprofil der CII-Datei. */
export type CiiProfile = 'EN16931' | 'XRECHNUNG';

export interface InvoiceDocument {
  number: string;
  invoiceDate: string;
  dueAt: string;
  currency: string;
  servicePeriod: { from: string; until: string };
  deliveryDate: string;
  /**
   * Fallback für BT-10, wenn die Empfängerin keine Käuferreferenz
   * (Leitweg-ID) hat: die eigene Rechnungsnummer.
   */
  orderReference: string;
  /** BT-10: Leitweg-ID bzw. Käuferreferenz der Empfängerin (Schnappschuss). */
  buyerReference?: string;
  /** UNTDID 4461: `58` Überweisung (Vorgabe) oder `59` Lastschrift. */
  paymentMeansCode?: string;
  directDebit?: DocumentDirectDebit;
  issuer: Issuer;
  recipient: DocumentRecipient;
  lines: DocumentLine[];
  taxBreakdown: DocumentTaxShare[];
  sumNetCent: number;
  sumTaxCent: number;
  sumGrossCent: number;
  prepaidCent: number;
  paymentAmountCent: number;
  paymentTerm: string;
  hint: string;
  /**
   * Der Einleitungssatz der Betreiberin, über den Posten.
   *
   * Er stammt aus dem Entwurf und ist mit dem Festschreiben unveränderlich
   * wie jede andere Angabe des Belegs (R2). Fehlt er, steht dort nichts —
   * keine Ersatzformel.
   */
  introduction?: string;
  /** Ihr Zahlungshinweis, unter dem Summenblock. */
  paymentNote?: string;
  /** Steht auf einer Stornorechnung: worauf sie sich bezieht. */
  cancellationNote?: string;
}
