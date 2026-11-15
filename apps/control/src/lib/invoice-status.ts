import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Clock3,
  FileEdit,
  HelpCircle,
  type LucideIcon,
} from 'lucide-react';
import type { PaymentState } from './api';
import { t } from '../i18n';

export interface PaymentStateStyle {
  label: string;
  Icon: LucideIcon;
  surface: string;
  border: string;
  text: string;
}

/**
 * Statusfarben einer Rechnung — aus der BEDEUTUNG abgeleitet.
 *
 * ES GIBT ZWEI STATUSFELDER UND NUR EINES GEHÖRT HIERHER. `Rechnung.status`
 * ist die rohe Datenbankspalte (`entwurf | festgeschrieben | versendet |
 * bezahlt | teilweise_bezahlt | storniert`); `zahlungsstand` ist der
 * serverseitig abgeleitete Wert, und nur er wird angezeigt. Zwei konkurrierende
 * Abzeichen nebeneinander hießen, dieselbe Frage zweimal zu beantworten — und
 * beim ersten Auseinanderlaufen unterschiedlich.
 *
 * `festgeschrieben` und `versendet` fallen beide unter „Offen", solange die
 * Fälligkeit nicht überschritten ist. Das ist kein Informationsverlust: „schon
 * versendet?" ist eine Verlaufsfrage, keine Statusfrage, und der Verlauf steht
 * auf der Organisationsseite.
 *
 * Dasselbe Rezept wie `ORGANISATION_STATUS`/`INSTANZ_STATUS`: dieselben
 * Token-Kombinationen, kein neuer Wert, keine Änderung an `packages/ui` (R7).
 *
 * WARUM „ÜBERFÄLLIG" NICHT ROT IST. Einwand/Rot bedeutet in dieser Anwendung
 * „blockiert einen Beschluss, bis er geklärt ist" — dieselbe Korrektur wie in
 * Etappe 2 und 3. Eine überfällige Rechnung blockiert im CRM nichts; sie
 * braucht Aufmerksamkeit, wie ein ausgebliebenes Backup. Sie teilt sich die
 * Amber-Familie mit „Teilweise bezahlt" und bewusst auch deren Icon:
 * strukturell ist es dieselbe Aussage „braucht einen Blick", und ein
 * schärferes Icon behauptete eine Rangfolge, die es nicht gibt. Unterschieden
 * wird über das ausgeschriebene Label.
 *
 * WARUM „STORNIERT" NICHT ROT IST. Eine Stornierung ist eine geordnete
 * Korrektur mit eigenem Beleg, kein Alarmzustand — derselbe Archivfall wie
 * „Beendet"/„Archiviert".
 */
export const PAYMENT_STATE: Record<PaymentState, PaymentStateStyle> = {
  draft: {
    label: t('common.invoiceStatus.label'),
    Icon: FileEdit,
    surface: 'bg-vorschlag-bg',
    border: 'border-vorschlag-rahmen',
    text: 'text-vorschlag-text',
  },
  open: {
    label: t('common.invoiceStatus.label2'),
    Icon: Clock3,
    surface: 'bg-beschluss-bg',
    border: 'border-beschluss-rahmen',
    text: 'text-beschluss-text',
  },
  partially_paid: {
    label: t('common.invoiceStatus.label3'),
    Icon: AlertCircle,
    surface: 'bg-bedenken-bg',
    border: 'border-bedenken-rahmen',
    text: 'text-bedenken-text',
  },
  overdue: {
    label: t('common.invoiceStatus.label4'),
    Icon: AlertCircle,
    surface: 'bg-bedenken-bg',
    border: 'border-bedenken-rahmen',
    text: 'text-bedenken-text',
  },
  paid: {
    label: t('common.invoiceStatus.label5'),
    Icon: CheckCircle2,
    surface: 'bg-beschluss-bg',
    border: 'border-beschluss-rahmen',
    text: 'text-beschluss-text',
  },
  cancelled: {
    label: t('common.invoiceStatus.label6'),
    Icon: Ban,
    surface: 'bg-flaeche-3',
    border: 'border-rahmen',
    text: 'text-leise',
  },
};

/**
 * Der Stil zu einem Zahlungsstand — mit Rückfallebene, wie bei der Instanz.
 *
 * Ein unbekannter Wert aus dem Backend soll ein neutrales Abzeichen ergeben,
 * nicht den Absturz einer ganzen Seite. Dieselbe Lehre wie beim Aufgaben-Icon
 * des Dashboards; sie kostet drei Zeilen und spart einen Ausfall an dem Tag,
 * an dem jemand einen Enumwert ergänzt.
 */
export function paymentStateStyle(paymentState: string): PaymentStateStyle {
  return (
    PAYMENT_STATE[paymentState as PaymentState] ?? {
      label: paymentState,
      Icon: HelpCircle,
      surface: 'bg-flaeche-3',
      border: 'border-rahmen',
      text: 'text-leise',
    }
  );
}
