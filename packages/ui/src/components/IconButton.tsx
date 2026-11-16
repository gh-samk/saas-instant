import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * Ein quadratischer Knopf, der nur ein Symbol zeigt.
 *
 * DIE BESCHRIFTUNG IST PFLICHT, nicht optional. `beschriftung` wird zugleich
 * `aria-label` und `title` — ein Knopf, den man nur am Symbol erkennt, ist
 * für eine Bildschirmleserin gar kein Knopf und für alle anderen ein Rätsel.
 * Deshalb steht sie im Typ und nicht in den optionalen Eigenschaften: Wer sie
 * vergisst, kommt am Übersetzer nicht vorbei.
 *
 * DREI VARIANTEN, mehr braucht es nicht:
 * - `normal` — die Regel
 * - `aktiv` — der Knopf gehört zum gerade gewählten Zustand
 * - `gefahr` — zerstörend; färbt sich erst beim Zeigen rot, damit die
 *   Zeile nicht dauerhaft nach Alarm aussieht
 */

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'aria-label'> {
  Icon: LucideIcon;
  /** Was der Knopf tut. Wird `aria-label` UND `title`. */
  label: string;
  variant?: 'normal' | 'active' | 'danger';
  size?: 'small' | 'normal';
}

const STYLES: Record<NonNullable<Props['variant']>, string> = {
  normal:
    'border-rahmen bg-flaeche text-leise hover:bg-primaer-softer hover:text-primaer-softtext',
  active: 'border-primaer bg-primaer-soft text-primaer-softtext',
  danger: 'border-rahmen bg-flaeche text-leise hover:bg-einwand-bg hover:text-einwand-text',
};

export function IconButton({
  Icon,
  label,
  variant = 'normal',
  size = 'normal',
  className,
  ...rest
}: Props) {
  // Unter `sm` (Telefon) 44 px Trefferfläche, ab `sm` das bisherige Mass.
  const edge =
    size === 'small'
      ? 'h-11 w-11 sm:h-[30px] sm:w-[30px]'
      : 'h-11 w-11 sm:h-9 sm:w-9';
  const symbol = size === 'small' ? 'h-[15px] w-[15px]' : 'h-[18px] w-[18px]';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`grid shrink-0 place-items-center rounded-[7px] border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${edge} ${STYLES[variant]} ${className ?? ''}`}
      {...rest}
    >
      <Icon className={symbol} aria-hidden="true" />
    </button>
  );
}
