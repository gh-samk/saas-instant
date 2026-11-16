import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Server } from 'lucide-react';
import { Card, Button, EmptyState, Skeleton, Table } from '@saas-instant/ui';
import { CardList, CardListItem, useWideList } from '../components/CardList';
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
 * Die Übersicht aller Instanzen — gewünscht am 12.09.2026.
 *
 * EIN WEGWEISER, KEINE ZWEITE DETAILSEITE. Jede Zeile führt in den Reiter
 * „Instanz" der jeweiligen Organisation; dort geschieht alles Weitere
 * (anlegen, archivieren, Einrichtungslink) hinter den Schranken, die es dort
 * hat. Hier wird nur gelesen — deshalb gibt es auch keinen Knopf „Instanz
 * anlegen": Eine Instanz gehört immer zu genau einer Organisation, und
 * angelegt wird sie dort.
 */
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

export function InstancesPage() {
  const t = useT();
  const wide = useWideList();
  const [list, setList] = useState<InstanceListEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  return (
    <section aria-labelledby="instances-title" className="space-y-6">
      <h1 id="instances-title" className="text-2xl font-semibold tracking-tight text-text">
        {t('instanzen.title')}
      </h1>

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
        wide ? (
          <Table
            columns={[
              t('instanzen.columnInstance'),
              t('instanzen.columnStatus'),
              t('instanzen.columnCompany'),
              t('instanzen.columnCreated'),
              t('instanzen.columnOpen'),
            ]}
            columnsOnlyReadAloud={[false, false, false, false, true]}
            variant="list"
            actionColumn
            minWidth="min-w-[720px]"
            columnsWidths={['w-4/12', 'w-2/12', 'w-3/12', 'w-2/12', 'w-1/12']}
            label={t('instanzen.tableCaption')}
          >
            {list.map((i) => (
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
                    <span
                      className={`block truncate ${tableText.compact.primary}`}
                      title={i.subdomain}
                    >
                      {i.subdomain}
                    </span>
                  </Link>
                  <span className={`block truncate ${tableText.compact.secondary}`}>
                    {hostFrom(i.url)}
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
                <td className={`${tableRow.compact} min-w-0`}>
                  <span
                    className={`block truncate ${tableText.compact.primary}`}
                    title={i.company.name}
                  >
                    {i.company.name}
                  </span>
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
          {list.map((i) => (
            <CardListItem key={i.id}>
              <div className="min-w-0 flex-1">
                <Link
                  to={{ pathname: `/companies/${i.company.id}`, search: '?tab=instance' }}
                  className="after:absolute after:inset-0"
                >
                  <span className="block break-words text-sm font-semibold text-text">
                    {i.subdomain}
                  </span>
                </Link>
                <span className={`block break-words ${tableText.compact.secondary}`}>
                  {i.company.name} · {hostFrom(i.url)}
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
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-leise" aria-hidden="true" />
            </CardListItem>
          ))}
        </CardList>
        )
      )}
    </section>
  );
}
