import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks } from 'lucide-react';
import {
  Button,
  EmptyState,
  NoticeBar,
  Skeleton,
} from '@saas-instant/ui';
import { ReconciliationCard } from '../components/ReconciliationCard';
import { TaskAction } from '../components/TaskAction';
import { TaskInvoiceActions } from '../components/InvoiceQuickActions';
import { errorText } from '../lib/api-client';
import {
  fetchTasks,
  type Task,
  type TaskKind,
  type TaskTruncation,
  type TaskList,
} from '../lib/api';
import { taskLabel, taskIcon } from '../lib/tasks';
import { tableText } from '../lib/density';
import { dateInText, formatDate } from '../utils/date';
import { dueNotice, daysUntil } from '../utils/due-date';
import { useT, type TFunction } from '../i18n';

/**
 * Was die Aufgabe ist: Icon, Titel, Begründung, betroffene Organisation.
 *
 * Rechnungsaufgaben tragen einen KURZEN Titel („Rechnung DEMO-0005 überfällig
 * · 629,51 €") und eine einzige Zeile darunter: Organisation und Alter
 * („Steinbock Bergwacht-Förderkreis · seit 61 Tagen"). Der Titel ist dort der
 * Link zur Rechnung — die eigentlichen Handlungen sind die Knöpfe daneben.
 * Alle anderen Arten behalten Titel, Begründung und darunter die
 * Organisation.
 *
 * Organisationsnamen werden NIE abgeschnitten (`break-words`): Der Name ist
 * der Grund, die Zeile zu lesen, und daneben ist Platz.
 */
function TaskHeader({ task }: { task: Task }) {
  // Über die Funktion, nicht über den Record: Eine Aufgabenart, die die
  // Oberfläche noch nicht kennt, ergäbe sonst `undefined` als Komponente und
  // risse die ganze Startseite mit.
  const Icon = taskIcon(task.kind);
  const isInvoice = task.kind === 'invoice_overdue';
  const companyLink = task.company && (
    <Link
      to={`/companies/${task.company.id}`}
      className="break-words text-primaer underline underline-offset-2 hover:text-primaer-hover"
    >
      {task.company.name}
    </Link>
  );
  return (
    <div className="flex min-w-0 items-start gap-3">
      {/* Alle Aufgabenkreise tragen dieselbe Farbe: Die acht
          Organisationsstatus haben bereits eine gelernte Farbsprache, eine
          zweite daneben hieße zweimal „was bedeutet Rot hier". Unterschieden
          wird über Icon und Text. */}
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primaer-soft text-primaer">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        {isInvoice && task.action.target.startsWith('/') ? (
          <Link
            to={task.action.target}
            className={`break-words ${tableText.compact.primary} hover:underline`}
          >
            {task.title}
          </Link>
        ) : (
          <p className={`break-words ${tableText.compact.primary}`}>
            {task.title}
          </p>
        )}
        {isInvoice ? (
          <p className={`break-words ${tableText.compact.secondary}`}>
            {companyLink}
            {companyLink && ' · '}
            {task.reason}
          </p>
        ) : (
          <>
            {/* Vier Aufgabenquellen setzen den Kalendertag direkt in ihren
                Text ein („… am 2026-08-31 …"). Das Datumsformat der
                Anwendung ist durchgehend dd.mm.yyyy; die Anzeigeschicht ist
                der letzte Ort, an dem die Regel noch greifen kann. */}
            <p className={`break-words ${tableText.compact.secondary}`}>
              {dateInText(task.reason)}
            </p>
            {/* NICHT jede Aufgabe hängt an einer Organisation: Die
                Aufbewahrungsfrist des Audit-Logs gilt für den ganzen
                Bestand. */}
            {companyLink && <p className="mt-1 text-xs">{companyLink}</p>}
          </>
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
  /** Nebeneinander (schmal) oder untereinander (breit). */
  sideBySide?: boolean;
}) {
  const t = useT();
  const overdue = daysUntil(task.dueAt, todayDay) < 0;
  // Rechnungsaufgaben sagen das Alter schon in der Zeile darunter („seit 61
  // Tagen"). Hier bleibt nur das exakte Datum — die Aussage nicht doppelt.
  if (task.kind === 'invoice_overdue') {
    return (
      <p className={`ziffern-tabellarisch ${tableText.compact.secondary}`}>
        {t('dashboard.dueOn', { date: formatDate(task.dueAt) })}
      </p>
    );
  }
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
 * GRUPPEN MIT ÜBERSCHRIFT STATT REITER PLUS SPALTE „ART". Früher filterte eine
 * Chipleiste die Liste, und eine eigene Spalte nannte die Art. Beides sagte
 * dasselbe aus zwei Richtungen. Jetzt steht über jeder Gruppe ihre
 * Überschrift mit der Zählung (die Zahl der Chips bleibt also erhalten), und
 * die Art ergibt sich aus der Gruppe. Gruppen ohne Aufgaben entfallen.
 *
 * KARTENZEILEN AUF ALLEN BREITEN. Die frühere Tabelle lief bei 768 px
 * seitlich über (fünf Spalten, Mindestbreite 820 px). Eine Zeile aus Aufgabe,
 * Fälligkeit und Knöpfen bricht dagegen von selbst um und braucht keine
 * Mindestbreite — und die Handlung bleibt auch bei 375 px ohne Schieben
 * erreichbar, was der einzige Zweck dieser Seite ist.
 *
 * DER ERKLÄRTEXT STEHT EINMAL. Der Satz zum Zahlungseingang galt für jede
 * überfällige Rechnung und stand viermal fast gleich in der Liste. Er steht
 * jetzt als Hinweis über der Rechnungsgruppe.
 *
 * REIHENFOLGE KOMMT VOM SERVER und wird innerhalb einer Gruppe nicht
 * nachsortiert. Er ordnet nach Dringlichkeit und darin nach Fälligkeit — und
 * weil die Dringlichkeit selbst aus der Fälligkeit abgeleitet ist (überfällig,
 * binnen einer Woche, später), ist das Ergebnis genau die chronologische
 * Reihenfolge nach Fälligkeit: das am längsten Überfällige oben.
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
 * Die Gruppen der Aufgabenliste, in der Reihenfolge der Anzeige.
 *
 * SIE GRUPPIEREN NACH ART, NICHT NACH DRINGLICHKEIT. Dringlichkeit steht
 * schon in der Fälligkeit und in der Sortierung; eine zweite Ordnung daneben
 * hiesse zweimal dasselbe. Wonach man wirklich sucht, ist die Art der Arbeit:
 * Anfragen beantworten ist etwas anderes als Rechnungen schreiben.
 *
 * Eine Aufgabenart, die in keiner Gruppe steht, landet in „Sonstiges" — sie
 * darf nicht verschwinden, nur weil die Oberfläche sie noch nicht kennt.
 */
function taskGroups(t: TFunction): { value: string; label: string; kinds: TaskKind[] }[] {
  return [
    {
      value: 'invoices',
      label: t('dashboard.groupInvoices'),
      kinds: [
        'invoice_due',
        'invoice_overdue',
        'price_info_missing',
        'tier_check',
        'document_tampered',
      ],
    },
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
      value: 'instances',
      label: t('dashboard.groupInstances'),
      kinds: [
        'backup_missing',
        'control_backup_missing',
        'metrics_query_failed',
        'reconciliation_deviation',
        'no_entry_for_long',
        'company_name_mismatch',
      ],
    },
    { value: 'other', label: t('dashboard.groupOther'), kinds: [] },
  ];
}

export function DashboardPage() {
  const t = useT();
  const groups = taskGroups(t);
  const [data, setData] = useState<TaskList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    // Still nachladen (nach einer Direktaktion) lässt die Liste stehen, sonst
    // risse das Skelett die offenen Dialoge und Toasts mit.
    if (!silent) setData(null);
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
  const known = new Set(groups.flatMap((g) => g.kinds));
  const sections = groups
    .map((g) => ({
      ...g,
      tasks: allTasks.filter((a) =>
        g.value === 'other' ? !known.has(a.kind) : g.kinds.includes(a.kind),
      ),
    }))
    .filter((g) => g.tasks.length > 0);

  return (
    <section aria-labelledby="dashboard-title">
      {/* „HEUTE" STATT „DASHBOARD". Der Untertitel „Deine Aufgaben, sortiert
          nach Fälligkeit." entfällt ersatzlos — eine Zeile, die nur
          wiederholt, was darunter steht, kostet jeden Blick Zeit. */}
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3">
        <h1
          id="dashboard-title"
          className="text-2xl font-semibold tracking-tight text-text"
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
          beim Durchgang dafür entschieden, es bei der Liste zu belassen. */}
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
          <div className="flex flex-col gap-6">
            {sections.map((group) => (
              <section
                key={group.value}
                aria-labelledby={`group-${group.value}`}
              >
                <h2
                  id={`group-${group.value}`}
                  className="mb-2 text-base font-semibold text-text"
                >
                  {group.label}{' '}
                  <span className="font-normal text-leise ziffern-tabellarisch">
                    ({group.tasks.length})
                  </span>
                </h2>
                {/* Der Erklärsatz zu überfälligen Rechnungen steht EINMAL über
                    der Gruppe — nicht in jeder Zeile. */}
                {group.tasks.some((a) => a.kind === 'invoice_overdue') && (
                  <NoticeBar kind="notice" className="mb-2">
                    {t('dashboard.overdueHint')}
                  </NoticeBar>
                )}
                <ul
                  aria-label={group.label}
                  className="divide-y divide-rahmen overflow-hidden rounded-xl border border-rahmen bg-flaeche"
                >
                  {group.tasks.map((a, i) => (
                    <li
                      key={key(a, i)}
                      className="flex flex-col gap-3 p-4 md:flex-row md:items-start md:justify-between md:gap-4"
                    >
                      <div className="min-w-0 md:flex-1">
                        <TaskHeader task={a} />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 md:shrink-0 md:justify-end">
                        <TaskDue
                          task={a}
                          todayDay={data.state.day}
                          sideBySide
                        />
                        {a.kind === 'invoice_overdue' && a.invoiceId ? (
                          <TaskInvoiceActions
                            task={a}
                            onChanged={() => void load(true)}
                          />
                        ) : (
                          <TaskAction
                            action={a.action}
                            afterAction={() => void load(true)}
                          />
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

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
          onRun={() => void load(true)}
        />
      )}
    </section>
  );
}
