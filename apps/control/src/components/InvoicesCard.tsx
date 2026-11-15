import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PlusCircle, ReceiptText } from 'lucide-react';
import { Card, Button, EmptyState, Skeleton } from '@saas-instant/ui';
import { InvoiceStatusBadge } from './InvoiceStatusBadge';
import { errorText } from '../lib/api-client';
import { fetchInvoices, type Invoice } from '../lib/api';
import { formatAmount } from '../utils/amount';
import { formatDate } from '../utils/date';
import { useT } from '../i18n';

/**
 * Die Rechnungsliste einer Organisation.
 *
 * SIE IST DER EINZIGE ORT, an dem Rechnungen aufgelistet werden — es gibt
 * bewusst keine systemweite Rechnungsliste. Drei Gründe, alle nachprüfbar:
 * Jede Rechnung gehört zu genau einer Organisation; was eine übergreifende
 * Sicht bräuchte („was ist überfällig") liefert das Dashboard bereits
 * arbeitsorientiert mit direktem Link; und der Server hat gar keine Route für
 * „alle Rechnungen aller Organisationen". Eine solche Liste zu bauen hieße,
 * eine Backend-Lücke im UI zu kaschieren, statt sie zu benennen.
 *
 * KEINE `Tabelle`. Fünf Spalten (Nummer, Status, Datum, Fälligkeit, Betrag)
 * auf einer Karte, die zwischen Stammdaten, Vertragsdaten, Instanz und Verlauf
 * steht, wären bei 375 px die dritte waagerecht scrollende Struktur derselben
 * Seite. Stattdessen eine vertikale Liste im Rhythmus der übrigen Karten.
 *
 * Sie hält ihren Zustand selbst und lädt beim Einhängen — dasselbe Muster wie
 * `InstanzKarte`.
 */
export function InvoicesCard({
  companyId,
}: {
  companyId: string;
}) {
  const t = useT();
  const navigate = useNavigate();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const lives = useRef(true);
  useEffect(() => {
    lives.current = true;
    return () => {
      lives.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await fetchInvoices(companyId);
      if (!lives.current) return;
      // Die Form der Antwort wird geprüft, nicht geglaubt. Ein `.map` auf
      // etwas, das keine Liste ist, reißt sonst die ganze Detailseite mit —
      // dieselbe Lehre wie beim Aufgaben-Icon des Dashboards, nur eine Ebene
      // früher. Sichtbar als Fehler, nicht still als leere Liste: „keine
      // Rechnungen" wäre hier die beruhigendste aller falschen Auskünfte.
      if (!Array.isArray(list)) {
        setLoadError(t('components.invoicesCard.text'));
        setInvoices(null);
        return;
      }
      setInvoices(list);
    } catch (f) {
      if (!lives.current) return;
      setLoadError(errorText(f, t('components.invoicesCard.text2')));
      setInvoices(null);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    // Sprungmarke der Dashboard-Aufgabe „Rechnung fällig": Sie führt hierher
    // und nicht an den Seitenanfang. Der Knopf öffnet weiterhin nur ein
    // bewusster Klick — die Marke bringt niemanden näher an eine Handlung.
    <Card className="mt-6 p-6" id="rechnungen">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text">{t('components.invoicesCard.heading')}</h2>
        {/* IMMER aktiv, unabhängig vom Organisationsstatus — dieselbe
            Zurückhaltung wie beim Instanz-Anlegen-Knopf: keine Geschäftsregel
            erfinden, die niemand verlangt hat. */}
        <Button
          onClick={() =>
            navigate(`/companies/${companyId}/invoices/new`)
          }
        >
          <PlusCircle className="h-4 w-4" aria-hidden="true" />
          {t('components.invoicesCard.button')}</Button>
      </div>

      {loadError ? (
        <div>
          <p role="alert" className="mb-3 text-sm text-gefahr">
            {loadError}
          </p>
          <Button variant="secondary" onClick={() => void load()}>
            {t('components.invoicesCard.button2')}</Button>
        </div>
      ) : invoices === null ? (
        <div className="divide-y divide-rahmen">
          {[0, 1, 2].map((i) => (
            <div key={i} className="py-3 first:pt-0 last:pb-0">
              <Skeleton className="h-14 w-full" />
            </div>
          ))}
        </div>
      ) : invoices.length === 0 ? (
        <EmptyState
          Icon={ReceiptText}
          title={t('components.invoicesCard.title')}
          notice={t('components.invoicesCard.notice')}
        />
      ) : (
        <ul className="divide-y divide-rahmen">
          {invoices.map((r) => (
            <li key={r.id} className="relative py-3 first:pt-0 last:pb-0">
              {/* „Stretched Link" wie in der Organisationenliste: Die ganze
                  Zeile ist Klickziel, bleibt aber ein echter, mit der Tastatur
                  erreichbarer Link. */}
              <Link
                to={`/companies/${companyId}/invoices/${r.id}`}
                className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-lg focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-primaer"
              >
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">
                      {r.invoiceNumber ?? t('components.invoicesCard.text3')}
                      {r.isCancellation && (
                        <span className="ml-1.5 text-xs text-leise">
                          {t('components.invoicesCard.label')}</span>
                      )}
                    </p>
                    <p className="text-xs text-leise">
                      <span className="ziffern-tabellarisch">
                        {formatDate(r.invoiceDate)}
                      </span>
                      {t('components.invoicesCard.text4')}
                      <span className="ziffern-tabellarisch">
                        {formatDate(r.servicePeriodFrom)}
                        {'–'}
                        {formatDate(r.servicePeriodUntil)}
                      </span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {/* F2: `summeBrutto` ist „1234.56", nie deutsch
                        formatiert — hier läuft es durch `formatBetrag`. */}
                    <span className="ziffern-tabellarisch text-sm font-medium text-text">
                      {formatAmount(r.sumGross)}
                    </span>
                    <InvoiceStatusBadge paymentState={r.paymentState} />
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
