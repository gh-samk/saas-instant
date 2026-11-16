import { forwardRef } from 'react';

interface Props {
  label: string;
  /** Reines Kalenderdatum YYYY-MM-DD (kein Zeitanteil). */
  value?: string;
  onChange?: (value: string) => void;
  name?: string;
  id?: string;
  min?: string;
  max?: string;
  required?: boolean;
  error?: string;
  helperText?: string;
  /** Fokus beim Einblenden hierher (z. B. erste Eingabe eines Dialogs). */
  autoFocus?: boolean;
}

/**
 * Kalendertag-Auswahl. Nutzt das native input[type=date], dessen Wert immer ein
 * reiner YYYY-MM-DD-String ohne Uhrzeit ist. Gibt/nimmt ausschließlich diesen
 * String — es wird bewusst KEIN Date-Objekt/DateTime durchgereicht.
 */
export const DateField = forwardRef<HTMLInputElement, Props>(
  function DateField(
    { label, value, onChange, name, id, min, max, required, error, helperText, autoFocus },
    ref,
  ) {
    const fieldId = id ?? name ?? 'date';
    const errorId = error ? `${fieldId}-fehler` : undefined;
    return (
      <div className="mb-4 text-left">
        <label htmlFor={fieldId} className="mb-1 block text-sm font-medium text-text">
          {label}
        </label>
        <input
          ref={ref}
          id={fieldId}
          name={name}
          type="date"
          value={value ?? ''}
          min={min}
          max={max}
          required={required}
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          onChange={(e) => onChange?.(e.target.value)}
          className="ziffern-tabellarisch w-full rounded-lg border border-rahmen-ui bg-flaeche px-3 py-2 text-text focus:border-primaer"
        />
        {helperText && !error && (
          <p className="mt-1 text-sm text-leise">{helperText}</p>
        )}
        {error && (
          <p id={errorId} className="mt-1 text-sm text-gefahr" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  },
);
