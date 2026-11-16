import type { ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { ChevronDown, Info } from 'lucide-react';
import { Card, Button } from '@saas-instant/ui';
import type { PaymentInterval, PriceSuggestion, SuggestionBlocker } from '../lib/api';
import { TEXT_BUTTON_ACTION } from '../lib/styles';
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
  /** Stufe, aus der der Posten stammt; das Etikett setzt der Server aus der Preisliste. */
  priceTierKey: string;
}

/**
 * Die Posten, die „Posten aus Vertrag übernehmen" anlegt — aus Stufe und
 * Zahlungsweise, die an der ORGANISATION stehen, nicht aus der Messung.
 *
 * - Mit Stufe, Zahlungsweise und berechenbarem Abo: der Abo-Posten im Takt des
 *   Vertrags (monatlich `MON`, halbjährlich `C62`, jährlich `ANN` — Begründung
 *   bei den Knöpfen der Messung weiter unten).
 * - Sonst, wenn die Einrichtung berechenbar ist: nur der Einrichtungsposten.
 *   Das ist der Fall „Pilotphase": das Abo beginnt erst nach 90 Tagen, die
 *   Einrichtung ist sofort berechenbar. Der Knopf bleibt also nutzbar, auch
 *   wenn nur dieser eine Posten fehlt.
 * - Ohne Stufe in der Preisliste: nichts. Ein Preis, den niemand vereinbart
 *   hat, wird nicht angeboten (R5).
 *
 * Mit abweichendem Betrag gibt es keine Vertragsposten: Er sticht die Stufe,
 * und der vereinbarte Betrag gehört von Hand in den Posten.
 */
export function contractLines(
  suggestion: PriceSuggestion,
): { lines: AdoptionLines[]; interval: PaymentInterval | null } {
  const contract = suggestion.contract;
  const tier = contract?.tier ?? null;
  if (tier === null || suggestion.customAmount !== null) {
    return { lines: [], interval: contract?.paymentInterval ?? null };
  }
  const interval = contract?.paymentInterval ?? null;
  if (interval !== null && suggestion.subscriptionCalculable) {
    const subscription: Record<PaymentInterval, AdoptionLines> = {
      monthly: {
        label: tier.label,
        unitPriceNetCent: tier.monthlyCent,
        unit: 'MON',
        priceTierKey: tier.key,
      },
      half_yearly: {
        label: tier.label,
        unitPriceNetCent: tier.halfYearlyCent,
        unit: 'C62',
        priceTierKey: tier.key,
      },
      yearly: {
        label: tier.label,
        unitPriceNetCent: tier.yearlyCent,
        unit: 'ANN',
        priceTierKey: tier.key,
      },
    };
    return { lines: [subscription[interval]], interval };
  }
  if (suggestion.setupCalculable) {
    return {
      lines: [
        {
          label: t('components.invoicePriceSuggestion.label3', { value: tier.label }),
          unitPriceNetCent: tier.setupCent,
          unit: 'C62',
          priceTierKey: tier.key,
        },
      ],
      interval,
    };
  }
  return { lines: [], interval };
}

const INTERVAL_LABEL: Record<PaymentInterval, string> = {
  monthly: t('components.invoicePriceSuggestion.intervalMonthly'),
  half_yearly: t('components.invoicePriceSuggestion.intervalHalfYearly'),
  yearly: t('components.invoicePriceSuggestion.intervalYearly'),
};

/**
 * Link zur Organisation, Reiter „Kontakt & Vertrag". Außerhalb eines Routers
 * (Komponententests) ein gewöhnlicher Anker — in der Anwendung immer `Link`,
 * damit der Entwurf nicht neu lädt.
 */
function CompanyContractLink({ companyId, children }: { companyId: string; children: ReactNode }) {
  const inRouter = useInRouterContext();
  const target = `/companies/${encodeURIComponent(companyId)}?tab=contract`;
  const className = `text-sm ${TEXT_BUTTON_ACTION}`;
  return inRouter ? (
    <Link to={target} className={className}>
      {children}
    </Link>
  ) : (
    <a href={target} className={className}>
      {children}
    </a>
  );
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
  companyId,
  onAdopt,
}: {
  suggestion: PriceSuggestion | null;
  loadError: string | null;
  /** Für den Link „Preisstufe an der Organisation festlegen". */
  companyId: string;
  /** Ein Posten je Klick; „aus Vertrag" kann mehrere auf einmal liefern. */
  onAdopt: (lines: AdoptionLines | AdoptionLines[]) => void;
}) {
  const t = useT();
  const contract = suggestion === null ? null : contractLines(suggestion);
  const tierSet = suggestion?.contract?.tierKey != null;
  return (
    // KEIN Außenabstand oben: Die Karte steht in der Hauptspalte als Erstes,
    // und die rechte Spalte („Rechnungsdaten") beginnt auf derselben Höhe. Ein
    // `mt-6` schob die linke Spalte tiefer und brach die Leserichtung.
    <Card className="p-[18px]">
      <h2 className="mb-1 text-lg font-semibold text-text">{t('components.invoicePriceSuggestion.heading')}</h2>
      <p className="mb-3 text-sm text-leise">
        {t('components.invoicePriceSuggestion.text')}</p>

      {loadError !== null ? (
        <p role="alert" className="text-sm text-gefahr">
          {t('components.invoicePriceSuggestion.text2')}</p>
      ) : suggestion === null ? (
        <p className="text-sm text-leise">{t('components.invoicePriceSuggestion.text3')}</p>
      ) : (
        <>
          {/* DER VERTRAG ZUERST: Er ist, was vereinbart wurde. Die Messung
              darunter ist Entscheidungshilfe und für den Sonderfall da. */}
          <div className="rounded-lg border border-rahmen bg-flaeche-2 p-4">
            {!tierSet ? (
              <>
                <p className="text-sm text-leise">
                  {suggestion.tier !== null
                    ? t('components.invoicePriceSuggestion.noContractTierMeasured', {
                        tier: suggestion.tier.label,
                      })
                    : t('components.invoicePriceSuggestion.noContractTier')}
                </p>
                <div className="mt-2">
                  <CompanyContractLink companyId={companyId}>
                    {t('components.invoicePriceSuggestion.setContractTier')}
                  </CompanyContractLink>
                </div>
              </>
            ) : suggestion.contract?.tier == null ? (
              <>
                <p className="text-sm text-leise">
                  {t('components.invoicePriceSuggestion.unknownContractTier', {
                    key: suggestion.contract?.tierKey ?? '',
                  })}
                </p>
                <div className="mt-2">
                  <CompanyContractLink companyId={companyId}>
                    {t('components.invoicePriceSuggestion.checkContractTier')}
                  </CompanyContractLink>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-text">
                  <span className="font-medium">{suggestion.contract.tier.label}</span>
                  {contract !== null && contract.interval !== null && (
                    <> · {INTERVAL_LABEL[contract.interval]}</>
                  )}
                </p>
                {suggestion.customAmount !== null ? (
                  <p className="mt-2 flex items-start gap-1.5 text-sm text-leise">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>
                      {t('components.invoicePriceSuggestion.label')}{' '}
                      <span className="ziffern-tabellarisch font-medium text-text">
                        {formatAmount(suggestion.customAmount)}
                      </span>
                      {t('components.invoicePriceSuggestion.label2')}</span>
                  </p>
                ) : contract !== null && contract.lines.length > 0 ? (
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Button
                      variant="secondaryGreen"
                      onClick={() => onAdopt(contract.lines)}
                    >
                      {t('components.invoicePriceSuggestion.adoptContract')}
                    </Button>
                    <span className="ziffern-tabellarisch min-w-0 text-sm text-leise">
                      {contract.lines
                        .map((l) => `${l.label} · ${formatAmountCent(l.unitPriceNetCent)}`)
                        .join(' + ')}{' '}
                      {t('components.invoicePriceSuggestion.net')}
                    </span>
                  </div>
                ) : null}
                {suggestion.customAmount === null && contract !== null && contract.interval === null && (
                  <div className="mt-2">
                    <CompanyContractLink companyId={companyId}>
                      {t('components.invoicePriceSuggestion.setPaymentInterval')}
                    </CompanyContractLink>
                  </div>
                )}
                {suggestion.customAmount === null &&
                  !suggestion.subscriptionCalculable &&
                  suggestion.subscriptionCalculableFrom !== null && (
                    <p className="mt-2 text-sm text-leise">
                      {t('components.invoicePriceSuggestion.text8')}{' '}
                      <span className="ziffern-tabellarisch">
                        {formatDate(suggestion.subscriptionCalculableFrom)}
                      </span>{' '}
                      {t('components.invoicePriceSuggestion.text9')}</p>
                  )}
              </>
            )}
            {suggestion.setupInvoiced === true && (
              <p className="mt-2 text-sm text-leise">
                {t('components.invoicePriceSuggestion.setupDone')}
              </p>
            )}
          </div>

          {/* MESSUNG UND EINZELNE POSTEN: eingeklappt, wenn der Vertrag den
              Weg schon anbietet; offen, wenn nicht — dann sind die Knöpfe
              darin der einzige Weg zu einem Vorschlag. */}
          <details className="group mt-3" open={!tierSet || undefined}>
            <summary className={`flex w-fit cursor-pointer list-none items-center gap-1 text-sm [&::-webkit-details-marker]:hidden ${TEXT_BUTTON_ACTION}`}>
              <ChevronDown
                className="h-4 w-4 transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
              {t('components.invoicePriceSuggestion.measurement')}
            </summary>
            <div className="mt-3">
              {suggestion.tier === null ? (
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
                <span className="text-leise">{t('components.invoicePriceSuggestion.measured')}</span>{' '}
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
                          priceTierKey: suggestion.tier?.key ?? '',
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
                          priceTierKey: suggestion.tier?.key ?? '',
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
                          priceTierKey: suggestion.tier?.key ?? '',
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
                        priceTierKey: suggestion.tier?.key ?? '',
                      })
                    }
                  >
                    {t('components.invoicePriceSuggestion.button4')}{formatAmountCent(suggestion.tier.setupCent)})
                  </Button>
                )}
              </div>

              {!suggestion.subscriptionCalculable && suggestion.subscriptionCalculableFrom !== null && (
                <p className="mt-2 text-sm text-leise">
                  {t('components.invoicePriceSuggestion.text8')}{' '}
                  <span className="ziffern-tabellarisch">
                    {formatDate(suggestion.subscriptionCalculableFrom)}
                  </span>{' '}
                  {t('components.invoicePriceSuggestion.text9')}</p>
              )}
            </div>
              )}
            </div>
          </details>
        </>
      )}
    </Card>
  );
}
