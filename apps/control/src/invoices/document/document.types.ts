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
  period?: { from: string; until: string };
}

export interface DocumentTaxShare {
  category: string;
  record: number;
  basisCent: number;
  taxCent: number;
}

export interface DocumentRecipient {
  name: string;
  address: { street: string; postalCode: string; city: string; country: string };
  email?: string;
}

export interface InvoiceDocument {
  number: string;
  invoiceDate: string;
  dueAt: string;
  currency: string;
  servicePeriod: { from: string; until: string };
  deliveryDate: string;
  /** BT-10. Bei uns die eigene Rechnungsnummer als Zeichen der Kundin. */
  orderReference: string;
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
