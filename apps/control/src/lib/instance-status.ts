import {
  Archive,
  CheckCircle2,
  HelpCircle,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
import type { InstanceStatus } from './api';
import { t } from '../i18n';

export interface InstanceStatusStyle {
  label: string;
  Icon: LucideIcon;
  surface: string;
  border: string;
  text: string;
  /** Icon dreht sich — für Übergänge ohne eigene Bedeutungsfarbe. */
  spinning?: boolean;
}

/**
 * Statusfarben der Instanz — aus der BEDEUTUNG abgeleitet, nicht frei gewählt.
 *
 * Dasselbe Rezept wie `ORGANISATION_STATUS`: dieselben Token-Kombinationen,
 * kein neuer Wert, keine Änderung an `packages/ui` (R7).
 *
 * Nur „aktiv" bekommt eine der vier Eintragsfarben (Beschluss/Grün —
 * entschieden und tragend). „Wird erstellt" und „gestoppt" sind
 * Werkzeug-Vorgänge ohne Werturteil und werden neutral mit drehendem Icon
 * gezeigt, wie ein `Knopf laedt`. „Archiviert" ist wie „Beendet" bei
 * Organisationen ein Archivfall, kein Alarm — dieselbe neutrale
 * Graukombination.
 *
 * EINWAND (ROT) KOMMT HIER BEWUSST NICHT VOR. Der einzige Fall, der ihn
 * verdient — eine hängende Erstellung —, ist keine Ausprägung dieses Enums,
 * sondern eine abgeleitete Zusatzanzeige von `wird_erstellt`: Der Status hat
 * sich nicht geändert, nur die Zeit, die er schon andauert.
 *
 * `gestoppt` heißt „Wird archiviert": Das Backend setzt diesen Wert
 * ausschließlich als Zwischenschritt der Archivierung
 * (`instanz.service.ts`, `archiviere`) und kennt keinen dauerhaft
 * angehaltenen Zustand. Offener Punkt 12.1 der Spezifikation ist damit
 * beantwortet.
 */
export const INSTANCE_STATUS: Record<InstanceStatus, InstanceStatusStyle> = {
  provisioning: {
    label: t('common.instanceStatus.label'),
    Icon: Loader2,
    surface: 'bg-flaeche-3',
    border: 'border-rahmen',
    text: 'text-leise',
    spinning: true,
  },
  active: {
    label: t('common.instanceStatus.label2'),
    Icon: CheckCircle2,
    surface: 'bg-beschluss-bg',
    border: 'border-beschluss-rahmen',
    text: 'text-beschluss-text',
  },
  stopped: {
    label: t('common.instanceStatus.label3'),
    Icon: Loader2,
    surface: 'bg-flaeche-3',
    border: 'border-rahmen',
    text: 'text-leise',
    spinning: true,
  },
  archived: {
    label: t('common.instanceStatus.label4'),
    Icon: Archive,
    surface: 'bg-flaeche-3',
    border: 'border-rahmen',
    text: 'text-leise',
  },
};

/**
 * Ab wann eine laufende Erstellung als „hängt fest" gilt.
 *
 * Spiegelt `HAENGT_FEST_MINUTEN` aus `apps/control/src/instanz/instanz.regeln.ts`.
 * Der Wert steht dort als Betriebsentscheidung; das Backend wertet ihn selbst
 * nicht aus (es gibt keinen `fehlgeschlagen`-Status), die Anzeige leitet den
 * Zustand aus `erstelltAm` ab.
 */
export const HANGS_FIXED_MINUTES = 15;

/**
 * Der Stil zu einem Status — mit Rückfallebene.
 *
 * Käme aus dem Backend je ein Wert dazu, den diese Tabelle nicht kennt, risse
 * ein direkter Zugriff (`INSTANZ_STATUS[status].Icon`) die gesamte
 * Organisations-Detailseite mit — für eine Anzeige, die nur ein Abzeichen
 * zeichnet. Der unbekannte Wert wird deshalb neutral und im Wortlaut gezeigt.
 */
export function instanceStatusStyle(status: string): InstanceStatusStyle {
  return (
    INSTANCE_STATUS[status as InstanceStatus] ?? {
      label: status,
      Icon: HelpCircle,
      surface: 'bg-flaeche-3',
      border: 'border-rahmen',
      text: 'text-leise',
    }
  );
}
