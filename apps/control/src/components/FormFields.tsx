import type { ReactNode } from 'react';
import { Select } from '@saas-instant/ui';

/**
 * Zwei Feldarten, die `@saas-instant/ui` nicht in dieser Form mitbringt.
 *
 * `Eingabefeld` und `DatumFeld` bringen ihr `<label>` und ihren Abstand selbst
 * mit, `Auswahl` dagegen ist bewusst nur das nackte Dropdown, und ein
 * mehrzeiliges Feld gibt es dort gar nicht. Statt die gemeinsamen Komponenten
 * über ihre Props hinaus zu biegen (Prämisse 0: `packages/ui` bleibt
 * unverändert), stehen die beiden fehlenden Bauformen hier — mit exakt den
 * Rahmen-, Fokus- und Abstandsklassen von `Eingabefeld`, damit in einem
 * Formular nichts aus der Reihe fällt.
 */

export function SelectField({
  label,
  id,
  value,
  onChange,
  children,
  helperText,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  helperText?: string;
}) {
  return (
    <div className="mb-4 text-left">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-text">
        {label}
      </label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </Select>
      {helperText && <p className="mt-1 text-sm text-leise">{helperText}</p>}
    </div>
  );
}

export function TextArea({
  label,
  id,
  value,
  onChange,
  rows = 3,
  placeholder,
  helperText,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  helperText?: string;
}) {
  return (
    <div className="mb-4 text-left">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-text">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-rahmen-ui bg-flaeche px-3 py-2 text-sm text-text placeholder:text-still focus:border-primaer disabled:opacity-70"
      />
      {helperText && <p className="mt-1 text-sm text-leise">{helperText}</p>}
    </div>
  );
}
