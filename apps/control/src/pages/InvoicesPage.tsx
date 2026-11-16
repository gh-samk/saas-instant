import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Eye,
  Landmark,
  FileArchive,
  MoreHorizontal,
  Pencil,
  Plus,
  ReceiptEuro,
  Wallet,
} from 'lucide-react';
import {
  FilterChips,
  MetricTile,
  Button,
  EmptyState,
  Menu,
  Skeleton,
  Table,
  type MenuItem,
} from '@saas-instant/ui';
import { CompanyPicker } from '../components/CompanyPicker';
import { InvoiceStatusBadge } from '../components/InvoiceStatusBadge';
import { GobdExportDialog } from '../components/GobdExportDialog';
import { useInvoiceQuickActions } from '../components/InvoiceQuickActions';
import { useAuth } from '../context/AuthContext';
import { errorText } from '../lib/api-client';
import {
  fetchAllInvoices,
  fetchInvoiceMetrics,
  type Invoice,
  type InvoiceMetrics,
  type InvoicePage,
  type PaymentState,
} from '../lib/api';
import { tableText, tableRow } from '../lib/density';
import { useWideList } from '../components/CardList';
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
 * DIE AKTIONSSPALTE FOLGT STRENG DEM ZUSTAND (Regel 4 des Entwurfs) UND HAT
 * EINE EINHEITLICHE OPTIK: ein Hauptknopf je Zustand (Entwurf → „Bearbeiten",
 * offen, überfällig oder teilbezahlt → „Zahlung", bezahlt oder storniert →
 * „Ansehen"), alles andere im Zeilenmenü „⋯". Vorher standen drei Optiken in
 * einer Spalte (großer Knopf, zwei Icons, ein Auge). Eine Handlung
 * anzubieten, die fachlich nicht mehr geht, ist schlimmer als keine.
 *
 * „Zahlung erfassen" und „Zahlungserinnerung senden" öffnen ihre Dialoge
 * DIREKT in der Liste. Beide bleiben, was sie auf der Rechnungsseite sind:
 * Die Erinnerung fragt erst nach (Empfänger, Betrag) und verschickt nichts
 * mit einem einzigen Klick, die Zahlung liegt hinter dem zweiten Faktor.
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
  const { state } = useAuth();
  // Ab `xl` die Tabelle, darunter Karten. GEMESSEN: Bei 1024 px bleiben neben
  // der Seitenleiste 706 px — für sechs Spalten samt Status-Badge und
  // Hauptknopf zu wenig (Badge und „Bearbeiten" überlappten). Ab 1280 px passt
  // die Zeile ohne Kürzen und ohne Seitwärtsscrollen.
  const wide = useWideList();
  const [exportOpen, setExportOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Der Export ist Inhabern und Administratoren vorbehalten (wie im Backend).
  const mayExport =
    state?.user.role === 'owner' || state?.user.role === 'administrator';

  const chipValue = parameter.get('state') ?? '';
  const activeChip =
    STATE_CHIPS.find((c) => c.value === chipValue) ?? STATE_CHIPS[0];
  const page = Math.max(1, Number(parameter.get('page') ?? '1') || 1);

  const [data, setData] = useState<InvoicePage | null>(null);
  const [metrics, setMetrics] = useState<InvoiceMetrics | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    // Still nachladen (nach einer Direktaktion) lässt die Liste stehen: Ein
    // Skelett mitten in der Arbeit würde die Zeile unter dem Zeiger wegreißen.
    if (!silent) setData(null);
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

  // Die Zeile sofort ersetzen, dann still nachladen: Zähler, Kacheln und der
  // Filter ändern sich mit.
  function rowChanged(updated: Invoice) {
    setData((alt) =>
      alt === null
        ? alt
        : {
            ...alt,
            invoices: alt.invoices.map((x) => (x.id === updated.id ? updated : x)),
          },
    );
    void load(true);
  }

  const pagesCount =
    data === null ? 1 : Math.max(1, Math.ceil(data.total / data.perPage));

  return (
    <section aria-labelledby="invoices-title">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <h1
          id="invoices-title"
          className="text-2xl font-semibold tracking-tight text-text"
        >
          {t('rechnungen.title')}
        </h1>
        {/* HAUPTKNOPF IST „+ RECHNUNG" (häufig), der Export für die
            Betriebsprüfung steht als Sekundärknopf daneben (selten). Eine
            Rechnung braucht eine Organisation; der Knopf fragt sie in einem
            kleinen Dialog ab und springt in den Entwurf, statt auf die
            Organisationsliste zu führen. */}
        <div className="flex flex-wrap items-center gap-3">
          {mayExport && (
            <Button variant="secondary" onClick={() => setExportOpen(true)}>
              <FileArchive className="h-4 w-4" aria-hidden="true" />
              {t('gobd.exportButton')}
            </Button>
          )}
          <Button variant="primary" onClick={() => setPickerOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('rechnungen.newInvoiceButton')}
          </Button>
        </div>
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
          {wide ? (
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
                'w-[13%]',
                'w-[22%]',
                'w-[12%]',
                'w-[13%]',
                'w-[15%]',
                'w-[25%]',
              ]}
              variant="list"
              actionColumn
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
                    {/* Normale Schriftgröße wie Nummer und Betrag, und nicht
                        abgeschnitten: Der Name ist der Grund, die Zeile zu
                        lesen. */}
                    <Link
                      to={`/companies/${r.companyId}`}
                      className={`block break-words ${tableText.compact.primary} hover:underline`}
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
                        : tableText.compact.data
                    }`}
                  >
                    {r.paymentState === 'draft' ? '—' : formatDate(r.dueDate)}
                  </td>
                  <td className={tableRow.compact}>
                    <InvoiceStatusBadge paymentState={r.paymentState} />
                  </td>
                  <td className={tableRow.compact}>
                    <RowActions invoice={r} onChanged={rowChanged} />
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            // UNTER `xl` KARTEN: Nummer und Status oben, Organisation, dann
            // Betrag und Fälligkeit, unten Hauptknopf und Zeilenmenü. Das
            // Muster der Aufgabenliste auf „Heute" (Liste in einer Hülle).
            <ul
              aria-label={t('rechnungen.title')}
              className="divide-y divide-rahmen overflow-hidden rounded-xl border border-rahmen bg-flaeche"
            >
              {data.invoices.map((r) => (
                <li key={r.id} className="flex flex-col gap-3 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                    <Link
                      to={`/companies/${r.companyId}/invoices/${r.id}`}
                      className="inline-flex min-h-11 items-center ziffern-tabellarisch text-sm font-semibold text-text hover:underline"
                    >
                      {r.invoiceNumber ?? '—'}
                    </Link>
                    <InvoiceStatusBadge paymentState={r.paymentState} />
                  </div>
                  <Link
                    to={`/companies/${r.companyId}`}
                    className="inline-flex min-h-11 min-w-0 items-center break-words text-sm text-text hover:underline"
                  >
                    {r.companyName ?? t('rechnungen.company')}
                  </Link>
                  <dl className="ziffern-tabellarisch flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                    <div className="flex items-baseline gap-1.5">
                      <dt className="text-leise">{t('rechnungen.amount')}</dt>
                      <dd className="font-medium text-text">
                        {formatAmountCent(r.sumGrossCent)}
                      </dd>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <dt className="text-leise">{t('rechnungen.due')}</dt>
                      <dd
                        className={
                          r.paymentState === 'overdue'
                            ? 'font-semibold text-gefahr'
                            : 'text-text'
                        }
                      >
                        {r.paymentState === 'draft' ? '—' : formatDate(r.dueDate)}
                      </dd>
                    </div>
                  </dl>
                  <RowActions invoice={r} onChanged={rowChanged} />
                </li>
              ))}
            </ul>
          )}

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

      <CompanyPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(company) => {
          setPickerOpen(false);
          navigate(`/companies/${company.id}/invoices/new`);
        }}
      />

      <GobdExportDialog
        open={exportOpen}
        totpPossible={state?.totpSetUp ?? false}
        onClose={() => setExportOpen(false)}
      />
    </section>
  );
}

/**
 * Die Handlungen einer Zeile — STRENG nach Zustand, ein Hauptknopf plus Menü.
 *
 * Die Namen der Knöpfe tragen die Rechnungsnummer, damit eine Liste mit
 * zwanzig gleichen „Zahlung"-Knöpfen für Vorlesesoftware unterscheidbar
 * bleibt. Ein Entwurf hat keine Nummer („dieser Rechnung").
 */
function RowActions({
  invoice,
  onChanged,
}: {
  invoice: Invoice;
  onChanged: (invoice: Invoice) => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const quick = useInvoiceQuickActions({ invoice, onChanged });
  const target = `/companies/${invoice.companyId}/invoices/${invoice.id}`;
  const number = invoice.invoiceNumber ?? t('rechnungen.thisInvoice');
  const state = invoice.paymentState;
  const unpaid =
    state === 'open' || state === 'overdue' || state === 'partially_paid';
  // Wie in der Rechnungsansicht: Erinnern nur, wenn die Frist vorbei ist
  // oder schon etwas gezahlt wurde.
  const reminderPossible = state === 'overdue' || state === 'partially_paid';

  const link = (id: string, label: string, to: string): MenuItem => ({
    id,
    label,
    href: to,
    onSelect: (event) => {
      event.preventDefault();
      navigate(to);
    },
  });

  const items: MenuItem[] = [];
  if (unpaid) {
    items.push(
      link('view', t('rechnungen.viewInvoice', { number: invoice.invoiceNumber ?? '' }), target),
    );
  }
  if (reminderPossible) {
    items.push({
      id: 'reminder',
      label: t('rechnungen.sendReminderShort'),
      onSelect: () => quick.sendReminder(),
    });
  }
  items.push(
    link('company', t('rechnungen.openCompany'), `/companies/${invoice.companyId}`),
  );

  return (
    <span className="flex items-center justify-end gap-1.5">
      {state === 'draft' ? (
        <Button
          variant="secondaryGreen"
          size="sm"
          onClick={() => navigate(target)}
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
          {t('rechnungen.edit')}
        </Button>
      ) : unpaid ? (
        <Button
          variant="secondaryGreen"
          size="sm"
          aria-label={t('rechnungen.recordPaymentFor', { invoice: number })}
          onClick={() => quick.recordPayment()}
        >
          {t('rechnungen.payment')}
        </Button>
      ) : (
        // Bezahlt oder storniert: NUR ansehen. Kein Bezahlt-Häkchen, keine
        // Erinnerung — beides ginge fachlich nicht mehr.
        <Button
          variant="secondary"
          size="sm"
          aria-label={t('rechnungen.viewInvoice', { number: invoice.invoiceNumber ?? '' })}
          onClick={() => navigate(target)}
        >
          <Eye className="h-4 w-4" aria-hidden="true" />
          {t('rechnungen.view')}
        </Button>
      )}
      <Menu
        label={<MoreHorizontal className="h-4 w-4" aria-hidden="true" />}
        ariaLabel={t('rechnungen.moreFor', { invoice: number })}
        hideChevron
        variant="ghost"
        items={items}
      />
      {quick.element}
    </span>
  );
}
