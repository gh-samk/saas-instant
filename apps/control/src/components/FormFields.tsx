import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Select, Tooltip } from '@saas-instant/ui';
import { t } from '../i18n';

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

/**
 * Einheitliche Kennzeichnung in Formularen: Pflichtfelder tragen ein Sternchen,
 * ausdrücklich freiwillige Felder den Zusatz „(optional)". Der Stern wird
 * zusammen mit `required` am Feld gesetzt (Vorlesestimme) und über
 * `RequiredLegend` einmal im Formular erklärt.
 */
export function fieldLabel(label: string, mode: 'required' | 'optional'): string {
  return mode === 'required'
    ? t('common.field.required', { label })
    : t('common.field.optional', { label });
}

/** Der erklärende Satz zum Sternchen — einmal je Formular, oberhalb der Felder. */
export function RequiredLegend() {
  return <p className="mb-3 text-sm text-leise">{t('common.field.legend')}</p>;
}

/**
 * Kleines Info-Icon mit kurzem Hilfetext. Der Auslöser ist ein echter Knopf
 * (per Tastatur erreichbar, Name aus `label`) und über `aria-describedby` mit
 * dem Text verknüpft (beides übernimmt `Tooltip`); der Text steht also für
 * Vorleseprogramme immer bereit. Der Tooltip bricht um und bleibt im Fenster.
 */
export function HelpHint({ text, label }: { text: string; label?: string }) {
  return (
    <Tooltip text={text} label={label ?? t('common.field.help')}>
      <Info className="h-4 w-4 text-leise" aria-hidden="true" />
    </Tooltip>
  );
}

export function SelectField({
  label,
  id,
  value,
  onChange,
  children,
  helperText,
  error,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  helperText?: string;
  error?: string;
}) {
  return (
    <div className="mb-4 text-left">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-text">
        {label}
      </label>
      <Select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-fehler` : undefined}
      >
        {children}
      </Select>
      {helperText && !error && <p className="mt-1 text-sm text-leise">{helperText}</p>}
      {error && (
        <p id={`${id}-fehler`} className="mt-1 text-sm text-gefahr" role="alert">
          {error}
        </p>
      )}
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
  error,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  helperText?: string;
  error?: string;
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
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-fehler` : undefined}
        className="w-full rounded-lg border border-rahmen-ui bg-flaeche px-3 py-2 text-sm text-text placeholder:text-still focus:border-primaer disabled:opacity-70"
      />
      {helperText && !error && <p className="mt-1 text-sm text-leise">{helperText}</p>}
      {error && (
        <p id={`${id}-fehler`} className="mt-1 text-sm text-gefahr" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
