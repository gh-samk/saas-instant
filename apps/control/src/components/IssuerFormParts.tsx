import type { ReactNode } from 'react';
import type { IssuerProfile, LegalForm } from '@saas-instant/shared';
import { Button, Switch } from '@saas-instant/ui';
import { useT, type TFunction } from '../i18n';
import { fieldId, getPathValue, type FieldSpec } from '../lib/issuer-fields';

const INPUT_CLASS =
  'w-full rounded-lg border border-rahmen-ui bg-flaeche px-3 py-2 text-text placeholder:text-still focus:border-primaer';

export function RequiredMark() {
  return (
    <span aria-hidden="true" className="ml-0.5 text-gefahr">
      *
    </span>
  );
}

/** Beschriftung eines Feldes, abhängig von Pfad und Rechtsform. */
export function fieldLabel(t: TFunction, path: string, form: LegalForm): string {
  if (path === 'registered') return t(`firma.label_registered_${form}`);
  if (path === 'managingPersons') return t(`firma.label_managingPersons_${form}`);
  if (path.startsWith('generalPartner.')) {
    return t(`firma.label_gp_${path.slice('generalPartner.'.length)}`);
  }
  return t(`firma.label_${path}`);
}

/** Hilfetext eines Feldes, oder undefined. */
export function fieldHint(t: TFunction, path: string, form: LegalForm): string | undefined {
  switch (path) {
    case 'name':
      return t(`firma.hint_name_${form}`);
    case 'ownerName':
      return t('firma.hint_ownerName');
    case 'partners':
    case 'managingPersons':
    case 'generalPartner.managingDirectors':
      return t('firma.hint_person');
    case 'registerNumber':
      return t(`firma.hint_registerNumber_${form}`);
    case 'generalPartner.registerNumber':
      return t('firma.hint_gp_registerNumber');
    case 'iban':
      return t('firma.hint_iban');
    case 'vatId':
      return t('firma.hint_vatId');
    default:
      return undefined;
  }
}

function describedBy(...ids: Array<string | undefined>): string | undefined {
  const used = ids.filter((id): id is string => Boolean(id));
  return used.length > 0 ? used.join(' ') : undefined;
}

interface TextFieldProps {
  spec: FieldSpec;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  inputMode?: 'text' | 'email' | 'tel' | 'url' | 'numeric';
  maxLength?: number;
}

export function TextField({
  spec,
  label,
  hint,
  error,
  value,
  onChange,
  inputMode,
  maxLength = 200,
}: TextFieldProps) {
  const id = fieldId(spec.path);
  const hintId = hint ? `${id}-hinweis` : undefined;
  const errorId = error ? `${id}-fehler` : undefined;
  return (
    <div className="mb-4 text-left">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-text">
        {label}
        {spec.required && <RequiredMark />}
      </label>
      <input
        id={id}
        name={spec.path}
        data-field={spec.path}
        data-required={spec.required ? 'true' : 'false'}
        aria-required={spec.required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hintId, errorId)}
        inputMode={inputMode}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT_CLASS}
      />
      {hint && (
        <p id={hintId} className="mt-1 text-sm text-leise">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-sm text-gefahr">
          {error}
        </p>
      )}
    </div>
  );
}

interface ListFieldProps {
  spec: FieldSpec;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  values: string[];
  onChange: (values: string[]) => void;
}

/** Liste von Namen mit „Hinzufügen" und „Entfernen" (mindestens eine Zeile bleibt sichtbar). */
export function ListField({ spec, label, hint, error, values, onChange }: ListFieldProps) {
  const t = useT();
  const id = fieldId(spec.path);
  const hintId = hint ? `${id}-hinweis` : undefined;
  const errorId = error ? `${id}-fehler` : undefined;
  const rows = values.length > 0 ? values : [''];

  function update(index: number, value: string) {
    onChange(rows.map((row, i) => (i === index ? value : row)));
  }
  function remove(index: number) {
    const next = rows.filter((_, i) => i !== index);
    onChange(next.length === 1 && next[0] === '' ? [] : next);
  }

  return (
    <fieldset
      className="mb-4 text-left"
      data-field={spec.path}
      data-required={spec.required ? 'true' : 'false'}
      aria-describedby={describedBy(hintId, errorId)}
    >
      <legend className="mb-1 block text-sm font-medium text-text">
        {label}
        {spec.required && <RequiredMark />}
      </legend>
      <ul className="space-y-2">
        {rows.map((row, index) => (
          <li key={index} className="flex items-start gap-2">
            <input
              id={index === 0 ? id : `${id}-${index + 1}`}
              aria-label={t('firma.listEntry', { label, n: index + 1 })}
              aria-required={spec.required || undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy(hintId, errorId)}
              maxLength={200}
              value={row}
              onChange={(e) => update(index, e.target.value)}
              className={INPUT_CLASS}
            />
            <Button
              variant="secondary"
              size="sm"
              className="mt-0.5 shrink-0"
              disabled={rows.length === 1}
              aria-label={t('firma.listRemoveEntry', { label, n: index + 1 })}
              onClick={() => remove(index)}
            >
              {t('firma.listRemove')}
            </Button>
          </li>
        ))}
      </ul>
      <Button
        variant="secondaryGreen"
        size="sm"
        className="mt-2"
        aria-label={t('firma.listAddEntry', { label })}
        onClick={() => onChange([...rows, ''])}
      >
        {t('firma.listAdd')}
      </Button>
      {hint && (
        <p id={hintId} className="mt-1 text-sm text-leise">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-sm text-gefahr">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export function SwitchField({
  spec,
  label,
  on,
  onChange,
}: {
  spec: FieldSpec;
  label: string;
  on: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = fieldId(spec.path);
  return (
    <div
      className="mb-4 flex items-center gap-3 text-left"
      data-field={spec.path}
      data-required="false"
    >
      <Switch label={label} on={on} onToggle={onChange} />
      <span id={id} className="text-sm font-medium text-text">
        {label}
      </span>
    </div>
  );
}

/** Rendert ein Feld nach seiner Art. */
export function IssuerField({
  spec,
  form,
  profile,
  error,
  onChange,
}: {
  spec: FieldSpec;
  form: LegalForm;
  profile: IssuerProfile;
  error?: string | undefined;
  onChange: (path: string, value: string | string[] | boolean) => void;
}) {
  const t = useT();
  const label = fieldLabel(t, spec.path, form);
  const hint = fieldHint(t, spec.path, form);
  const value = getPathValue(profile, spec.path);
  if (spec.kind === 'switch') {
    return (
      <SwitchField
        spec={spec}
        label={label}
        on={value === true}
        onChange={(v) => onChange(spec.path, v)}
      />
    );
  }
  if (spec.kind === 'list') {
    return (
      <ListField
        spec={spec}
        label={label}
        hint={hint}
        error={error}
        values={Array.isArray(value) ? value : []}
        onChange={(v) => onChange(spec.path, v)}
      />
    );
  }
  const inputMode =
    spec.path === 'email'
      ? 'email'
      : spec.path === 'phone'
        ? 'tel'
        : spec.path === 'web'
          ? 'url'
          : undefined;
  return (
    <TextField
      spec={spec}
      label={label}
      hint={hint}
      error={error}
      value={typeof value === 'string' ? value : ''}
      inputMode={inputMode}
      onChange={(v) => onChange(spec.path, v)}
    />
  );
}

export function FormSection({
  title,
  hint,
  children,
  id,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  id: string;
}) {
  const headingId = `firma-abschnitt-${id}`;
  return (
    <section aria-labelledby={headingId} className="mb-4 rounded-lg border border-rahmen bg-flaeche p-5">
      <h3 id={headingId} className="text-base font-semibold text-text">
        {title}
      </h3>
      {hint && <p className="mb-3 mt-1 text-sm text-leise">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}
