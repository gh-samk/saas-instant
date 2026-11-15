import { datePlusDays, today } from '@saas-instant/shared';
import {
  windowFrom,
  checkInvoiceDate,
  RETROACTIVE_DAYS_PRESET,
  AHEAD_DAYS_PRESET,
} from './invoice-date-window';

/**
 * ===========================================================================
 * [W1] — DAS RECHNUNGSDATUM STEUERT DEN NUMMERNKREIS
 * ===========================================================================
 *
 * Gemessen und danach UNLÖSCHBAR festgeschrieben: `1970-001`, `2019-001`,
 * `2062-001`. Jeder dieser Tests fällt gegen die Fassung ohne Fenster.
 */
describe('[W1] Plausibilitätsfenster des Rechnungsdatums', () => {
  const WINDOW = windowFrom(() => undefined);
  const TODAY = today();

  it('benutzt ohne Konfiguration die Vorgaben', () => {
    expect(WINDOW).toEqual({
      retroactiveDays: RETROACTIVE_DAYS_PRESET,
      aheadDays: AHEAD_DAYS_PRESET,
    });
  });

  it('lässt den heutigen Tag zu', () => {
    expect(() => checkInvoiceDate(TODAY, WINDOW, TODAY)).not.toThrow();
  });

  it('lässt die Ränder des Fensters zu', () => {
    for (const day of [
      datePlusDays(TODAY, -WINDOW.retroactiveDays),
      datePlusDays(TODAY, WINDOW.aheadDays),
    ]) {
      expect(() => checkInvoiceDate(day, WINDOW, TODAY)).not.toThrow();
    }
  });

  /** GENAU DIE DREI JAHRE, die der Prüfer festgeschrieben bekommen hat. */
  it.each(['1970-01-01', '2019-06-30', '2062-12-31'])(
    'weist %s ab, bevor eine Nummer vergeben wird',
    (date) => {
      expect(() => checkInvoiceDate(date, WINDOW, TODAY)).toThrow(
        /rechnungsdatum/i,
      );
    },
  );

  it('nennt im Fehler die Grenzen, damit die Meldung brauchbar ist', () => {
    try {
      checkInvoiceDate('1970-01-01', WINDOW, TODAY);
      throw new Error('Es hätte werfen müssen.');
    } catch (exception) {
      const error = exception as { errorCode?: string; errorDetail?: unknown };
      expect(error.errorCode).toBe('invoice_date_outside');
      expect(error.errorDetail).toMatchObject({
        date: '1970-01-01',
        earliest: datePlusDays(TODAY, -WINDOW.retroactiveDays),
        latest: datePlusDays(TODAY, WINDOW.aheadDays),
      });
    }
  });

  it('weist einen Tag jenseits der Ränder ab', () => {
    expect(() =>
      checkInvoiceDate(
        datePlusDays(TODAY, -WINDOW.retroactiveDays - 1),
        WINDOW,
        TODAY,
      ),
    ).toThrow();
    expect(() =>
      checkInvoiceDate(
        datePlusDays(TODAY, WINDOW.aheadDays + 1),
        WINDOW,
        TODAY,
      ),
    ).toThrow();
  });

  /**
   * [W6]: `datePlusDays('9999-12-31', 14)` warf ungefangen und wurde zu
   * `500 interner_fehler`. Mit dem Fenster kommt ein solches Datum gar nicht
   * mehr bis zur Fälligkeitsrechnung — die Antwort ist ein fachlicher Fehler
   * mit Code, kein Absturz.
   */
  it('[W6] fängt ein Datum ab, das die Fälligkeitsrechnung sprengen würde', () => {
    expect(() => checkInvoiceDate('9999-12-31', WINDOW, TODAY)).toThrow(
      /rechnungsdatum/i,
    );
    // Und der Fehler ist ein FACHLICHER, kein RangeError aus der Datumsrechnung.
    try {
      checkInvoiceDate('9999-12-31', WINDOW, TODAY);
    } catch (exception) {
      expect((exception as { errorCode?: string }).errorCode).toBe(
        'invoice_date_outside',
      );
    }
  });

  describe('Konfiguration', () => {
    it('nimmt bewusst gesetzte Werte an', () => {
      const window = windowFrom((name) =>
        name === 'CONTROL_INVOICE_DATE_RETROACTIVE_DAYS' ? '400' : '5',
      );
      expect(window).toEqual({ retroactiveDays: 400, aheadDays: 5 });
    });

    it('fällt bei Unsinn auf die Vorgabe zurück statt still zu öffnen', () => {
      for (const value of ['0', '-1', 'viel', '1,5']) {
        expect(windowFrom(() => value)).toEqual({
          retroactiveDays: RETROACTIVE_DAYS_PRESET,
          aheadDays: AHEAD_DAYS_PRESET,
        });
      }
    });
  });
});
