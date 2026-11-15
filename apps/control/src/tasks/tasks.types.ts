import type { CompanyStatus } from '.prisma/control-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { OutboxSituation } from '../outbox/outbox.types';
import type { PriceTable } from '../invoices/pricing.types';

/**
 * Die Arten von Aufgaben, die aus dem Datenbestand ABGELEITET werden.
 *
 * Aufgaben werden NIE gespeichert. Sie entstehen bei jeder Abfrage neu aus
 * dem, was in der Datenbank steht. Eine gespeicherte Aufgabenliste müsste
 * gepflegt, abgeglichen und aufgeräumt werden und wäre nach dem ersten
 * Fehlschlag falsch — eine abgeleitete kann gar nicht veralten.
 *
 * Die Liste ist in Etappe 3 um fünf Arten gewachsen (Sicherung ausgeblieben,
 * Kennzahlen-Abfrage fehlgeschlagen, Abgleich-Abweichung, seit 45 Tagen kein
 * Eintrag, Organisationsname weicht ab) — als weitere `TaskSource`, ohne
 * eine einzige Änderung an der Struktur. Genau so war es vorgesehen.
 *
 * KEINE DIESER QUELLEN SCHREIBT (R4/R5). Sie lesen den Datenbestand und
 * schlagen etwas vor; entschieden wird von Hand.
 */
export const TASKS_KINDS = [
  'inquiry_unanswered',
  'review_date',
  'status_change_automatic',
  'deletion_suggestion',
  'price_info_missing',
  'audit_retention',
  // --- Etappe 3: Instanzen ---
  'backup_missing',
  'metrics_query_failed',
  'reconciliation_deviation',
  'no_entry_for_long',
  'company_name_mismatch',
  // --- Etappe 4: Rechnungen ---
  //
  // Wieder nur eine weitere `TaskSource`, ohne Aenderung an der Struktur.
  // Ueberfaelligkeit ist ausdruecklich ABGELEITET und kein geschriebener
  // Status: Ihn zu setzen waere ein automatischer Schreibvorgang MIT
  // Geldfolge, und genau den schliesst R5 aus.
  'invoice_overdue',
  // Die beiden Arten, die das Auftragsdokument zu Etappe 4 nennt und die
  // damals bewusst NICHT gebaut wurden: Es gab keine Oberfläche dafür, und
  // eine Aufgabenart ohne Eintrag in `src/lib/aufgaben.ts` hätte die
  // Startseite an dem Tag ausgeschaltet, an dem die erste Aufgabe dieser Art
  // entsteht. Reihenfolge deshalb wie beim letzten Mal: erst die Oberfläche,
  // dann diese Zeilen, dann `Sources`.
  //
  // BEIDE SCHLAGEN VOR, KEINE VOLLZIEHT (R5). „Rechnung fällig" legt keine
  // Rechnung an — es gibt keinen Codepfad, der das täte. „Stufe prüfen"
  // ändert keine Preisvereinbarung, sondern legt sie zur Entscheidung vor.
  'invoice_due',
  'tier_check',
  // Ohne Organisationsbezug. Der Stand kommt aus dem PostausgangService.
  'outbox_disrupted',
] as const;

export type TasksKind = (typeof TASKS_KINDS)[number];

/**
 * Dringlichkeit — abgeleitet aus der Fälligkeit, nicht von Hand gesetzt.
 * `high` = überfällig, `medium` = binnen einer Woche, `low` = später.
 */
export type Urgency = 'high' | 'medium' | 'low';

/**
 * Die benannte Handlung einer Aufgabe.
 *
 * `kind` ist die Handlung selbst (was zu tun ist), `target` sagt, wo sie
 * stattfindet. Damit kann die spätere Oberfläche eine Schaltfläche bauen, ohne
 * die Aufgabenart zu kennen.
 *
 * `loeschung_pruefen` ist ein VORSCHLAG (R4). Es gibt keine Handlung, die von
 * hier aus etwas löscht, und keinen Endpunkt dafür.
 */
export type ActionKind =
  | 'company_open'
  | 'status_change'
  | 'deletion_check'
  | 'price_agree'
  | 'retention_check'
  // Etappe 4: fuehrt zur Rechnung. Sie LOEST NICHTS AUS — weder eine Mahnung
  // noch eine Statusaenderung; der Zahlungseingang wird von Hand vermerkt.
  | 'payment_check'
  // Fuehrt zur Rechnungsliste der Organisation. Sie LEGT NICHTS AN: Zeitraum,
  // Posten und Betraege entscheidet die Betreiberin im Entwurfsformular (R5).
  | 'invoice_create'
  // Der einzige KNOPF unter den Handlungen: löst eine Probe des Postausgangs
  // aus (anmelden, keine Mail). `target` bleibt leer.
  | 'outbox_check';
// „Stufe pruefen" bekommt KEINE eigene HandlungsArt. Die Handlung ist
// dieselbe wie bei `preisangabe_fehlt` — die Preisvereinbarung anfassen —,
// und `preis_vereinbaren` gibt es dafuer schon. Eine zweite Art mit demselben
// Ziel waere ein weiterer Eintrag in einer ueber die Modulgrenze gespiegelten
// Abbildung, ohne dass die Oberflaeche etwas anderes taete.
// Die fuenf Etappe-3-Arten brauchen KEINE neue HandlungsArt: Sie fuehren alle
// zur Organisation, und `organisation_oeffnen` gibt es bereits. Eine eigene
// Handlung je Art waere eine zweite Bedeutungsebene ohne Nutzen — und keine
// von ihnen darf etwas ausloesen, was ueber das Oeffnen hinausgeht (R1, R4).

export interface Action {
  kind: ActionKind;
  label: string;
  target: string;
}

export interface Task {
  kind: TasksKind;
  /** Tagesdatum, an dem die Aufgabe fällig ist oder wurde. */
  dueAt: string;
  urgency: Urgency;
  title: string;
  reason: string;
  action: Action;
  /**
   * Bezug zur Organisation — OPTIONAL.
   *
   * Es gibt Aufgaben, die keine einzelne Organisation betreffen: die
   * Aufbewahrungsfrist des Audit-Logs gilt für den ganzen Bestand ([W5]).
   */
  company?: {
    id: string;
    name: string;
    status: CompanyStatus;
  };
}

/** Was jede Quelle zum Rechnen braucht. */
export interface TasksContext {
  prisma: PrismaService;
  /** Heutiger Kalendertag `YYYY-MM-DD`. */
  todayDay: string;
  /** Jetzt, für die einzige Regel mit Stundengenauigkeit (24 Stunden). */
  now: Date;
  /**
   * „Seit dem letzten Blick": ab wann automatische Statuswechsel gemeldet
   * werden. Kommt vom Aufrufer, weil es im Datenmodell kein Feld dafür gibt —
   * und ist nach hinten BEGRENZT (`LOOKBACK_MAX_DAYS`), damit sich die Liste
   * nicht über einen weit zurückliegenden Tag beliebig aufblähen lässt ([W7]).
   */
  since: string;
  /**
   * Höchstzahl Aufgaben JE ART. Jede Quelle holt höchstens so viele Zeilen und
   * nennt daneben, wie viele es insgesamt gäbe.
   *
   * Ohne Grenze lieferte die Abfrage bei 5000 Organisationen gut 5000 Aufgaben
   * und zwei Megabyte in einer einzigen Antwort ([W7]) — eine Liste, die
   * niemand liest, an einer Stelle, die den Tag ordnen soll.
   */
  limit: number;
  /**
   * Die geltende Preistafel — Stufen, Schwellen und der Zeitraum, ueber den
   * der Durchschnitt gebildet wird.
   *
   * Sie steht im KONTEXT und wird nicht in der Quelle gelesen, weil sie aus
   * der Umgebung kommt (`CONTROL_PRICE_TABLE`) und ein `PricingConfigService`
   * dafuer noetig ist. Eine Quelle ist ein einfaches Objekt ohne
   * NestJS-Einbindung; bekaeme sie den Dienst einzeln, muesste jede kuenftige
   * Quelle wissen, wie man an ihn kommt.
   *
   * SIE DARF NICHT AUS DEN VORGABEN GERATEN WERDEN. Eine ueberschriebene
   * Preistafel und die Vorgaben des Auftrags koennen verschiedene Schwellen
   * haben; die Aufgabe „Stufe pruefen" waere dann eine Aussage ueber Preise,
   * die niemand vereinbart hat.
   */
  priceTable: PriceTable;
  /** Stand beider Postausgänge — aus dem Speicher, ohne neue Probe. */
  outbox: readonly OutboxSituation[];
}

/**
 * Eine Quelle liefert Aufgaben genau einer Art.
 *
 * Neue Arten werden hier angesteckt und in `Sources` eingetragen — kein
 * Umbau am Dienst, keine Verzweigung, die mitwachsen muss.
 */
/**
 * Was eine Quelle liefert: die (gekappte) Liste und wie viele es insgesamt
 * gäbe. Beides zusammen, damit die Oberfläche „… und N weitere" schreiben kann,
 * ohne die N erst selbst zu zählen.
 */
export interface SourceResult {
  tasks: Task[];
  total: number;
}

export interface TaskSource {
  kind: TasksKind;
  collect(context: TasksContext): Promise<SourceResult>;
}
