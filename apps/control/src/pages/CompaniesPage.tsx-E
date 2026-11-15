import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, ChevronRight, Plus, Search, SearchX } from 'lucide-react';
import {
  FilterChips,
  Card,
  Button,
  EmptyState,
  Skeleton,
  Table,
  useToast,
} from '@saas-instant/ui';
import { CompanyCreateDialog } from '../components/CompanyCreateDialog';
import { CompanyStatusBadge } from '../components/CompanyStatusBadge';
import { errorText } from '../lib/api-client';
import { fetchCompanies, type CompanyPage } from '../lib/api';
import { tableText, tableRow } from '../lib/density';
import { STATUS_CHIPS } from '../lib/company-status';
import { INSTANCE_STATUS } from '../lib/instance-status';
import { formatAmountCent } from '../utils/amount';
import { formatDate } from '../utils/date';
import { useT } from '../i18n';

/** Wartezeit, bevor eine Eingabe zu einer Serveranfrage wird. */
const SEARCH_DELAY_MS = 300;

/**
 * Organisationsliste.
 *
 * FILTER UND SUCHE STEHEN IN DER URL. Wer eine Organisation öffnet und über
 * den Zurück-Pfeil zurückkommt, sieht wieder denselben Ausschnitt. Bei einem
 * täglich benutzten Werkzeug ist das kein Zierrat: Ohne das fängt jedes
 * Zurückspringen die Arbeit von vorn an.
 *
 * GEFILTERT UND GEBLÄTTERT WIRD SERVERSEITIG. Der Endpunkt kann beides
 * ohnehin (Status, Freitext über Name, Ansprechpartnerin, deren E-Mail und
 * Ort, dazu Seiten zu 25), und eine zweite, clientseitige Filterlogik
 * daneben liefe irgendwann auseinander.
 *
 * KEIN AUTOMATISCHES AUSBLENDEN von „Beendet": Alle acht Status sind
 * gleichrangig. Eine Organisation, die unsichtbar ist, obwohl niemand sie
 * gefiltert hat, verwirrt mehr als eine, die sichtbar „Beendet" dasteht.
 */
export function CompaniesPage() {
  const t = useT();
  const [parameter, setParameter] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  // Der Chipwert steht in der URL („pilot", „anfrage", leer für alle) und
  // wird erst hier zu den Status, nach denen der Server filtert. So bleibt
  // ein geteilter Link lesbar und übersteht eine Umbenennung im Enum.
  const chipValue = parameter.get('status') ?? '';
  const activeChip =
    STATUS_CHIPS.find((c) => c.value === chipValue) ?? STATUS_CHIPS[0];
  const statusFilter = activeChip.value === '' ? [] : activeChip.status;
  const search = parameter.get('search') ?? '';
  const page = Math.max(1, Number(parameter.get('page') ?? '1') || 1);

  const [searchInput, setSearchInput] = useState(search);
  const [data, setData] = useState<CompanyPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Die URL ist die Quelle der Wahrheit; das Eingabefeld zieht nach, wenn sie
  // sich von außen ändert (Zurück-Taste, Filter zurücksetzen).
  useEffect(() => setSearchInput(search), [search]);

  const setFilter = useCallback(
    (next: { status?: string; search?: string; page?: number }) => {
      setParameter(
        (alt) => {
          const updated = new URLSearchParams(alt);
          if (next.status !== undefined) {
            if (next.status === '') updated.delete('status');
            else updated.set('status', next.status);
          }
          if (next.search !== undefined) {
            if (next.search.trim() === '') updated.delete('search');
            else updated.set('search', next.search);
          }
          // Jede Änderung an Filter oder Suche beginnt wieder auf Seite 1 —
          // sonst zeigte Seite 4 eines alten Ergebnisses plötzlich nichts.
          const targetPage = next.page ?? 1;
          if (targetPage <= 1) updated.delete('page');
          else updated.set('page', String(targetPage));
          return updated;
        },
        { replace: true },
      );
    },
    [setParameter],
  );

  // Debounce: Nicht jeder Tastenanschlag wird eine Anfrage.
  useEffect(() => {
    if (searchInput === search) return;
    const identifier = window.setTimeout(
      () => setFilter({ search: searchInput }),
      SEARCH_DELAY_MS,
    );
    return () => window.clearTimeout(identifier);
  }, [searchInput, search, setFilter]);

  const load = useCallback(async () => {
    setData(null);
    setLoadError(null);
    try {
      setData(
        await fetchCompanies({
          ...(statusFilter.length > 0 ? { status: statusFilter } : {}),
          ...(search !== '' ? { search } : {}),
          page,
        }),
      );
    } catch (f) {
      setLoadError(
        errorText(f, t('organisationen.loadFailed')),
      );
    }
    // `chipWert` statt `statusFilter`: Ein Array ist bei jedem Durchlauf
    // eine neue Referenz und liesse den Effekt endlos neu laufen.
  }, [chipValue, search, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = chipValue !== '' || search !== '';
  const emptyWithoutFilter =
    data !== null && data.total === 0 && !filtered && page === 1;
  const pagesCount =
    data === null ? 1 : Math.max(1, Math.ceil(data.total / data.perPage));

  return (
    <section aria-labelledby="companies-title">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          {/* NUR DER TITEL. Der Untertitel „Kundenorganisationen und ihre
              Instanzen." entfiel schon beim Redesign — die Spaltenköpfe sagen
              es genauer.

              Die Gesamtzahl stand hier zuletzt daneben und ist auf Wunsch
              wieder weg: Sie beantwortet keine Frage, die man an dieser
              Stelle hat. Wer wissen will, wie viele es in einem Status gibt,
              liest die Zahlen an den Filter-Chips; wer die Liste überblicken
              will, sieht sie. Für die Vorlesestimme bleibt die Menge
              erhalten — unten in der `aria-live`-Zeile, wo sie eine Änderung
              ansagt, statt dauerhaft dazustehen. */}
          <h1
            id="companies-title"
            className="font-serif text-[26px] font-bold text-text"
          >
            {t('organisationen.title')}
          </h1>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          className="w-full shrink-0 sm:w-auto"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('organisationen.company')}
        </Button>
      </div>

      {/* Werkzeugleiste und Zähler entfallen, solange es gar nichts gibt: Ein
          Suchfeld über einem Leerzustand ist eine Behauptung ohne Nutzen. */}
      {!emptyWithoutFilter && (
        <>
          <div className="mb-4 flex flex-col gap-3">
            <FilterChips
              label={t('organisationen.filterByStatus')}
              active={activeChip.value}
              onSelect={(value) => setFilter({ status: value })}
              chips={STATUS_CHIPS.map((chip) => ({
                value: chip.value,
                label: chip.label,
                // Die Zahl kommt vom Server und beachtet die Suche, aber
                // nicht den Statusfilter. Ohne Daten steht keine Zahl da —
                // eine geratene wäre schlimmer als keine.
                count:
                  data === null
                    ? undefined
                    : chip.status.reduce(
                        (sum, s) => sum + (data.countPerStatus[s] ?? 0),
                        0,
                      ),
              }))}
            />
            <div className="relative min-w-0 sm:max-w-md">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-leise"
                aria-hidden="true"
              />
              <input
                type="search"
                aria-label={t('organisationen.searchLabel')}
                placeholder={t('organisationen.searchPlaceholder')}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="w-full rounded-lg border border-rahmen bg-flaeche py-2 pl-9 pr-3 text-sm text-text placeholder:text-leise focus:border-primaer focus:outline-none"
              />
            </div>
          </div>

          {data && !loadError && (
            // NUR FÜR DIE VORLESESTIMME, und seit die Zahl aus dem Titel
            // heraus ist, die einzige Stelle, an der die Gesamtmenge
            // überhaupt noch genannt wird. Sie darf deshalb nicht mit
            // verschwinden: Wer filtert, ohne die Liste sehen zu können,
            // erführe sonst nicht, dass sich etwas geändert hat.
            <p className="sr-only" aria-live="polite">
              {data.total}{' '}
              {data.total === 1 ? t('organisationen.companySingular') : t('organisationen.companyPlural')}
              {filtered ? t('organisationen.foundSuffix') : ''}
              {pagesCount > 1 ? t('organisationen.pageOfSuffix', { page: data.page, pages: pagesCount }) : ''}
            </p>
          )}
        </>
      )}

      {loadError ? (
        <div className="rounded-xl border border-rahmen bg-flaeche p-6">
          <p role="alert" className="mb-3 text-sm text-text">
            {loadError}
          </p>
          <Button variant="secondary" onClick={() => void load()}>
            {t('organisationen.retry')}
          </Button>
        </div>
      ) : data === null ? (
        <div className="flex flex-col gap-2 overflow-hidden rounded-xl border border-rahmen bg-flaeche p-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : emptyWithoutFilter ? (
        <Card>
          <EmptyState
            Icon={Building2}
            title={t('organisationen.emptyTitle')}
            notice={t('organisationen.emptyHint')}
            action={
              <Button onClick={() => setCreateOpen(true)}>
                {t('organisationen.createCompany')}
              </Button>
            }
          />
        </Card>
      ) : data.companies.length === 0 ? (
        <div className="overflow-hidden rounded-xl border border-rahmen bg-flaeche">
          <EmptyState
            Icon={SearchX}
            title={t('organisationen.noResultsTitle')}
            notice={t('organisationen.noResultsHint')}
            action={
              <Button
                variant="secondary"
                onClick={() => setFilter({ status: '', search: '' })}
              >
                {t('organisationen.resetFilter')}
              </Button>
            }
          />
        </div>
      ) : (
        <>
          {/* SPALTEN NACH DEM DESIGN: Organisation (Name + Ort), Status,
              Instanz, Offen, Nächste Frist, Pfeil. „Kontakt" und „Angelegt am"
              entfallen hier — die Kontaktdaten stehen auf der Detailseite, und
              beim Überfliegen einer Liste ist die offene Forderung die Zahl,
              nach der man sucht.

              `mindestbreite`: Sechs Spalten quetschen sich auf einem schmalen
              Bildschirm zu Unlesbarkeit. Die Hülle scrollt waagerecht, die
              SEITE nicht. */}
          <Table
            columns={[
              t('organisationen.company'),
              t('organisationen.status'),
              t('organisationen.instance'),
              t('organisationen.open'),
              t('organisationen.nextDeadline'),
              // Die Pfeilspalte traegt im Entwurf keine Ueberschrift. Ein
              // LEERER Tabellenkopf ist aber kein Ausweg — vorgelesen hoert
              // man dort nichts. Sie hat deshalb einen Namen, der nur nicht
              // gezeigt wird.
              t('organisationen.openAction'),
            ]}
            columnsOnlyReadAloud={[false, false, false, false, false, true]}
            variant="list"
            actionColumn
            minWidth="min-w-[880px]"
            columnsWidths={[
              'w-4/12',
              'w-2/12',
              'w-2/12',
              'w-1/12',
              'w-2/12',
              'w-1/12',
            ]}
            label={t('organisationen.title')}
          >
            {data.companies.map((o) => (
              <tr key={o.id} className="relative transition-colors">
                <td className={`${tableRow.compact} min-w-0`}>
                  {/* Gestreckter Link: die ganze Zeile ist Klickziel, bleibt
                      aber ein echter, tastaturerreichbarer Link. Der
                      Filterzustand reist an der URL mit, damit der Zurück-Weg
                      wieder GENAU hier herauskommt. */}
                  <Link
                    to={{
                      pathname: `/companies/${o.id}`,
                      search: parameter.toString(),
                    }}
                    className="after:absolute after:inset-0"
                  >
                    <span
                      className={`block truncate ${tableText.compact.primary}`}
                      title={o.name}
                    >
                      {o.name}
                    </span>
                  </Link>
                  {o.city && (
                    <span
                      className={`block truncate ${tableText.compact.secondary}`}
                      title={o.city}
                    >
                      {o.city}
                    </span>
                  )}
                </td>

                <td className={tableRow.compact}>
                  <CompanyStatusBadge status={o.status} />
                </td>

                {/* Punkt UND Wort. Der Punkt trägt die Farbe, das Wort die
                    Aussage — Farbe allein wäre für einen Teil der Leserinnen
                    gar keine Angabe. */}
                <td className={`${tableRow.compact} whitespace-nowrap`}>
                  {o.instanceStatus === null ? (
                    <span className={tableText.compact.secondary}>{t('organisationen.none')}</span>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <span
                        className={`h-[7px] w-[7px] shrink-0 rounded-full ${INSTANCE_STATUS[o.instanceStatus].surface} ${INSTANCE_STATUS[o.instanceStatus].border} border`}
                        aria-hidden="true"
                      />
                      <span className={tableText.compact.secondary}>
                        {INSTANCE_STATUS[o.instanceStatus].label}
                      </span>
                    </span>
                  )}
                </td>

                {/* Überfälliges rot. Das ist die einzige Stelle der Liste, an
                    der Farbe etwas behauptet — und sie behauptet nichts, was
                    nicht auch auf der Detailseite steht. */}
                <td
                  className={`${tableRow.compact} whitespace-nowrap ${
                    o.openAmountCent === 0
                      ? tableText.compact.secondary
                      : o.openOverdue
                        ? 'text-gefahr font-semibold'
                        : tableText.compact.primary
                  }`}
                >
                  {o.openAmountCent === 0
                    ? '—'
                    : formatAmountCent(o.openAmountCent)}
                </td>

                <td
                  className={`${tableRow.compact} whitespace-nowrap ${tableText.compact.secondary}`}
                >
                  {o.reviewDueDate
                    ? formatDate(o.reviewDueDate)
                    : '—'}
                </td>

                <td className={tableRow.compact}>
                  <ChevronRight
                    className="ml-auto h-4 w-4 text-still"
                    aria-hidden="true"
                  />
                </td>
              </tr>
            ))}
          </Table>

          {/* `sm:hidden`, nicht `md:hidden`: Ab 640 px stehen die Spalten fest
              und die Tabelle scrollt nicht mehr — der Hinweis wäre dort
              falsch. */}
          <p className="mt-2 text-xs text-leise sm:hidden">
            {t('organisationen.tableScrollHint')}
          </p>

          {pagesCount > 1 && (
            <nav
              aria-label={t('organisationen.paginationLabel')}
              className="mt-4 flex flex-wrap items-center justify-between gap-3"
            >
              <Button
                variant="secondary"
                disabled={data.page <= 1}
                onClick={() => setFilter({ page: data.page - 1 })}
              >
                {t('organisationen.back')}
              </Button>
              <span className="ziffern-tabellarisch text-sm text-leise">
                {t('organisationen.pageOf', { page: data.page, pages: pagesCount })}
              </span>
              <Button
                variant="secondary"
                disabled={data.page >= pagesCount}
                onClick={() => setFilter({ page: data.page + 1 })}
              >
                {t('organisationen.next')}
              </Button>
            </nav>
          )}
        </>
      )}

      <CompanyCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(company) => {
          setCreateOpen(false);
          toast.show(t('organisationen.created'));
          // Direkt auf die Detailseite: Dort zeigen die leeren Karten von
          // selbst, was noch fehlt.
          navigate(`/companies/${company.id}`);
        }}
      />
    </section>
  );
}
