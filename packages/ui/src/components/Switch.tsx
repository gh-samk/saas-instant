/**
 * Barrierefreier Kippschalter (Toggle) im Design der Vorgabe: grün, wenn an,
 * mit gleitendem Knopf. `role="switch"` + `aria-checked` für Screenreader.
 * Der Klick meldet den GEWÜNSCHTEN neuen Zustand über `onToggle`; die
 * eigentliche Zustandsführung (inkl. Bestätigungs-Dialog beim Ausschalten)
 * bleibt beim Aufrufer.
 */
export function Switch({
  on,
  onToggle,
  disabled,
  label,
}: {
  on: boolean;
  onToggle: (newValue: boolean) => void;
  disabled?: boolean;
  /** Zugängliche Beschriftung (aria-label), falls kein sichtbares <label>. */
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onToggle(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
        on ? 'bg-primaer' : 'bg-flaeche-3 ring-1 ring-inset ring-rahmen-ui'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-5 w-5 transform rounded-full bg-flaeche shadow-segment transition-transform ${
          on ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
