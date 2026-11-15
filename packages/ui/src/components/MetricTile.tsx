import type { LucideIcon } from 'lucide-react';

/**
 * Eine Kennzahl als Kachel — Zahl gross, Bedeutung klein, ein Klick führt
 * zur gefilterten Liste dahinter.
 *
 * WOFÜR SIE GEDACHT IST — und wofür nicht. Sie gehört auf Ansichten, auf
 * denen Zahlen der eigentliche Inhalt sind: Summen, überfällige Posten,
 * Jahreswerte. Auf eine Startseite gehört sie NICHT; dort gilt
 * „Aufgabenliste, keine Kacheln". Eine Kennzahl, die niemanden zu einer
 * Handlung führt, ist Dekoration.
 *
 * DESHALB IST SIE IMMER KLICKBAR. Wenn eine Zahl es wert ist, gross zu
 * stehen, ist sie es auch wert, dass man dahinterschauen kann. Ohne `onKlick`
 * lässt sie sich nicht bauen.
 *
 * DIE FARBE GEHÖRT DER BEDEUTUNG. `problem` gibt der ganzen Karte einen roten
 * Rahmen — das ist der einzige Fall, in dem eine Kachel aus der Reihe fällt,
 * und genau dann soll sie es.
 */

export type TileKind = 'neutral' | 'notice' | 'attention' | 'problem' | 'confirmed';

const STYLES: Record<TileKind, { circle: string; symbol: string; layout: string; number: string }> = {
  neutral: {
    circle: 'bg-flaeche-3',
    symbol: 'text-leise',
    layout: 'border-rahmen',
    number: 'text-text',
  },
  notice: {
    circle: 'bg-vorschlag-bg',
    symbol: 'text-vorschlag-text',
    layout: 'border-rahmen',
    number: 'text-text',
  },
  attention: {
    circle: 'bg-bedenken-bg',
    symbol: 'text-bedenken-text',
    layout: 'border-rahmen',
    number: 'text-text',
  },
  problem: {
    circle: 'bg-einwand-bg',
    symbol: 'text-einwand-text',
    layout: 'border-einwand-rahmen-hell',
    number: 'text-einwand-text',
  },
  confirmed: {
    circle: 'bg-beschluss-bg',
    symbol: 'text-beschluss-text',
    layout: 'border-rahmen',
    number: 'text-text',
  },
};

export function MetricTile({
  Icon,
  number,
  label,
  kind = 'neutral',
  onClick,
  selected = false,
}: {
  Icon: LucideIcon;
  /** Schon fertig formatiert — `1.860,00 €`, `4`. Diese Karte rechnet nicht. */
  number: string;
  label: string;
  kind?: TileKind;
  onClick: () => void;
  selected?: boolean;
}) {
  const style = STYLES[kind];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex w-full items-center gap-3 rounded-2xl border bg-flaeche px-4 py-3.5 text-left transition-all hover:-translate-y-px hover:shadow-karte-hover ${style.layout} ${selected ? 'ring-2 ring-primaer' : ''}`}
    >
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${style.circle}`}>
        <Icon className={`h-[18px] w-[18px] ${style.symbol}`} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span
          className={`block text-2xl font-bold leading-tight ziffern-tabellarisch ${style.number}`}
        >
          {number}
        </span>
        <span className="block text-[13.5px] text-leise">{label}</span>
      </span>
    </button>
  );
}
