import { forwardRef, type InputHTMLAttributes } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  helperText?: string;
}

/** Beschriftetes Eingabefeld mit optionaler Fehlermeldung. rhf-kompatibel (ref). */
export const InputField = forwardRef<HTMLInputElement, Props>(
  function InputField({ label, error, helperText, id, ...rest }, ref) {
    const fieldId = id ?? rest.name;
    const errorId = error ? `${fieldId}-fehler` : undefined;
    return (
      <div className="mb-4 text-left">
        <label
          htmlFor={fieldId}
          className="mb-1 block text-sm font-medium text-text"
        >
          {label}
        </label>
        <input
          id={fieldId}
          ref={ref}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          className="w-full rounded-lg border border-rahmen bg-flaeche px-3 py-2 text-text placeholder:text-leise focus:border-primaer focus:outline-none"
          {...rest}
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
