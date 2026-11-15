import { HttpStatus } from '@nestjs/common';
import { datePlusDays, today } from '@saas-instant/shared';
import { BusinessError } from '../common/errors/business-error';
import { dayReadable } from '../common/calendar';

/**
 * ===========================================================================
 * [W1] DAS RECHNUNGSDATUM STEUERT DEN NUMMERNKREIS — UND HATTE KEINE GRENZE
 * ===========================================================================
 *
 * `assignNextNumber(tx, jahr)` nimmt das Jahr AUS DEM RECHNUNGSDATUM. Das
 * ist richtig so: Eine am 2. Januar geschriebene Rechnung mit Datum vom
 * 31. Dezember gehört in den Kreis des alten Jahres, sonst entstünde dort eine
 * Lücke.
 *
 * OHNE GRENZE IST DASSELBE FELD ABER EIN HEBEL. Gemessen und danach
 * UNLÖSCHBAR festgeschrieben: `1970-001`, `2019-001`, `2062-001`. Ein
 * Tippfehler im Jahr eröffnet dauerhaft den Nummernkreis eines fremden
 * Geschäftsjahres. Die Folgen sind nicht kosmetisch:
 *
 * - § 14 Abs. 4 Nr. 4 UStG verlangt eine fortlaufende Nummer, die EINMALIG
 *   vergeben wird. Ein zweiter, parallel laufender Kreis für 2019 verletzt das.
 * - § 146 AO und die GoBD verbieten es, ein abgeschlossenes Jahr nachzubuchen.
 * - Und das Storno macht es schlimmer: Es bekommt eine Nummer des LAUFENDEN
 *   Jahres. Im Kreis des Originals fehlt die Aufhebung dann ganz — die
 *   Forderung steht dort für immer offen.
 *
 * ES GIBT KEINEN WEG ZURÜCK. Eine festgeschriebene Rechnung ist unveränderlich
 * (R2), ihre Nummer bleibt verbraucht. Deshalb muss die Prüfung VOR der
 * Nummernvergabe stehen und nicht danach.
 *
 * DAS FENSTER IST BEWUSST WEIT: Neunzig Tage zurück decken jede
 * Nachbearbeitung eines Quartals und jeden Jahreswechsel ab; dreissig Tage
 * voraus decken die im Voraus geschriebene Jahresrechnung ab. Wer wirklich
 * weiter zurück muss, ändert die Umgebung — und trifft dabei eine bewusste
 * Entscheidung, statt sich zu vertippen.
 *
 * Nebenbei erledigt sich damit [W6]: `datePlusDays('9999-12-31', 14)` warf
 * ungefangen und wurde zu `500 interner_fehler`. Ein Datum, das so weit
 * draussen liegt, kommt jetzt gar nicht mehr bis zur Fälligkeitsrechnung.
 */

/** Vorgabe: so viele Tage darf das Rechnungsdatum zurückliegen. */
export const RETROACTIVE_DAYS_PRESET = 90;

/** Vorgabe: so viele Tage darf es in der Zukunft liegen. */
export const AHEAD_DAYS_PRESET = 30;

export interface DateWindow {
  retroactiveDays: number;
  aheadDays: number;
}

/** Das Fenster aus der Umgebung; unsinnige Werte fallen auf die Vorgabe. */
export function windowFrom(
  read: (name: string) => string | undefined,
): DateWindow {
  const number = (name: string, preset: number): number => {
    const raw = (read(name) ?? '').trim();
    if (raw === '') return preset;
    const value = Number(raw);
    // Kein stilles Abrutschen auf 0: Ein Fenster von null Tagen liesse nur den
    // heutigen Tag zu und machte jede Nachbearbeitung unmöglich.
    //
    // NACH OBEN GIBT ES KEINE GRENZE, und das ist Absicht: Der Wert schützt
    // gegen einen TIPPFEHLER im Formular, nicht gegen den Betreiber. Wer das
    // Fenster weit aufmacht, hat das ausdrücklich in die Umgebung geschrieben
    // — das ist eine Entscheidung, kein Versehen.
    return Number.isInteger(value) && value >= 1 ? value : preset;
  };
  return {
    retroactiveDays: number(
      'CONTROL_INVOICE_DATE_RETROACTIVE_DAYS',
      RETROACTIVE_DAYS_PRESET,
    ),
    aheadDays: number('CONTROL_INVOICE_DATE_AHEAD_DAYS', AHEAD_DAYS_PRESET),
  };
}

/** Das Rechnungsdatum liegt ausserhalb des zulässigen Fensters. */
export class InvoiceDateOutsideError extends BusinessError {
  constructor(date: string, earliest: string, latest: string) {
    super(
      'invoice_date_outside',
      `Das Rechnungsdatum ${dayReadable(date)} liegt ausserhalb des zulässigen ` +
        `Zeitraums (${dayReadable(earliest)} bis ${dayReadable(latest)}). ` +
        'Das Rechnungsdatum bestimmt den Nummernkreis; ein falsches Jahr ' +
        'eröffnet dauerhaft den Kreis eines fremden Geschäftsjahres und lässt ' +
        'sich nicht zurücknehmen.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { date, earliest, latest },
    );
  }
}

/**
 * Wirft, wenn das Rechnungsdatum ausserhalb des Fensters liegt.
 *
 * `stichtag` ist überschreibbar, damit sich die Grenzen prüfen lassen, ohne
 * die Uhr zu stellen.
 */
export function checkInvoiceDate(
  invoiceDate: string,
  window: DateWindow,
  cutoffDate: string = today(),
): void {
  const earliest = datePlusDays(cutoffDate, -window.retroactiveDays);
  const latest = datePlusDays(cutoffDate, window.aheadDays);
  // Tagesdatum als ISO-Zeichenkette: der lexikographische Vergleich ist
  // zugleich der chronologische. Genau dafür ist das Format gemacht.
  if (invoiceDate < earliest || invoiceDate > latest) {
    throw new InvoiceDateOutsideError(
      invoiceDate,
      earliest,
      latest,
    );
  }
}
