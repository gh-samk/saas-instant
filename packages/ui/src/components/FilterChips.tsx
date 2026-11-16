/**
 * Die Filterleiste über einer Liste — `Alle 94 · Offen 12 · Erledigt 6 …`.
 *
 * SIE FILTERT, SIE NAVIGIERT NICHT. Das unterscheidet sie von `Reiter`:
 * Reiter wechseln den Inhalt eines Bereichs, Chips schränken dieselbe Liste
 * ein. Deshalb bekommen sie `role="group"` und gewöhnliche Knöpfe mit
 * `aria-pressed` — nicht `role="tablist"`. Eine Bildschirmleserin soll hier
 * „Schalter gedrückt" hören und nicht „Registerkarte ausgewählt".
 *
 * DIE ZÄHLER SIND TEIL DER AUSSAGE. Ein Chip ohne Zahl zwingt zum
 * Ausprobieren; mit Zahl sieht man vorher, ob sich der Klick lohnt. Sie
 * stehen gedämpft daneben, damit sie die Beschriftung nicht überstimmen.
 *
 * Ein Chip mit Zähler 0 wird NICHT ausgeblendet: „Überfällig 0" ist eine
 * gute Nachricht, und eine Leiste, deren Einträge wandern, lässt sich nicht
 * blind bedienen.
 */

export interface FilterChip<T extends string> {
  value: T;
  label: string;
  /** Menge hinter der Beschriftung. `undefined` heisst „nicht gezählt". */
  count?: number;
}

export function FilterChips<T extends string>({
  chips,
  active,
  onSelect,
  label,
  className,
}: {
  chips: readonly FilterChip<T>[];
  active: T;
  onSelect: (value: T) => void;
  /** Wonach gefiltert wird — für die Bildschirmleserin. */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex flex-wrap gap-1 rounded-[10px] border border-rahmen bg-flaeche-3 p-[3px] ${className ?? ''}`}
    >
      {chips.map((chip) => {
        const selected = chip.value === active;
        return (
          <button
            key={chip.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(chip.value)}
            className={`min-h-11 rounded-lg px-3 py-1.5 text-sm sm:min-h-0 font-semibold transition-colors ${
              selected
                ? 'bg-flaeche text-text shadow-segment'
                : 'text-leise hover:text-text'
            }`}
          >
            {chip.label}
            {chip.count !== undefined && (
              <span className="ml-1.5 opacity-65 ziffern-tabellarisch">{chip.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
