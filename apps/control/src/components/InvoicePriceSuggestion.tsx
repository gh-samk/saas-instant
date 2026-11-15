import { Info } from 'lucide-react';
import { Card, Button } from '@saas-instant/ui';
import type { PriceSuggestion, SuggestionBlocker } from '../lib/api';
import { formatAmount, formatAmountCent } from '../utils/amount';
import { formatDate } from '../utils/date';
import { t, useT } from '../i18n';

const BLOCKER_TEXT: Record<SuggestionBlocker, string> = {
  no_instance:
    t('components.invoicePriceSuggestion.noInstance'),
  no_metrics:
    t('components.invoicePriceSuggestion.noMetrics'),
  instance_too_young:
    t('components.invoicePriceSuggestion.instanceTooYoung'),
};

/** Ein Posten, den ein Übernehmen-Klick anlegt. */
export interface AdoptionLines {
  label: string;
  unitPriceNetCent: number;
  /** UN/ECE Rec. 20 — Pauschale, Monat oder Jahr. */
  unit: 'C62' | 'MON' | 'ANN';
}

/**
 * Der Stufenvorschlag — R5, WÖRTLICH.
 *
 * `PreisService` hat keinen Schreibvorgang: Der Vorschlag setzt nirgends
 * `Organisation.preisstufe`, und diese Karte erzeugt niemals von selbst einen
 * Posten. Jeder Betrag kommt ausschließlich über einen ausdrücklichen Klick in
 * die Rechnung. Ein Vorbelegen wäre bequemer und genau die Automatik, die R5
 * ausschließt — mit Geldfolge und ohne Entscheidung.
 *
 * Ein zweiter Klick fügt einen ZWEITEN Posten hinzu, es gibt keinen „schon
 * übernommen"-Zustand: Doppelte Zeilen sieht man in der Postenliste sofort und
 * löscht sie dort. Ein gesperrter Knopf verhinderte dagegen den seltenen, aber
 * legitimen Fall zweier Monatsposten auf einer Rechnung.
 *
 * SIE STEHT VOR DER POSTENLISTE, damit die Begründung gelesen wird, bevor
 * Zahlen von Hand eingetragen werden — und sie ist LADEFEHLER-TOLERANT: Fällt
 * der Vorschlag aus, bleibt das Anlegen der Rechnung vollständig möglich.
 */
export function InvoicePriceSuggestion({
  suggestion,
  loadError,
  onAdopt,
}: {
  suggestion: PriceSuggestion | null;
  loadError: string | null;
  onAdopt: (lines: AdoptionLines) => void;
}) {
  const t = useT();
  return (
    <Card className="mt-6 p-6">
      <h2 className="mb-1 text-lg font-semibold text-text">{t('components.invoicePriceSuggestion.heading')}</h2>
      <p className="mb-3 text-sm text-leise">
        {t('components.invoicePriceSuggestion.text')}</p>

      {loadError !== null ? (
        <p role="alert" className="text-sm text-gefahr">
          {t('components.invoicePriceSuggestion.text2')}</p>
      ) : suggestion === null ? (
        <p className="text-sm text-leise">{t('components.invoicePriceSuggestion.text3')}</p>
      ) : suggestion.tier === null ? (
        <div className="rounded-lg border border-rahmen bg-flaeche-2 p-4">
          <p className="text-sm text-leise">
            {/* Nur der erste Grund: Praktisch tritt selten mehr als einer
                gleichzeitig auf — ohne Instanz entstehen gar keine Kennzahlen.
                Ein Aufzählungssatz verkomplizierte den häufigen Fall für den
                seltenen. */}
            {suggestion.blockers[0] !== undefined
              ? BLOCKER_TEXT[suggestion.blockers[0]]
              : t('components.invoicePriceSuggestion.text4')}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-rahmen bg-flaeche-2 p-4">
          <p className="text-sm text-text">
            <span className="font-medium">{suggestion.tier.label}</span> {t('components.invoicePriceSuggestion.text5')}{' '}
            <span className="ziffern-tabellarisch font-medium">
              {suggestion.averageActivePersons}
            </span>{' '}
            {t('components.invoicePriceSuggestion.text6')}{' '}
            <span className="ziffern-tabellarisch">{suggestion.measurementDays}</span>{' '}
            {t('components.invoicePriceSuggestion.text7')}<span className="ziffern-tabellarisch">
              {formatDate(suggestion.period.from)}
              {'–'}
              {formatDate(suggestion.period.until)}
            </span>
            ).
          </p>

          {/* Der abweichende Betrag STICHT die Stufe. Ihn zu verschweigen und
              trotzdem Stufenbeträge anzubieten, wäre die teuerste Sorte
              Hilfsbereitschaft. */}
          {suggestion.customAmount !== null && (
            <p className="mt-2 flex items-start gap-1.5 text-sm text-leise">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {t('components.invoicePriceSuggestion.label')}{' '}
                <span className="ziffern-tabellarisch font-medium text-text">
                  {formatAmount(suggestion.customAmount)}
                </span>
                {t('components.invoicePriceSuggestion.label2')}</span>
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {suggestion.subscriptionCalculable && (
              <>
                <Button
                  variant="secondaryGreen"
                  onClick={() =>
                    onAdopt({
                      label: suggestion.tier?.label ?? '',
                      unitPriceNetCent: suggestion.tier?.monthlyCent ?? 0,
                      unit: 'MON',
                    })
                  }
                >
                  {t('components.invoicePriceSuggestion.button')}{formatAmountCent(suggestion.tier.monthlyCent)})
                </Button>
                {/* HALBJÄHRLICH IST EIN EIGENER PREIS, keine halbe
                    Jahresrate: Die Webseite staffelt „je seltener, desto
                    günstiger" (109/199/335 gegen 209/385/649). Ihn
                    auszurechnen statt abzulesen ergäbe einen anderen Betrag
                    als den zugesagten. Die Einheit `MON` mit Menge 6 wäre
                    ebenso falsch — abgerechnet wird ein Halbjahr, nicht
                    sechs Monate. */}
                <Button
                  variant="secondaryGreen"
                  onClick={() =>
                    onAdopt({
                      label: suggestion.tier?.label ?? '',
                      unitPriceNetCent:
                        suggestion.tier?.halfYearlyCent ?? 0,
                      unit: 'C62',
                    })
                  }
                >
                  {t('components.invoicePriceSuggestion.button2')}{formatAmountCent(suggestion.tier.halfYearlyCent)})
                </Button>
                <Button
                  variant="secondaryGreen"
                  onClick={() =>
                    onAdopt({
                      label: suggestion.tier?.label ?? '',
                      unitPriceNetCent: suggestion.tier?.yearlyCent ?? 0,
                      unit: 'ANN',
                    })
                  }
                >
                  {t('components.invoicePriceSuggestion.button3')}{formatAmountCent(suggestion.tier.yearlyCent)})
                </Button>
              </>
            )}
            {suggestion.setupCalculable && (
              <Button
                variant="secondaryGreen"
                onClick={() =>
                  onAdopt({
                    label: t('components.invoicePriceSuggestion.label3', { value: suggestion.tier?.label ?? '' }),
                    unitPriceNetCent: suggestion.tier?.setupCent ?? 0,
                    unit: 'C62',
                  })
                }
              >
                {t('components.invoicePriceSuggestion.button4')}{formatAmountCent(suggestion.tier.setupCent)})
              </Button>
            )}
          </div>

          {!suggestion.subscriptionCalculable && suggestion.subscriptionCalculableFrom !== null && (
            <p className="mt-2 text-xs text-leise">
              {t('components.invoicePriceSuggestion.text8')}{' '}
              <span className="ziffern-tabellarisch">
                {formatDate(suggestion.subscriptionCalculableFrom)}
              </span>{' '}
              {t('components.invoicePriceSuggestion.text9')}</p>
          )}
        </div>
      )}
    </Card>
  );
}
