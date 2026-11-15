import {
  FileText,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  type LucideIcon,
} from 'lucide-react';
import { uiT } from './i18n';

/**
 * Zentrale Quelle der Eintrags-Codierung (docs/03). Jeder Typ trägt Farbe UND
 * Label UND Icon — Farbe ist nie das alleinige Signal (Barrierefreiheit).
 * Die Klassen verweisen auf die Design-Tokens (tokens.css). Einwände tragen EINE
 * Farbe; der Schweregrad wird separat als Chip/Label gezeigt.
 */
export type EntryType =
  | 'suggestion'
  | 'concern'
  | 'objection'
  | 'decision';

export interface EntryStyle {
  label: string;
  Icon: LucideIcon;
  /** Hintergrund-/Rahmen-/Textklassen (Token-basiert). */
  surface: string;
  layout: string;
  text: string;
}

export const ENTRY: Record<EntryType, EntryStyle> = {
  suggestion: {
    label: uiT('entryColors.suggestion'),
    Icon: FileText,
    surface: 'bg-vorschlag-bg',
    layout: 'border-vorschlag-rahmen',
    text: 'text-vorschlag-text',
  },
  concern: {
    label: uiT('entryColors.concern'),
    Icon: AlertCircle,
    surface: 'bg-bedenken-bg',
    layout: 'border-bedenken-rahmen',
    text: 'text-bedenken-text',
  },
  objection: {
    label: uiT('entryColors.objection'),
    Icon: AlertTriangle,
    surface: 'bg-einwand-bg',
    layout: 'border-einwand-rahmen',
    text: 'text-einwand-text',
  },
  decision: {
    label: uiT('entryColors.decision'),
    Icon: CheckCircle2,
    surface: 'bg-beschluss-bg',
    layout: 'border-beschluss-rahmen',
    text: 'text-beschluss-text',
  },
};
