import { ENTRY, type EntryType } from '../entry-colors';

/**
 * Abzeichen für einen Eintragstyp: Farbe + Label + Icon zusammen.
 * Kernregel der Barrierefreiheit — die Bedeutung ist nie nur über Farbe erkennbar.
 */
export function EntryBadge({
  typeValue,
  className,
}: {
  typeValue: EntryType;
  className?: string;
}) {
  const style = ENTRY[typeValue];
  const Icon = style.Icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${style.surface} ${style.layout} ${style.text} ${className ?? ''}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {style.label}
    </span>
  );
}
