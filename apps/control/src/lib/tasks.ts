import {
  Archive,
  Building2,
  CalendarClock,
  Clock,
  FileSearch,
  FileWarning,
  HelpCircle,
  Landmark,
  MailWarning,
  MailX,
  ReceiptText,
  RefreshCw,
  Scale,
  Tag,
  UserMinus,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { TaskKind, Urgency } from './api';
import { t } from '../i18n';

/**
 * Icon je Aufgabenart.
 *
 * Die Aufgabenkreise sind ALLE `bg-primaer-soft text-primaer` — bewusst keine
 * zweite Farbskala nach Dringlichkeit oder Art. Die acht Organisationsstatus
 * haben bereits eine gelernte Farbsprache; eine konkurrierende zweite hätte
 * zwei verschiedene Bedeutungen von „Rot" nebeneinander gestellt.
 * Unterschieden werden die Arten über Icon und Text.
 */
export const TASK_ICON: Record<TaskKind, LucideIcon> = {
  inquiry_unanswered: MailWarning,
  review_date: CalendarClock,
  status_change_automatic: RefreshCw,
  deletion_suggestion: UserMinus,
  price_info_missing: Tag,
  audit_retention: Archive,
  // --- Etappe 3: Instanzen ---
  backup_missing: FileWarning,
  metrics_query_failed: WifiOff,
  reconciliation_deviation: FileSearch,
  no_entry_for_long: Clock,
  company_name_mismatch: Building2,
  // --- Etappe 4: Rechnungen ---
  // `Landmark` (Bankgebäude) statt eines Geldzeichens: Die übrigen zehn Icons
  // sind Vorgangs- und Werkzeugsymbole, keines ist ein Bedeutungsträger für
  // „Geld". Ein Warnsymbol wäre hier ebenfalls falsch — die Dringlichkeit
  // steht bereits in der Fälligkeitsspalte.
  invoice_overdue: Landmark,
  // `ReceiptText` (Beleg mit Zeilen) für die noch zu SCHREIBENDE Rechnung,
  // `Landmark` bleibt für die überfällige: Die eine ist Schreibtischarbeit,
  // die andere eine offene Forderung. Zwei Vorgänge, zwei Symbole.
  invoice_due: ReceiptText,
  // `Scale` (Waage) für die Preisstufe — ein Abwägen, kein Alarm. Die
  // Dringlichkeit steht in der Fälligkeitsspalte, nicht im Icon.
  tier_check: Scale,
  outbox_disrupted: MailX,
};

/**
 * Deutsche Bezeichnung je Art — für die Meldung über abgeschnittene Listen.
 *
 * Der Titel einer einzelnen Aufgabe nennt immer die betroffene Organisation
 * („Anfrage von X ist unbeantwortet") und taugt deshalb nicht als Name der
 * GATTUNG. „Bei Anfragen ohne Reaktion werden 25 von 365 gezeigt" braucht
 * genau diesen Gattungsnamen.
 */
export const TASK_LABEL: Record<TaskKind, string> = {
  inquiry_unanswered: t('common.tasks.inquiryUnanswered'),
  review_date: t('common.tasks.reviewDate'),
  status_change_automatic: t('common.tasks.statusChangeAutomatic'),
  deletion_suggestion: t('common.tasks.deletionSuggestion'),
  price_info_missing: t('common.tasks.priceInfoMissing'),
  audit_retention: t('common.tasks.auditRetention'),
  // --- Etappe 3: Instanzen ---
  backup_missing: t('common.tasks.backupMissing'),
  metrics_query_failed: t('common.tasks.metricsQueryFailed'),
  reconciliation_deviation: t('common.tasks.reconciliationDeviation'),
  no_entry_for_long: t('common.tasks.noEntryForLong'),
  company_name_mismatch: t('common.tasks.companyNameMismatch'),
  // --- Etappe 4: Rechnungen ---
  invoice_overdue: t('common.tasks.invoiceOverdue'),
  invoice_due: t('common.tasks.invoiceDue'),
  tier_check: t('common.tasks.tierCheck'),
  outbox_disrupted: t('common.tasks.outboxDisrupted'),
};

/**
 * DAS NETZ UNTER DEN BEIDEN TABELLEN.
 *
 * `AUFGABEN_ICON[art]` direkt zu indizieren sieht harmlos aus und ist es
 * nicht: Fehlt ein Eintrag, ist das Ergebnis `undefined`, und `<undefined />`
 * beendet das Rendern der GANZEN Dashboard-Seite. Der Typprüfer fängt das
 * nicht, sobald die Art aus einer Server-Antwort stammt statt aus dem
 * Literal — dort ist sie zur Laufzeit ein beliebiger String.
 *
 * Genau dieser Fall stand kurz bevor: Die Aufgabenquelle
 * `rechnung_ueberfaellig` war im Backend fertig, durfte aber nicht
 * registriert werden, weil die Startseite an dem Tag abgestürzt wäre, an dem
 * die erste Rechnung überfällig wird — also genau dann, wenn man sie braucht.
 *
 * Der Rückfall ist bewusst NEUTRAL (`HelpCircle`, kein Alarmzeichen): Eine
 * unbekannte Aufgabenart ist ein Wartungsversäumnis der Oberfläche, keine
 * Störung, über die die Nutzerin sich Sorgen machen soll.
 */
export function taskIcon(kind: TaskKind): LucideIcon {
  return TASK_ICON[kind] ?? HelpCircle;
}

/**
 * Dasselbe für die Bezeichnung — letzter Ausweg ist der rohe Schlüssel.
 *
 * Er ist hässlich, aber lesbar; ein `undefined` im Satz „Bei … werden 25 von
 * 365 gezeigt" wäre es nicht.
 */
export function taskLabel(kind: TaskKind): string {
  return TASK_LABEL[kind] ?? kind;
}

/**
 * Der Punkt vor einer Aufgabe — dieselbe Farbfamilie wie überall.
 *
 * Er ist ZUGABE, nie das alleinige Signal: Daneben steht der Titel, und die
 * Fälligkeit steht ausgeschrieben. Wer nur den Punkt sähe, wüsste nichts.
 */
export const TASK_URGENCY_POINT: Record<Urgency, string> = {
  high: 'bg-einwand-rahmen',
  medium: 'bg-bedenken-rahmen',
  low: 'bg-vorschlag-rahmen',
};
