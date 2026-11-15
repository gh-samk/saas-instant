import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks } from 'lucide-react';
import {
  FilterChips,
  Button,
  EmptyState,
  Skeleton,
  Table,
} from '@saas-instant/ui';
import { ReconciliationCard } from '../components/ReconciliationCard';
import { TaskAction } from '../components/TaskAction';
import { errorText } from '../lib/api-client';
import {
  fetchTasks,
  type Task,
  type TaskKind,
  type TaskTruncation,
  type TaskList,
} from '../lib/api';
import { taskLabel, taskIcon } from '../lib/tasks';
import { tableText, tableRow } from '../lib/density';
import { dateInText, formatDate } from '../utils/date';
import { dueNotice, daysUntil } from '../utils/due-date';
import { useT, type TFunction } from '../i18n';

/**
 * Was die Aufgabe ist: Icon, Titel, Begründung, betroffene Organisation.
 *
 * Eigener Baustein, weil ihn beide Darstellungen (Karten unter `sm`, Tabelle
 * darüber) benutzen. Zwei Kopien desselben Markups liefen sonst mit der Zeit
 * auseinander, und der Unterschied fiele nur bei genau einer Fensterbreite auf.
 */
function TaskHeader({ task }: { task: Task }) {
  // Über die Funktion, nicht über den Record: Eine Aufgabenart, die die
  // Oberfläche noch nicht kennt, ergäbe sonst `undefined` als Komponente und
  // risse die ganze Startseite mit.
  const Icon = taskIcon(task.kind);
  return (
    <div className="flex items-start gap-3">
      {/* Alle Aufgabenkreise tragen dieselbe Farbe: Die acht
          Organisationsstatus haben bereits eine gelernte Farbsprache, eine
          zweite daneben hieße zweimal „was bedeutet Rot hier". Unterschieden
          wird über Icon und Text. */}
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primaer-soft text-primaer">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className={tableText.compact.primary}>{task.title}</p>
        {/* Vier Aufgabenquellen setzen den Kalendertag direkt in ihren Text
            ein („… am 2026-08-31 …"). Das Datumsformat der Anwendung ist
            durchgehend dd.mm.yyyy; die Anzeigeschicht ist der letzte Ort, an
            dem die Regel noch greifen kann. */}
        <p className={tableText.compact.secondary}>
          {dateInText(task.reason)}
        </p>
        {/* DER ORGANISATIONSLINK STEHT NUR NOCH IN DER SCHMALEN ANSICHT.
            Ab 640 px hat die Organisation eine eigene Spalte; zweimal
            derselbe Verweis in einer Zeile ist einmal zu viel.

            NICHT jede Aufgabe hängt an einer Organisation: Die
            Aufbewahrungsfrist des Audit-Logs gilt für den ganzen Bestand. */}
        {task.company && (
          <Link
            to={`/companies/${task.company.id}`}
            className="mt-1 inline-block text-xs text-primaer underline underline-offset-2 hover:text-primaer-hover sm:hidden"
          >
            {task.company.name}
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * Wann sie fällig ist — relativ und exakt.
 *
 * Die relative Formulierung ist eine Lesehilfe; das exakte `dd.mm.yyyy` steht
 * immer zusätzlich daneben, nie an seiner Stelle. Farbe ist nie das alleinige
 * Signal: Bei Überfälligem steht das Wort „überfällig" im Text selbst.
 */
function TaskDue({
  task,
  todayDay,
  sideBySide = false,
}: {
  task: Task;
  todayDay: string;
  /** In der Karte nebeneinander, in der Tabelle untereinander. */
  sideBySide?: boolean;
}) {
  const overdue = daysUntil(task.dueAt, todayDay) < 0;
  return (
    <div className={sideBySide ? 'flex flex-wrap items-baseline gap-x-2' : ''}>
      <p
        className={
          overdue
            ? 'text-sm font-medium text-gefahr'
            : tableText.compact.primary
        }
      >
        {dueNotice(task.dueAt, todayDay)}
      </p>
      <p className={`ziffern-tabellarisch ${tableText.compact.secondary}`}>
        {formatDate(task.dueAt)}
      </p>
    </div>
  );
}

/** Stabiler Schlüssel: Aufgaben haben serverseitig keine eigene Kennung. */
function key(task: Task, i: number): string {
  return `${task.kind}-${task.company?.id ?? 'none'}-${task.dueAt}-${i}`;
}

/**
 * Meldet, was die Liste NICHT zeigt.
 *
 * Der Server begrenzt jede Art auf `grenzeJeArt` Einträge. Bliebe das
 * unerwähnt, behauptete die Seite Vollständigkeit — und genau darauf verlässt
 * sich jemand, der morgens „nichts mehr offen" liest. Lieber „und 340
 * weitere" als eine stillschweigend halbe Wahrheit.
 */
function TruncationHint({
  truncated,
  limitPerKind,
}: {
  truncated: TaskTruncation[];
  limitPerKind: number;
}) {
  const t = useT();
  if (truncated.length === 0) return null;
  return (
    <div
      role="status"
      className="mt-3 rounded-lg border border-rahmen bg-flaeche-2 px-4 py-3"
    >
      <p className="text-sm font-medium text-text">{t('dashboard.truncationTitle')}</p>
      <ul className="mt-1 list-inside list-disc text-sm text-leise">
        {truncated.map((k) => (
          <li key={k.kind}>
            {t('dashboard.truncationLine', { label: taskLabel(k.kind), shown: k.shown, total: k.shown + k.further })}<span className="font-medium text-text">
              {t('dashboard.truncationHidden', { more: k.further })}</span>
            .
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-leise">
        {t('dashboard.truncationLimit', { limit: limitPerKind })}</p>
    </div>
  );
}

/**
 * Dashboard der Verwaltung: die Aufgabenliste, sonst nichts.
 *
 * KEINE KENNZAHLEN-KACHELN, KEINE DIAGRAMME — unverändert aus Etappe 1. Ein
 * Ein-Personen-Betrieb braucht morgens keine Statistik, sondern die Liste der
 * Dinge, die heute anstehen, jede mit einer benannten Handlung daneben.
 *
 * ZWEI DARSTELLUNGEN, EINE DATENQUELLE. Unter 640 px gestapelte Karten, ab
 * dort die Tabelle. Grund: In der Tabelle liegt die Handlung in der dritten
 * Spalte, und die war bei 375 px nur nach seitlichem Schieben erreichbar. Für
 * die Einstiegsseite eines täglich benutzten Werkzeugs, deren einziger Zweck
 * „die nächste Handlung ausführen" ist, ist das der falsche Kompromiss — eine
 * Aufgabenliste, deren Knopf man erst wegscrollen muss, verfehlt ihren Zweck.
 * Bei drei Feldern je Zeile kostet die gestapelte Form nichts.
 *
 * REIHENFOLGE KOMMT VOM SERVER und wird hier nicht nachsortiert. Er ordnet
 * nach Dringlichkeit und darin nach Fälligkeit — und weil die Dringlichkeit
 * selbst aus der Fälligkeit abgeleitet ist (überfällig, binnen einer Woche,
 * später), ist das Ergebnis genau die chronologische Reihenfolge nach
 * Fälligkeit: das am längsten Überfällige oben.
 *
 * DIESELBE ORGANISATION KANN MEHRFACH ERSCHEINEN, und das bleibt so. Eine 25
 * Monate alte, unbeantwortete Anfrage erzeugt zwei Aufgaben zugleich: „Anfrage
 * ist unbeantwortet" und „Kontaktdaten prüfen" (Löschvorschlag nach 24
 * Monaten). Beide Aussagen stimmen, und sie verlangen ENTGEGENGESETZTE
 * Handlungen — die eine, sich zu melden, die andere, die Daten loszuwerden.
 * Fasste die Oberfläche sie zu einer Zeile zusammen, müsste sie eine der
 * beiden Handlungen weglassen; ausgerechnet die Löschprüfung ist aber eine
 * Aufbewahrungspflicht und darf nicht hinter einer Vertriebsaufgabe
 * verschwinden.
 */
/**
 * Die Filtergruppen der Aufgabenliste.
 *
 * SIE GRUPPIEREN NACH ART, NICHT NACH DRINGLICHKEIT. Dringlichkeit steht
 * schon in der Fälligkeitsspalte und in der Sortierung; eine zweite Ordnung
 * daneben hiesse zweimal dasselbe. Wonach man wirklich filtert, ist die Art
 * der Arbeit: Anfragen beantworten ist etwas anderes als Rechnungen schreiben.
 */
function taskGroups(t: TFunction): { value: string; label: string; kinds: TaskKind[] }[] {
  return [
  { value: 'all', label: t('dashboard.groupAll'), kinds: [] },
  {
    value: 'inquiries',
    label: t('dashboard.groupInquiries'),
    kinds: ['inquiry_unanswered'],
  },
  {
    value: 'review',
    label: t('dashboard.groupReview'),
    kinds: ['review_date'],
  },
  {
    value: 'invoices',
    label: t('dashboard.groupInvoices'),
    kinds: ['invoice_due', 'invoice_overdue', 'price_info_missing', 'tier_check'],
  },
  {
    value: 'other',
    label: t('dashboard.groupOther'),
    kinds: [
      'status_change_automatic',
      'deletion_suggestion',
      'audit_retention',
      'outbox_disrupted',
    ],
  },
  {
    value: 'instances',
    label: t('dashboard.groupInstances'),
    kinds: [
      'backup_missing',
      'metrics_query_failed',
      'reconciliation_deviation',
      'no_entry_for_long',
      'company_name_mismatch',
    ],
  },
  ];
}

export function DashboardPage() {
  const t = useT();
  const groups = taskGroups(t);
  const [data, setData] = useState<TaskList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    setData(null);
    setLoadError(null);
    try {
      // Ohne `seit` gilt serverseitig eine Woche Rückschau für automatische
      // Statuswechsel. Ein Feld für „letzter Besuch" gibt es im Datenmodell
      // nicht; die Vorgabe zu übernehmen ist ehrlicher, als hier eine
      // erfundene Marke zu setzen.
      setData(await fetchTasks());
    } catch (f) {
      setLoadError(errorText(f, t('dashboard.loadError')));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const allTasks = data?.tasks ?? [];
  const group = groups.find((g) => g.value === filter) ?? groups[0];
  const tasks =
    group.kinds.length === 0
      ? allTasks
      : allTasks.filter((a) => group.kinds.includes(a.kind));

  /**
   * Die Zahlen der Chips beziehen sich IMMER auf die ganze Liste, nie auf die
   * gerade gefilterte — sonst zeigte jeder Chip ausser dem gewaehlten eine
   * Null, und die Leiste waere genau dann nutzlos, wenn man sie braucht.
   *
   * Eine Gruppe OHNE Aufgaben verschwindet: Anders als bei den Statuschips
   * der Organisationsliste ist hier keine feste Ordnung zu wahren, und eine
   * Leiste mit fuenf Nullen sagt nur, dass nichts zu tun ist — das steht dann
   * ohnehin im Leerzustand.
   */
  const chips = groups.map((g) => ({
    value: g.value,
    label: g.label,
    count:
      g.kinds.length === 0
        ? allTasks.length
        : allTasks.filter((a) => g.kinds.includes(a.kind)).length,
  })).filter((c) => c.value === 'all' || c.count > 0);

  return (
    <section aria-labelledby="dashboard-title">
      {/* „HEUTE" STATT „DASHBOARD". Der Untertitel „Deine Aufgaben, sortiert
          nach Fälligkeit." entfällt ersatzlos — der Tabellenkopf sagt es
          genauer, und eine Zeile, die nur wiederholt, was darunter steht,
          kostet jeden Blick Zeit. */}
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3">
        <h1
          id="dashboard-title"
          className="font-serif text-[26px] font-bold text-text"
        >{t('dashboard.title')}</h1>
        {data && (
          <span className="text-sm text-still ziffern-tabellarisch">
            {formatDate(data.state.day)}
          </span>
        )}
      </div>

      {/* KEINE KENNZAHL-KACHELN. Der Entwurf zeigt hier vier; das
          Abnahmekriterium E2-24 verlangt ausdrücklich „Aufgabenliste …
          keine Kacheln, keine Diagramme", und der Auftraggeber hat sich
          beim Durchgang dafür entschieden, es bei der Liste zu belassen.
          Die Chips leisten dasselbe: Sie filtern dieselbe Liste, ohne eine
          zweite Ebene über ihr aufzubauen. */}
      {data !== null && data.tasks.length > 0 && (
        <div className="mb-4">
          <FilterChips
            label={t('dashboard.filterCaption')}
            active={filter}
            onSelect={setFilter}
            chips={chips}
          />
        </div>
      )}

      {loadError ? (
        <div className="rounded-xl border border-rahmen bg-flaeche p-6">
          <p role="alert" className="mb-3 text-sm text-text">
            {loadError}
          </p>
          <Button variant="secondary" onClick={() => void load()}>{t('dashboard.retry')}</Button>
        </div>
      ) : data === null ? (
        <div className="flex flex-col gap-2 overflow-hidden rounded-xl border border-rahmen bg-flaeche p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : allTasks.length === 0 ? (
        <div className="overflow-hidden rounded-xl border border-rahmen bg-flaeche">
          <EmptyState
            Icon={ListChecks}
            title={t('dashboard.emptyTitle')}
            notice={t('dashboard.emptyHint')}
          />
        </div>
      ) : (
        <>
          {/* --- Bis 640 px: gestapelte Karten, Handlung immer sichtbar --- */}
          <ul
            aria-label={t('dashboard.openTasksLabel')}
            className="divide-y divide-rahmen overflow-hidden rounded-xl border border-rahmen bg-flaeche sm:hidden"
          >
            {tasks.map((a, i) => (
              <li key={key(a, i)} className="p-4">
                <TaskHeader task={a} />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <TaskDue
                    task={a}
                    todayDay={data.state.day}
                    sideBySide
                  />
                  <TaskAction action={a.action} afterAction={load} />
                </div>
              </li>
            ))}
          </ul>

          {/* --- Ab 640 px: Tabelle mit den Spalten des Entwurfs ---

              DIE BREITEN SIND GEMESSEN, NICHT GESCHAETZT: Mit fuenf Zwoelfteln
              fuer die Aufgabe und einem fuer die Handlung brauchte die Tabelle
              bei 1280 px 996 px in einer 962 px breiten Huelle — die
              Handlungsspalte war halb verdeckt, und genau sie ist der Grund,
              warum die Zeile ueberhaupt da ist. Die Beschriftungen des Servers
              sind laenger als das „Erledigen" des Entwurfs (etwa
              „Ueberpruefung vorbereiten"), die Spalte braucht also wirklich
              Platz. */}
          <div className="hidden sm:block">
            <Table
              columns={[t('dashboard.columnTask'), t('dashboard.columnCompany'), t('dashboard.columnKind'), t('dashboard.columnDue'), t('dashboard.columnAction')]}
              columnsWidths={[
                'w-4/12',
                'w-2/12',
                'w-2/12',
                'w-2/12',
                'w-2/12',
              ]}
              columnsOnlyReadAloud={[false, false, false, false, true]}
              variant="list"
              actionColumn
              minWidth="min-w-[820px]"
              label={t('dashboard.openTasksLabel')}
            >
              {tasks.map((a, i) => (
                <tr key={key(a, i)} className="align-top">
                  <td className={`${tableRow.compact} min-w-0`}>
                    <TaskHeader task={a} />
                  </td>
                  {/* ORGANISATION UND ART BEKOMMEN EIGENE SPALTEN. Bis zum
                      Redesign standen beide im Aufgabenblock — der Name als
                      Link darunter, die Art gar nicht. In einer Liste mit
                      neun Zeilen sucht man aber quer: „welche gehoeren zu
                      dieser Organisation", „was ist davon eine Rechnung". */}
                  <td className={`${tableRow.compact} min-w-0`}>
                    {a.company ? (
                      <Link
                        to={`/companies/${a.company.id}`}
                        className={`block truncate ${tableText.compact.primary} hover:underline`}
                        title={a.company.name}
                      >
                        {a.company.name}
                      </Link>
                    ) : (
                      <span className={tableText.compact.secondary}>—</span>
                    )}
                  </td>
                  <td
                    className={`${tableRow.compact} ${tableText.compact.secondary}`}
                  >
                    {taskLabel(a.kind)}
                  </td>
                  <td className={tableRow.compact}>
                    <TaskDue
                      task={a}
                      todayDay={data.state.day}
                    />
                  </td>
                  <td className={tableRow.compact}>
                    <TaskAction action={a.action} afterAction={load} />
                  </td>
                </tr>
              ))}
            </Table>
          </div>

          {/* Der Leerzustand EINER AUSWAHL — nicht derselbe wie „gar nichts
              offen". Wer filtert und nichts findet, soll das als Ergebnis des
              Filters lesen, nicht als Zustand des Systems. */}
          {tasks.length === 0 && (
            <p className="mt-3 text-sm text-still">{t('dashboard.nothingInSelection')}</p>
          )}

          <TruncationHint
            truncated={data.shortened}
            limitPerKind={data.state.limitPerKind}
          />

          <p className="mt-3 text-xs text-leise">{t('dashboard.stateLabel')}{' '}
            <span className="ziffern-tabellarisch">
              {formatDate(data.state.day)}
            </span>{t('dashboard.statusChangeNotice')}{' '}
            <span className="ziffern-tabellarisch">
              {formatDate(data.state.since)}
            </span>{' '}{t('dashboard.statusChangeNoticeEnd')}</p>
        </>
      )}

      {/* AUSSERHALB des Aufgaben-Zweigs. Ein verwaister Coolify-Eintrag oder
          ein ausgefallener Abgleich verschwände sonst ausgerechnet an dem Tag,
          an dem sonst nichts offen ist — und „Noch nichts zu erledigen" wäre
          dann falsch. */}
      {loadError === null && data !== null && (
        <ReconciliationCard
          orphanedApplications={data.orphanedApplications}
          state={data.state.reconciliation}
          onRun={() => void load()}
        />
      )}
    </section>
  );
}
