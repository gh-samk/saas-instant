import {
  Ban,
  CheckCircle2,
  Clock3,
  HelpCircle,
  MailWarning,
  ShieldOff,
  type LucideIcon,
} from 'lucide-react';
import type { ConsentStatus, MailChannel } from './api';
import { t } from '../i18n';

export interface StatusStyle {
  label: string;
  Icon: LucideIcon;
  surface: string;
  border: string;
  text: string;
}

/**
 * Die fünf Zustände einer Einwilligung — und die eine Aussage, auf die es
 * ankommt: NUR `bestaetigt` erlaubt eine werbliche Mail.
 *
 * Dasselbe Rezept wie `ZAHLUNGSSTAND` und `ORGANISATION_STATUS`: dieselben
 * Token-Kombinationen, kein neuer Farbwert, keine Änderung an `packages/ui`
 * (R7). Jedes Abzeichen trägt Icon UND ausgeschriebenes Label — Farbe ist
 * nirgends das alleinige Signal.
 *
 * WARUM `unbestaetigt` NICHT GRÜN UND NICHT ROT IST. Es ist der Normalfall
 * direkt nach der Eintragung und kein Fehler; es ist aber auch keine
 * Erlaubnis. „Wartet auf Bestätigung" beschreibt genau das, und der Zusatz in
 * `beschreibung` sagt dazu, dass die Zeile nach 72 Stunden verschwindet.
 *
 * WARUM `spam_gemeldet` ALS EINZIGES ROT IST. Einwand/Rot heisst in dieser
 * Anwendung „blockiert, bis es geklärt ist". Bei den drei Sperrzuständen ist
 * genau einer nicht mehr klärbar: Nach einer Beschwerde führt auch eine neue
 * Eintragung nicht zurück. Die beiden anderen sind zurücknehmbar — durch die
 * Person selbst, über das öffentliche Anmeldeformular.
 */
export const CONSENT_STATUS: Record<ConsentStatus, StatusStyle> = {
  unconfirmed: {
    label: t('common.consentStatus.label'),
    Icon: Clock3,
    surface: 'bg-vorschlag-bg',
    border: 'border-vorschlag-rahmen',
    text: 'text-vorschlag-text',
  },
  confirmed: {
    label: t('common.consentStatus.label2'),
    Icon: CheckCircle2,
    surface: 'bg-beschluss-bg',
    border: 'border-beschluss-rahmen',
    text: 'text-beschluss-text',
  },
  unsubscribed: {
    label: t('common.consentStatus.label3'),
    Icon: ShieldOff,
    surface: 'bg-flaeche-3',
    border: 'border-rahmen',
    text: 'text-leise',
  },
  hard_bounced: {
    label: t('common.consentStatus.label4'),
    Icon: MailWarning,
    surface: 'bg-bedenken-bg',
    border: 'border-bedenken-rahmen',
    text: 'text-bedenken-text',
  },
  spam_reported: {
    label: t('common.consentStatus.label5'),
    Icon: Ban,
    surface: 'bg-einwand-bg',
    border: 'border-einwand-rahmen',
    text: 'text-einwand-text',
  },
};

/** Was der Zustand praktisch bedeutet — ein Satz, in ganzen Worten. */
export const CONSENT_DESCRIPTION: Record<ConsentStatus, string> = {
  unconfirmed:
    t('common.consentStatus.unconfirmed'),
  confirmed:
    t('common.consentStatus.confirmed'),
  unsubscribed:
    t('common.consentStatus.unsubscribed'),
  hard_bounced:
    t('common.consentStatus.hardBounced'),
  spam_reported:
    t('common.consentStatus.spamReported'),
};

/**
 * Der Stil zu einem Zustand — mit Rückfallebene.
 *
 * Ein unbekannter Wert aus dem Backend soll ein neutrales Abzeichen ergeben,
 * nicht den Absturz der ganzen Liste. Dieselbe Lehre wie beim Aufgaben-Icon
 * des Dashboards; sie kostet drei Zeilen und spart einen Ausfall an dem Tag,
 * an dem jemand einen Enumwert ergänzt.
 */
export function consentStatusStyle(status: string): StatusStyle {
  return (
    CONSENT_STATUS[status as ConsentStatus] ?? {
      label: status,
      Icon: HelpCircle,
      surface: 'bg-flaeche-3',
      border: 'border-rahmen',
      text: 'text-leise',
    }
  );
}

/**
 * Die Erläuterung zu einem Zustand — mit derselben Rückfallebene wie der Stil.
 *
 * Ein unbekannter Wert soll keine leere Zeile ergeben und erst recht keinen
 * Absturz; er soll sagen, dass die Oberfläche ihn nicht kennt.
 */
export function consentDescription(status: string): string {
  return (
    CONSENT_DESCRIPTION[status as ConsentStatus] ??
    t('common.consentStatus.text')
  );
}

/**
 * DIE ZWEI KANÄLE — und warum sie sich nicht vermischen dürfen.
 *
 * Der Kanal steht an der Vorlage und ist nach dem Anlegen unveränderlich. Wäre
 * er änderbar, liesse sich eine Werbebotschaft nachträglich zur
 * Transaktionsmail erklären und an Leute schicken, die nie eingewilligt haben
 * — R3 wäre über einen Datenbankwert aushebelbar.
 */
/**
 * ANZEIGEREIHENFOLGE — werblich zuerst.
 *
 * `MAIL_KANAELE` steht im DTO alphabetisch („transaktion", „werblich"), und
 * genau diese Reihenfolge wäre hier falsch: Auf einer Seite namens „Rundmail"
 * ist die werbliche Vorlage die Arbeit und die transaktionale die Randnotiz.
 * Bei 375 px stand der Nebenschauplatz sonst zuoberst und die eigentliche
 * Liste erst nach einem Bildschirm Text — gemessen, nicht vermutet.
 */
export const CHANNEL_ORDER: readonly MailChannel[] = [
  'marketing',
  'transactional',
];

export const CHANNEL_TEXTS: Record<
  MailChannel,
  { label: string; heading: string; short: string; long: string }
> = {
  marketing: {
    label: t('common.consentStatus.label6'),
    heading: t('common.consentStatus.heading'),
    short: t('common.consentStatus.short'),
    long: t('common.consentStatus.long'),
  },
  transactional: {
    label: t('common.consentStatus.label7'),
    heading: t('common.consentStatus.heading2'),
    short: t('common.consentStatus.short2'),
    long: t('common.consentStatus.long2'),
  },
};
