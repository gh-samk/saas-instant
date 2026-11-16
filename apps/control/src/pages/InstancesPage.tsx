import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, Plus, Server } from 'lucide-react';
import {
  Card,
  Button,
  EmptyState,
  FilterChips,
  Skeleton,
  Table,
} from '@saas-instant/ui';
import { CardList, CardListItem, useWideList } from '../components/CardList';
import { CompanyPicker } from '../components/CompanyPicker';
import { useT } from '../i18n';
import { errorText } from '../lib/api-client';
import { fetchInstances, type InstanceListEntry, type InstanceStatus } from '../lib/api';
import { tableText, tableRow } from '../lib/density';
import { INSTANCE_STATUS } from '../lib/instance-status';
import { formatDate } from '../utils/date';

/** Nur der Hostname — „https://" steht in jeder Zeile gleich und sagt nichts. */
function hostFrom(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Hostname mit Umbruchstellen NACH jedem Punkt und Bindestrich: Eine Domain
 * bricht so an ihren Gliedern, nicht mitten im Wort. Reicht ein Glied allein
 * nicht in die Zeile, greift als letzte Stufe der Umbruch im Wort
 * (`break-words`).
 */
function BreakableHost({ text }: { text: string }) {
  const parts = text.split(/(?<=[.-])/);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </>
  );
}

/** Statuswort je Instanzstatus (Schlüssel als Literale, damit die Schlüsselprüfung sie sieht). */
function statusLabel(t: ReturnType<typeof useT>, status: InstanceStatus): string {
  switch (status) {
    case 'provisioning':
      return t('instanzen.statusProvisioning');
    case 'active':
      return t('instanzen.statusActive');
    case 'stopped':
      return t('instanzen.statusStopped');
    case 'archived':
      return t('instanzen.statusArchived');
    default:
      return String(status);
  }
}

/**
 * Die letzte Sicherung als Datum. Der Warnpunkt trägt zusätzlich das Wort
 * „überfällig": Farbe allein wäre für einen Teil der Leserinnen keine Angabe.
 *
 * Ob sie überfällig ist, entscheidet der Server (`backupMissing`, dieselbe
 * Frist wie Detailkarte und Aufgabe); hier wird nichts nachgerechnet. Ohne
 * Warnung und ohne Datum (nicht laufende Instanz) steht ein Strich.
 */
function BackupCell({ entry }: { entry: InstanceListEntry }) {
  const t = useT();
  if (entry.lastBackupAt === null && !entry.backupMissing) {
    return <span className="text-leise">{t('instanzen.unknown')}</span>;
  }
  const date =
    entry.lastBackupAt === null ? t('instanzen.backupNever') : formatDate(entry.lastBackupAt);
  if (!entry.backupMissing) {
    return <span className="ziffern-tabellarisch">{date}</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2" title={t('instanzen.backupOverdueTitle')}>
      <span
        className="h-[7px] w-[7px] shrink-0 rounded-full border border-bedenken-rahmen bg-bedenken-text"
        aria-hidden="true"
      />
      <span className="ziffern-tabellarisch">{date}</span>
      <span className="text-bedenken-text">{t('instanzen.backupOverdue')}</span>
    </span>
  );
}

type Filter = 'all' | 'problems';

/**
 * Die Betriebsübersicht aller Instanzen.
 *
 * Jede Zeile führt in den Reiter „Instanz" der jeweiligen Organisation; dort
 * geschieht alles Weitere (archivieren, Einrichtungslink) hinter den
 * Schranken, die es dort hat. „+ Instanz" wählt nur die Organisation und
 * springt mit geöffnetem Anlegen-Dialog dorthin — angelegt wird weiterhin
 * in der Organisation, nicht hier.
 *
 * „PROBLEM" HEISST HIER: Sicherung überfällig. Mehr Störungsarten gibt die
 * Liste nicht her, und eine erfundene zweite wäre eine Behauptung ohne Daten.
 */
export function InstancesPage() {
  const t = useT();
  const wide = useWideList();
  const navigate = useNavigate();
  const [list, setList] = useState<InstanceListEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    setList(null);
    try {
      setList(await fetchInstances());
    } catch (error) {
      setLoadError(errorText(error, t('instanzen.loadError')));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const problemCount = list?.filter((i) => i.backupMissing).length ?? 0;
  const shown =
    list === null ? [] : filter === 'problems' ? list.filter((i) => i.backupMissing) : list;

  return (
    <section aria-labelledby="instances-title" className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 id="instances-title" className="min-w-0 text-2xl font-semibold tracking-tight text-text">
          {t('instanzen.title')}
        </h1>
        <Button onClick={() => setPickerOpen(true)} className="w-full shrink-0 sm:w-auto">
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('instanzen.add')}
        </Button>
      </div>

      {loadError !== null ? (
        <Card className="p-6">
          <p role="alert" className="mb-3 text-sm text-text">
            {loadError}
          </p>
          <Button variant="secondary" onClick={() => void load()}>
            {t('instanzen.retry')}
          </Button>
        </Card>
      ) : list === null ? (
        <div aria-busy="true" className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            Icon={Server}
            title={t('instanzen.emptyTitle')}
            notice={t('instanzen.emptyHint')}
          />
        </Card>
      ) : (
        <>
          <FilterChips
            label={t('instanzen.filterLabel')}
            active={filter}
            onSelect={setFilter}
            chips={[
              { value: 'all', label: t('instanzen.filterAll'), count: list.length },
              { value: 'problems', label: t('instanzen.filterProblems'), count: problemCount },
            ]}
          />
          {shown.length === 0 ? (
            <Card>
              <p className="p-6 text-sm text-leise">{t('instanzen.noProblems')}</p>
            </Card>
          ) : wide ? (
            <Table
              columns={[
                t('instanzen.columnInstance'),
                t('instanzen.columnStatus'),
                t('instanzen.columnCompany'),
                t('instanzen.columnVersion'),
                t('instanzen.columnPersons'),
                t('instanzen.columnBackup'),
                t('instanzen.columnCreated'),
                t('instanzen.columnOpen'),
              ]}
              columnsOnlyReadAloud={[false, false, false, false, false, false, false, true]}
              variant="list"
              actionColumn
              minWidth="min-w-[960px]"
              label={t('instanzen.tableCaption')}
            >
              {shown.map((i) => (
                <tr key={i.id} className="relative transition-colors">
                  <td className={`${tableRow.compact} min-w-0`}>
                    {/* Gestreckter Link wie in der Organisationsliste: die ganze
                        Zeile ist Klickziel und bleibt doch ein echter,
                        tastaturerreichbarer Link. Er führt DIREKT in den Reiter
                        „Instanz" — `?tab=instance` liest die Detailseite aus der
                        Adresse. */}
                    <Link
                      to={{ pathname: `/companies/${i.company.id}`, search: '?tab=instance' }}
                      className="after:absolute after:inset-0"
                    >
                      <span className={`block break-words ${tableText.compact.primary}`}>
                        <BreakableHost text={i.subdomain} />
                      </span>
                    </Link>
                    <span className={`block break-words ${tableText.compact.secondary}`}>
                      <BreakableHost text={hostFrom(i.url)} />
                    </span>
                  </td>
                  {/* Punkt UND Wort, wie in der Organisationsliste: Farbe allein
                      wäre für einen Teil der Leserinnen gar keine Angabe. */}
                  <td className={`${tableRow.compact} whitespace-nowrap`}>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className={`h-[7px] w-[7px] shrink-0 rounded-full ${INSTANCE_STATUS[i.status].surface} ${INSTANCE_STATUS[i.status].border} border`}
                        aria-hidden="true"
                      />
                      <span className={tableText.compact.secondary}>
                        {statusLabel(t, i.status)}
                      </span>
                    </span>
                  </td>
                  {/* Der Name wird NICHT abgeschnitten: Wer zwischen zwei
                      ähnlichen Organisationen unterscheiden muss, braucht das Ende. */}
                  <td className={`${tableRow.compact} min-w-0 break-words ${tableText.compact.primary}`}>
                    {i.company.name}
                  </td>
                  <td className={`${tableRow.compact} whitespace-nowrap ${tableText.compact.data}`}>
                    {i.appVersion ?? <span className="text-leise">{t('instanzen.unknown')}</span>}
                  </td>
                  <td className={`${tableRow.compact} whitespace-nowrap ziffern-tabellarisch ${tableText.compact.data}`}>
                    {i.activePersons ?? <span className="text-leise">{t('instanzen.unknown')}</span>}
                  </td>
                  <td className={`${tableRow.compact} ${tableText.compact.data}`}>
                    <BackupCell entry={i} />
                  </td>
                  <td className={`${tableRow.compact} whitespace-nowrap ${tableText.compact.secondary}`}>
                    {formatDate(i.createdAt)}
                  </td>
                  <td className={`${tableRow.compact} text-right`}>
                    <ChevronRight className="ml-auto h-4 w-4 text-leise" aria-hidden="true" />
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <CardList label={t('instanzen.tableCaption')}>
              {shown.map((i) => (
                <CardListItem key={i.id}>
                  <div className="min-w-0 flex-1">
                    <Link
                      to={{ pathname: `/companies/${i.company.id}`, search: '?tab=instance' }}
                      className="after:absolute after:inset-0"
                    >
                      <span className="block break-words text-sm font-semibold text-text">
                        <BreakableHost text={i.subdomain} />
                      </span>
                    </Link>
                    <span className={`block break-words ${tableText.compact.secondary}`}>
                      {i.company.name} · <BreakableHost text={hostFrom(i.url)} />
                    </span>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className={`h-[7px] w-[7px] shrink-0 rounded-full ${INSTANCE_STATUS[i.status].surface} ${INSTANCE_STATUS[i.status].border} border`}
                          aria-hidden="true"
                        />
                        <span className="text-sm text-text">{statusLabel(t, i.status)}</span>
                      </span>
                      <span className="ziffern-tabellarisch text-sm text-text">
                        <span className="text-leise">{t('instanzen.columnCreated')} </span>
                        {formatDate(i.createdAt)}
                      </span>
                    </div>
                    <dl className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text">
                      <div className="flex gap-1.5">
                        <dt className="text-leise">{t('instanzen.columnVersion')}</dt>
                        <dd>{i.appVersion ?? t('instanzen.unknown')}</dd>
                      </div>
                      <div className="flex gap-1.5">
                        <dt className="text-leise">{t('instanzen.columnPersons')}</dt>
                        <dd className="ziffern-tabellarisch">{i.activePersons ?? t('instanzen.unknown')}</dd>
                      </div>
                      <div className="flex gap-1.5">
                        <dt className="text-leise">{t('instanzen.columnBackup')}</dt>
                        <dd>
                          <BackupCell entry={i} />
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-leise" aria-hidden="true" />
                </CardListItem>
              ))}
            </CardList>
          )}
        </>
      )}

      <CompanyPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(company) => {
          setPickerOpen(false);
          // `create=instance` öffnet in der Organisation den Anlegen-Dialog.
          navigate({
            pathname: `/companies/${company.id}`,
            search: '?tab=instance&create=instance',
          });
        }}
      />
    </section>
  );
}
