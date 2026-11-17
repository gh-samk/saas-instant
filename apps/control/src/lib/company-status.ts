import {
  Archive,
  CreditCard,
  Gift,
  Inbox,
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
 * Zustand kommt im Lebenszyklus einer Organisation nicht vor. „Beendet"
 * trägt deshalb die neutrale Graukombination: Eine regulär beendete
 * Kundenbeziehung ist kein Alarm.
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
  trial: {
    label: t('common.companyStatus.label2'),
    Icon: Rocket,
    surface: 'bg-bedenken-bg',
    border: 'border-bedenken-rahmen',
    text: 'text-bedenken-text',
  },
  paying: {
    label: t('common.companyStatus.label3'),
    Icon: CreditCard,
    surface: 'bg-beschluss-bg',
    border: 'border-beschluss-rahmen',
    text: 'text-beschluss-text',
  },
  exempt: {
    label: t('common.companyStatus.label4'),
    Icon: Gift,
    surface: 'bg-beschluss-bg',
    border: 'border-beschluss-rahmen',
    text: 'text-beschluss-text',
  },
  ended: {
    label: t('common.companyStatus.label5'),
    Icon: Archive,
    surface: 'bg-flaeche-3',
    border: 'border-rahmen',
    text: 'text-leise',
  },
};

/** Reihenfolge für Filter und Statuswechsel — die des Enums im Schema. */
export const STATUS_ORDER: CompanyStatus[] = [
  'inquiry',
  'trial',
  'paying',
  'exempt',
  'ended',
];

/** Ist die Zeichenkette einer der fünf Status? Für Werte aus der URL. */
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
 * Die Filterchips der Organisationsliste: „Alle" und einer je Status.
 *
 * Ein alter Link mit `?status=pilot` (oder einem anderen früheren Wert) findet
 * keinen Chip und fällt in `CompaniesPage` auf „Alle" zurück.
 */
export interface StatusChip {
  /** Wert für die URL. Leer heisst „alle". */
  value: string;
  label: string;
  /** Welche Status dieser Chip zählt. */
  status: CompanyStatus[];
}

export const STATUS_CHIPS: StatusChip[] = [
  { value: '', label: t('common.companyStatus.all'), status: STATUS_ORDER },
  ...STATUS_ORDER.map((status) => ({
    value: status,
    label: COMPANY_STATUS[status].label,
    status: [status],
  })),
];
