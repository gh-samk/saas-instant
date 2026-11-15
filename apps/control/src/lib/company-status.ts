import {
  Archive,
  CalendarClock,
  ClipboardCheck,
  CreditCard,
  Inbox,
  PauseCircle,
  PlayCircle,
  Rocket,
  type LucideIcon,
} from 'lucide-react';
import type { CompanyStatus } from './api';
import { t } from '../i18n';

export interface CompanyStatusStyle {
  label: string;
  Icon: LucideIcon;
  surface: string;
  border: string;
  text: string;
}

/**
 * CRM-eigene Statusfarben.
 *
 * Bewusst NICHT in `EINTRAG` (packages/ui) ergänzt: `EINTRAG` ist die
 * dokumentierte Quelle der soziokratischen Eintragstypen (docs/03) —
 * Organisationsstatus ist ein anderes, CRM-eigenes Konzept. Verwendet werden
 * dieselben vier Token-Kombinationen plus die im Projekt bereits übliche
 * neutrale Graukombination; es entsteht KEIN neuer Tokenwert und keine
 * Änderung an packages/ui (R7).
 *
 * Zuordnung entlang der BEDEUTUNG der vier Eintragsfarben: Vorschlag = etwas
 * liegt vor, nichts ist entschieden; Beschluss = entschieden und tragend;
 * Bedenken = läuft, braucht aber einen Blick.
 *
 * „Einwand" (rot) wird hier von KEINEM Status benutzt. Es bedeutet in der
 * Hauptanwendung „blockiert einen Beschluss, bis er geklärt ist" — dieser
 * Zustand kommt im Lebenszyklus einer Organisation nicht vor. „Ruhend" und
 * „Beendet" tragen deshalb beide die neutrale Graukombination: Weder eine
 * pausierte noch eine regulär beendete Kundenbeziehung ist ein Alarm.
 *
 * Die Labels sind wortgleich mit `STATUS_BEZEICHNUNG` im Backend
 * (`apps/control/src/organisation/status-bezeichnung.ts`), damit Abzeichen und
 * Notiztext im Verlauf dieselben Wörter benutzen.
 */
export const COMPANY_STATUS: Record<
  CompanyStatus,
  CompanyStatusStyle
> = {
  inquiry: {
    label: t('common.companyStatus.label'),
    Icon: Inbox,
    surface: 'bg-vorschlag-bg',
    border: 'border-vorschlag-rahmen',
    text: 'text-vorschlag-text',
  },
  demo: {
    label: t('common.companyStatus.label2'),
    Icon: PlayCircle,
    surface: 'bg-vorschlag-bg',
    border: 'border-vorschlag-rahmen',
    text: 'text-vorschlag-text',
  },
  pilot_approved: {
    label: t('common.companyStatus.label3'),
    Icon: ClipboardCheck,
    surface: 'bg-beschluss-bg',
    border: 'border-beschluss-rahmen',
    text: 'text-beschluss-text',
  },
  pilot_running: {
    label: t('common.companyStatus.label4'),
    Icon: Rocket,
    surface: 'bg-beschluss-bg',
    border: 'border-beschluss-rahmen',
    text: 'text-beschluss-text',
  },
  paying: {
    label: t('common.companyStatus.label5'),
    Icon: CreditCard,
    surface: 'bg-beschluss-bg',
    border: 'border-beschluss-rahmen',
    text: 'text-beschluss-text',
  },
  review_pending: {
    label: t('common.companyStatus.label6'),
    Icon: CalendarClock,
    surface: 'bg-bedenken-bg',
    border: 'border-bedenken-rahmen',
    text: 'text-bedenken-text',
  },
  // NEUTRAL, nicht rot. „Einwand" heißt in der Hauptanwendung konkret
  // „blockiert einen Beschluss, bis er geklärt ist". Eine ruhende Organisation
  // blockiert nichts und wartet auf keine Klärung — Rot behauptete hier eine
  // Dringlichkeit, die es fachlich nicht gibt, und schwächte über die Zeit die
  // gelernte Kopplung „Rot = aktiver Einwand". Unterschieden von „Beendet"
  // wird sie über Icon und Label, nicht über die Farbe.
  dormant: {
    label: t('common.companyStatus.label7'),
    Icon: PauseCircle,
    surface: 'bg-flaeche-3',
    border: 'border-rahmen',
    text: 'text-leise',
  },
  ended: {
    label: t('common.companyStatus.label8'),
    Icon: Archive,
    surface: 'bg-flaeche-3',
    border: 'border-rahmen',
    text: 'text-leise',
  },
};

/** Reihenfolge für Filter und Statuswechsel — die des Enums im Schema. */
export const STATUS_ORDER: CompanyStatus[] = [
  'inquiry',
  'demo',
  'pilot_approved',
  'pilot_running',
  'paying',
  'review_pending',
  'dormant',
  'ended',
];

/** Ist die Zeichenkette einer der acht Status? Für Werte aus der URL. */
export function isCompanyStatus(
  value: string,
): value is CompanyStatus {
  return (STATUS_ORDER as string[]).includes(value);
}

/** Deutsche Bezeichnungen der Herkunft einer Anfrage. */
export const SOURCE_LABEL: Record<
  'form' | 'phone' | 'referral' | 'event',
  string
> = {
  form: t('common.companyStatus.form'),
  phone: t('common.companyStatus.phone'),
  referral: t('common.companyStatus.referral'),
  event: t('common.companyStatus.event'),
};

/** Deutsche Bezeichnungen der Zahlungsweise. */
export const PAYMENT_INTERVAL_LABEL: Record<
  'yearly' | 'half_yearly' | 'monthly',
  string
> = {
  yearly: t('common.companyStatus.yearly'),
  half_yearly: t('common.companyStatus.halfYearly'),
  monthly: t('common.companyStatus.monthly'),
};

/**
 * Lastschrift oder Überweisung — im Klartext.
 *
 * Die Reihenfolge ist die der Webseite: Lastschrift zuerst, weil sie der
 * Regelfall ist und bei monatlicher Zahlung der einzige.
 */
export const PAYMENT_METHOD_LABEL: Record<'direct_debit' | 'bank_transfer', string> = {
  direct_debit: t('common.companyStatus.directDebit'),
  bank_transfer: t('common.companyStatus.bankTransfer'),
};

/**
 * Die Filterchips der Organisationsliste — SIEBEN, nicht acht.
 *
 * WARUM SIE NICHT EINS ZU EINS DEN STATUS ENTSPRECHEN. Das Enum hat acht
 * Werte, zwei davon beschreiben denselben Lebensabschnitt: `pilot_beschlossen`
 * heisst „entschieden, läuft noch nicht", `pilot_laufend` heisst „läuft".
 * Wer die Liste durchsieht, sucht „die Piloten" — nicht die eine oder die
 * andere Hälfte davon. Beide bekommen deshalb EINEN Chip; die Pille in der
 * Zeile zeigt weiterhin den genauen Wert, damit nichts falsch behauptet wird.
 *
 * `ueberpruefung_offen` hat dagegen einen EIGENEN Chip, obwohl die
 * Organisation weiter zahlt. Der nächtliche Zeitplan setzt diesen Status von
 * selbst, sieben Monate nach dem Pilotbeschluss — eine Filterleiste, die ihn
 * nicht kennt, versteckt genau die Fälle, die das System gerade vorlegt.
 */
export interface StatusChip {
  /** Wert für die URL. Leer heisst „alle". */
  value: string;
  label: string;
  /** Welche Status dieser Chip zählt. */
  status: CompanyStatus[];
}

export const STATUS_CHIPS: StatusChip[] = [
  { value: '', label: t('common.companyStatus.label9'), status: STATUS_ORDER },
  { value: 'inquiry', label: t('common.companyStatus.label'), status: ['inquiry'] },
  { value: 'demo', label: t('common.companyStatus.label2'), status: ['demo'] },
  {
    value: 'pilot',
    label: t('common.companyStatus.label10'),
    status: ['pilot_approved', 'pilot_running'],
  },
  { value: 'paying', label: t('common.companyStatus.label5'), status: ['paying'] },
  {
    value: 'review_pending',
    label: t('common.companyStatus.label11'),
    status: ['review_pending'],
  },
  { value: 'dormant', label: t('common.companyStatus.label7'), status: ['dormant'] },
  { value: 'ended', label: t('common.companyStatus.label8'), status: ['ended'] },
];
