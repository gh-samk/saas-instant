import type { ReactNode } from 'react';
import { AlertTriangle, Info, ShieldCheck, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Ein Hinweis in EINER Zeile: Icon, Satz, optional ein Knopf.
 *
 * WOZU SIE DA IST. Sie ersetzt Erklärabsätze durch Struktur — ein
 * vierzeiliger Kasten über einer Liste wird ein Satz, drei erklärende
 * Absätze werden eine Zeile. Diese Komponente ist der Ort, an dem das
 * passiert. Sie ist bewusst schmal gebaut: Wer mehr als einen
 * Satz unterbringen will, benutzt das falsche Werkzeug.
 *
 * DIE FARBE IST BEDEUTUNG, KEINE DEKORATION — dieselben vier Familien wie
 * überall in der Oberfläche:
 *
 * - `hinweis` (blau) — eine Auskunft, nichts zu tun
 * - `achtung` (bernstein) — braucht einen Blick, blockiert nichts
 * - `problem` (rot) — Sperre, Fehler, unumkehrbare Folge
 * - `bestaetigt` (grün) — eine Zusicherung, die das System einhält
 *
 * Das Icon ist NICHT frei wählbar. Es gehört zur Bedeutung, und ein
 * abweichendes Symbol an einer Stelle machte die Farbfamilie unlesbar.
 */

export type NoticeKind = 'notice' | 'attention' | 'problem' | 'confirmed';

const STYLES: Record<NoticeKind, { layout: string; surface: string; text: string; Icon: LucideIcon }> =
  {
    notice: {
      surface: 'bg-vorschlag-bg',
      layout: 'border-vorschlag-rahmen-hell',
      text: 'text-vorschlag-text',
      Icon: Info,
    },
    attention: {
      surface: 'bg-bedenken-bg',
      layout: 'border-bedenken-rahmen-hell',
      text: 'text-bedenken-text',
      Icon: AlertTriangle,
    },
    problem: {
      surface: 'bg-einwand-bg',
      layout: 'border-einwand-rahmen-hell',
      text: 'text-einwand-text',
      Icon: XCircle,
    },
    confirmed: {
      surface: 'bg-primaer-softer',
      layout: 'border-primaer-softrahmen',
      text: 'text-primaer-softtext',
      Icon: ShieldCheck,
    },
  };

export function NoticeBar({
  kind,
  children,
  action,
  className,
}: {
  kind: NoticeKind;
  /** Der Satz. Eine Zeile — mehr gehört in einen Dialog. */
  children: ReactNode;
  /** Optionaler Knopf am rechten Rand. */
  action?: ReactNode;
  className?: string;
}) {
  const style = STYLES[kind];
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm ${style.surface} ${style.layout} ${style.text} ${className ?? ''}`}
    >
      <style.Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
      {/* Unter 640 px steht der Satz oben (Breite abzüglich Icon), der Knopf
          darunter in voller Breite; erst darüber sitzt er rechts in der Zeile. */}
      <span
        className={`min-w-0 flex-1 ${action ? 'basis-[calc(100%-1.875rem)] sm:basis-0' : ''}`}
      >
        {children}
      </span>
      {action && <div className="w-full sm:w-auto">{action}</div>}
    </div>
  );
}
