import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Landmark,
  Mail,
  Pencil,
  ReceiptEuro,
  Wallet,
} from 'lucide-react';
import {
  FilterChips,
  IconButton,
  MetricTile,
  Button,
  EmptyState,
  Skeleton,
  Table,
} from '@saas-instant/ui';
import { InvoiceStatusBadge } from '../components/InvoiceStatusBadge';
import { errorText } from '../lib/api-client';
import {
  fetchAllInvoices,
  fetchInvoiceMetrics,
  type InvoiceMetrics,
  type InvoicePage,
  type PaymentState,
} from '../lib/api';
import { tableText, tableRow } from '../lib/density';
import { formatAmountCent } from '../utils/amount';
import { formatDate } from '../utils/date';
import { useT } from '../i18n';

/**
 * ALLE Rechnungen an einem Ort.
 *
 * BIS ZUM REDESIGN GAB ES DIESE SEITE BEWUSST NICHT — Rechnungen gehörten zu
 * einer Organisation, und die übergreifende Frage („was ist überfällig")
 * beantwortete die Startseite arbeitsorientiert. Der Entwurf kehrt das um,
 * und das ist nachvollziehbar: Wer einen Abrechnungslauf macht, arbeitet
 * nicht Kunde für Kunde, sondern Rechnung für Rechnung.
 *
 * HIER STEHEN KACHELN, auf „Heute" nicht. Das ist kein Widerspruch, sondern
 * die Entscheidung des Auftraggebers beim Durchgang: Auf der Startseite gilt
 * weiter E2-24 („Aufgabenliste, keine Kacheln"), weil dort die HANDLUNG zählt.
 * Auf dieser Seite sind Zahlen der eigentliche Inhalt.
 *
 * DIE AKTIONSSPALTE FOLGT STRENG DEM ZUSTAND (Regel 4 des Entwurfs): Entwurf
 * → bearbeiten; offen oder überfällig → als bezahlt markieren und erinnern;
 * bezahlt oder storniert → NUR ansehen. Eine Handlung anzubieten, die
 * fachlich nicht mehr geht, ist schlimmer als keine.
 */

/** Die Chips über der Liste, in der Reihenfolge des Entwurfs. */
const STATE_CHIPS: { value: string; labelKey: string; state?: PaymentState }[] = [
  { value: '', labelKey: 'rechnungen.chipAll' },
  { value: 'draft', labelKey: 'rechnungen.chipDraft', state: 'draft' },
  { value: 'open', labelKey: 'rechnungen.chipOpen', state: 'open' },
  { value: 'overdue', labelKey: 'rechnungen.chipOverdue', state: 'overdue' },
  { value: 'paid', labelKey: 'rechnungen.chipPaid', state: 'paid' },
  { value: 'cancelled', labelKey: 'rechnungen.chipCancelled', state: 'cancelled' },
];

export function InvoicesPage() {
  const t = useT();
  const [parameter, setParameter] = useSearchParams();
  const navigate = useNavigate();

  const chipValue = parameter.get('state') ?? '';
  const activeChip =
    STATE_CHIPS.find((c) => c.value === chipValue) ?? STATE_CHIPS[0];
  const page = Math.max(1, Number(parameter.get('page') ?? '1') || 1);

  const [data, setData] = useState<InvoicePage | null>(null);
  const [metrics, setMetrics] = useState<InvoiceMetrics | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(null);
    setLoadError(null);
    try {
      const [list, numbers] = await Promise.all([
        fetchAllInvoices({
          ...(activeChip.state ? { state: activeChip.state } : {}),
          page,
        }),
        fetchInvoiceMetrics(),
      ]);
      setData(list);
      setMetrics(numbers);
    } catch (f) {
      setLoadError(errorText(f, t('rechnungen.loadFailed')));
    }
  }, [activeChip.state, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function setFilter(next: { state?: string; page?: number }) {
    setParameter((alt) => {
      const updated = new URLSearchParams(alt);
      if (next.state !== undefined) {
        if (next.state === '') updated.delete('state');
        else updated.set('state', next.state);
        // Ein Filterwechsel führt IMMER auf Seite eins zurück. Sonst landet
        // man auf einer Seite 4, die es in der neuen Auswahl nicht gibt.
        updated.delete('page');
      }
      if (next.page !== undefined) {
        if (next.page <= 1) updated.delete('page');
        else updated.set('page', String(next.page));
      }
      return updated;
    });
  }

  const pagesCount =
    data === null ? 1 : Math.max(1, Math.ceil(data.total / data.perPage));

  return (
    <section aria-labelledby="invoices-title">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <h1
          id="invoices-title"
          className="font-serif text-[26px] font-bold text-text"
        >
          {t('rechnungen.title')}
        </h1>
        {/* Es gibt keinen globalen „+ Neu": Eine Rechnung braucht eine
            Organisation, und die wählt man dort, wo sie steht. Der Knopf
            führt deshalb in die Liste, nicht in ein leeres Formular. */}
        <Button variant="secondary" onClick={() => navigate('/companies')}>
          <ReceiptEuro className="h-4 w-4" aria-hidden="true" />
          {t('rechnungen.createAtCompany')}
        </Button>
      </div>

      {/* DREI KACHELN, in der Reihenfolge des Entwurfs. Keine Entwurfskachel —
          Entwürfe stehen als Chip im Filter. */}
      {metrics && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <MetricTile
            Icon={Wallet}
            number={formatAmountCent(metrics.openCent)}
            label={t('rechnungen.openAmounts', { count: metrics.openCount })}
            kind="attention"
            selected={chipValue === 'open'}
            onClick={() => setFilter({ state: 'open' })}
          />
          <MetricTile
            Icon={AlertTriangle}
            number={formatAmountCent(metrics.overdueCent)}
            label={t('rechnungen.overdueAmounts', { count: metrics.overdueCount })}
            kind="problem"
            selected={chipValue === 'overdue'}
            onClick={() => setFilter({ state: 'overdue' })}
          />
          <MetricTile
            Icon={Landmark}
            number={formatAmountCent(metrics.paidCent)}
            label={t('rechnungen.paidRevenue', { year: metrics.year })}
            kind="confirmed"
            selected={chipValue === 'paid'}
            onClick={() => setFilter({ state: 'paid' })}
          />
        </div>
      )}

      <div className="mb-4">
        <FilterChips
          label={t('rechnungen.filterByPaymentState')}
          active={activeChip.value}
          onSelect={(value) => setFilter({ state: value })}
          chips={STATE_CHIPS.map((chip) => ({
            value: chip.value,
            label: t(chip.labelKey),
            count:
              data === null
                ? undefined
                : chip.state === undefined
                  ? Object.values(data.countPerState).reduce((a, b) => a + b, 0)
                  : data.countPerState[chip.state],
          }))}
        />
      </div>

      {loadError ? (
        <div className="rounded-xl border border-rahmen bg-flaeche p-6">
          <p role="alert" className="mb-3 text-sm text-text">
            {loadError}
          </p>
          <Button variant="secondary" onClick={() => void load()}>
            {t('rechnungen.retry')}
          </Button>
        </div>
      ) : data === null ? (
        <div className="flex flex-col gap-2 overflow-hidden rounded-xl border border-rahmen bg-flaeche p-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : data.invoices.length === 0 ? (
        <div className="overflow-hidden rounded-xl border border-rahmen bg-flaeche">
          <EmptyState
            Icon={ReceiptEuro}
            title={
              chipValue === ''
                ? t('rechnungen.emptyTitle')
                : t('rechnungen.noneInSelection')
            }
            notice={
              chipValue === ''
                ? t('rechnungen.emptyHint')
                : t('rechnungen.filterHint')
            }
            action={
              chipValue === '' ? undefined : (
                <Button
                  variant="secondary"
                  onClick={() => setFilter({ state: '' })}
                >
                  {t('rechnungen.showAll')}
                </Button>
              )
            }
          />
        </div>
      ) : (
        <>
          {/* GEMESSEN: Mit einem Zwoelftel fuer die Handlungen war der Knopf
              „Bearbeiten" abgeschnitten. Die Organisationsspalte kuerzt
              ohnehin, die Handlungen koennen es nicht. */}
          <Table
            columns={[
              t('rechnungen.columnNumber'),
              t('rechnungen.company'),
              t('rechnungen.amount'),
              t('rechnungen.due'),
              t('rechnungen.status'),
              t('rechnungen.actions'),
            ]}
            columnsWidths={[
              'w-2/12',
              'w-3/12',
              'w-2/12',
              'w-2/12',
              'w-1/12',
              'w-2/12',
            ]}
            variant="list"
            actionColumn
            minWidth="min-w-[830px]"
            label={t('rechnungen.title')}
          >
            {data.invoices.map((r) => (
              <tr key={r.id}>
                <td className={`${tableRow.compact} whitespace-nowrap`}>
                  <Link
                    to={`/companies/${r.companyId}/invoices/${r.id}`}
                    className={`${tableText.compact.primary} hover:underline`}
                  >
                    {/* Ein Entwurf hat noch keine Nummer — sie wird erst beim
                        Festschreiben vergeben. „—" statt einer erfundenen. */}
                    {r.invoiceNumber ?? '—'}
                  </Link>
                </td>
                <td className={`${tableRow.compact} min-w-0`}>
                  <Link
                    to={`/companies/${r.companyId}`}
                    className={`block truncate ${tableText.compact.secondary} hover:underline`}
                    title={r.companyName ?? t('rechnungen.company')}
                  >
                    {r.companyName ?? t('rechnungen.company')}
                  </Link>
                </td>
                <td
                  className={`${tableRow.compact} whitespace-nowrap ${tableText.compact.primary}`}
                >
                  {formatAmountCent(r.sumGrossCent)}
                </td>
                <td
                  className={`${tableRow.compact} whitespace-nowrap ${
                    r.paymentState === 'overdue'
                      ? 'font-semibold text-gefahr'
                      : tableText.compact.secondary
                  }`}
                >
                  {r.paymentState === 'draft'
                    ? '—'
                    : formatDate(r.dueDate)}
                </td>
                <td className={tableRow.compact}>
                  <InvoiceStatusBadge paymentState={r.paymentState} />
                </td>
                <td className={tableRow.compact}>
                  <Actions invoice={r} />
                </td>
              </tr>
            ))}
          </Table>

          {pagesCount > 1 && (
            <nav
              aria-label={t('rechnungen.paginationLabel')}
              className="mt-4 flex flex-wrap items-center justify-between gap-3"
            >
              <Button
                variant="secondary"
                disabled={data.page <= 1}
                onClick={() => setFilter({ page: data.page - 1 })}
              >
                {t('rechnungen.back')}
              </Button>
              <span className="ziffern-tabellarisch text-sm text-leise">
                {t('rechnungen.pageOf', { page: data.page, pages: pagesCount })}
              </span>
              <Button
                variant="secondary"
                disabled={data.page >= pagesCount}
                onClick={() => setFilter({ page: data.page + 1 })}
              >
                {t('rechnungen.next')}
              </Button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Die Handlungen einer Zeile — STRENG nach Zustand.
 *
 * Sie FÜHREN alle nur hin. „Als bezahlt markieren" und „Erinnerung senden"
 * sind unumkehrbare Vorgänge hinter dem zweiten Faktor; sie werden auf der
 * Rechnungsseite bestätigt und nicht aus einer Listenzeile heraus ausgelöst.
 * Eine Liste, in der ein Klick Geld bucht oder Post verschickt, ist eine
 * Falle.
 */
function Actions({
  invoice,
}: {
  invoice: InvoicePage['invoices'][number];
}) {
  const t = useT();
  const navigate = useNavigate();
  const target = `/companies/${invoice.companyId}/invoices/${invoice.id}`;

  if (invoice.paymentState === 'draft') {
    return (
      <Button
        variant="secondaryGreen"
        onClick={() => navigate(target)}
        className="ml-auto"
      >
        <Pencil className="h-4 w-4" aria-hidden="true" />
        {t('rechnungen.edit')}
      </Button>
    );
  }

  if (
    invoice.paymentState === 'open' ||
    invoice.paymentState === 'overdue'
  ) {
    return (
      <span className="flex justify-end gap-1.5">
        <IconButton
          Icon={CheckCircle2}
          label={t('rechnungen.recordPaymentFor', { invoice: invoice.invoiceNumber ?? t('rechnungen.thisInvoice') })}
          size="small"
          onClick={() => navigate(target)}
        />
        <IconButton
          Icon={Mail}
          label={t('rechnungen.sendReminderFor', { invoice: invoice.invoiceNumber ?? t('rechnungen.thisInvoice') })}
          size="small"
          onClick={() => navigate(target)}
        />
      </span>
    );
  }

  // Bezahlt oder storniert: NUR ansehen. Kein Bezahlt-Häkchen, keine
  // Erinnerung — beides ginge fachlich nicht mehr.
  return (
    <span className="flex justify-end">
      <IconButton
        Icon={Eye}
        label={t('rechnungen.viewInvoice', { number: invoice.invoiceNumber ?? '' })}
        size="small"
        onClick={() => navigate(target)}
      />
    </span>
  );
}
