import { useCallback, useEffect, useMemo, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Button, Card, InputField, Skeleton, useToast } from '@saas-instant/ui';
import {
  fetchPrices,
  savePrices,
  type PriceList,
  type PriceListTier,
  type SecondFactorEvidence,
} from '../lib/api';
import { ApiError, errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import { centAsFieldValue, centFromInput, formatAmountCent } from '../utils/amount';
import { useT, type TFunction } from '../i18n';
import { issueLine, validationIssues } from '../lib/validation-errors';
import { useDirtyState, useUnsavedChanges } from '../lib/unsaved-changes';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { StickySaveBar } from './StickySaveBar';

/** Eine Stufe im Formular: Beträge als Euro-Text, Schwelle als Text. */
export interface TierForm {
  key: string;
  label: string;
  maxPersons: string;
  monthly: string;
  halfYearly: string;
  yearly: string;
  setup: string;
  archived: boolean;
  /** Noch nicht gespeichert: nur dann entsteht oder ändert sich der Schlüssel. */
  isNew: boolean;
  /** Der Schlüssel einer neuen Stufe wurde von Hand gesetzt und folgt dem Namen nicht mehr. */
  keyEdited?: boolean;
}

export interface PricesForm {
  taxRate: string;
  paymentTerm: string;
  averageDays: string;
  tiers: TierForm[];
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

const KEY_MAX = 60;

/**
 * Schlüssel für eine NEUE Stufe aus ihrem Namen: Kleinbuchstaben, Umlaute
 * ausgeschrieben, alles andere zu Bindestrichen („Groß (Plus)" → `gross-plus`).
 * `taken` sind die Schlüssel ALLER anderen Stufen, auch der archivierten; bei
 * einem Treffer kommt `-2`, `-3` … dazu. Ein leerer Name ergibt `stufe`.
 * Bestehende Schlüssel fasst das nie an: Organisationen und Rechnungsposten
 * hängen daran.
 */
export function keyFromLabel(label: string, taken: ReadonlySet<string>): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, KEY_MAX - 6)
    .replace(/-+$/g, '');
  const base = slug === '' ? 'stufe' : slug;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Halbjahrespreis aus dem Monatspreis: 5,5 Monatspreise, kaufmännisch gerundet. */
export function halfYearlyFromMonthly(monthlyCent: number): number {
  return Math.round((monthlyCent * 11) / 2);
}

/** Jahrespreis aus dem Monatspreis: 11 Monatspreise. */
export function yearlyFromMonthly(monthlyCent: number): number {
  return monthlyCent * 11;
}

export function formFrom(list: PriceList): PricesForm {
  return {
    taxRate: String(list.taxRatePercent),
    paymentTerm: String(list.paymentTermDays),
    averageDays: String(list.averageDays),
    tiers: list.tiers.map((s) => ({
      key: s.key,
      label: s.label,
      maxPersons: s.maxPersons === null ? '' : String(s.maxPersons),
      monthly: centAsFieldValue(s.monthlyCent),
      halfYearly: centAsFieldValue(s.halfYearlyCent),
      yearly: centAsFieldValue(s.yearlyCent),
      setup: centAsFieldValue(s.setupCent),
      archived: s.archived,
      isNew: false,
    })),
  };
}

function wholeNumber(text: string, min: number, max: number): number | null {
  const raw = text.trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

function taxRateFrom(text: string): number | null {
  const raw = text.trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 0 && n <= 100 ? n : null;
}

export interface Validation {
  /** Blockiert das Speichern. */
  problems: string[];
  /** Fällt auf, blockiert aber nicht. */
  warnings: string[];
  /** Die Liste, wie sie an den Server ginge; `null`, solange es Probleme gibt. */
  list: Omit<PriceList, 'updatedAt'> | null;
}

/**
 * Prüft das Formular mit denselben Regeln wie der Server (`issues()`): Die
 * Schwellen der AKTIVEN Stufen steigen streng, genau eine Stufe ist nach oben
 * offen, und sie ist die letzte. Der Server prüft beim Speichern erneut — das
 * hier ist die Warnung VOR dem Passwort.
 */
export function validate(form: PricesForm, t: TFunction): Validation {
  const problems: string[] = [];
  const warnings: string[] = [];

  const taxRate = taxRateFrom(form.taxRate);
  if (taxRate === null) problems.push(t('einstellungen.pricesErrTaxRate'));
  const paymentTerm = wholeNumber(form.paymentTerm, 0, 365);
  if (paymentTerm === null) problems.push(t('einstellungen.pricesErrPaymentTerm'));
  const averageDays = wholeNumber(form.averageDays, 1, 365);
  if (averageDays === null) problems.push(t('einstellungen.pricesErrAverageDays'));

  const seen = new Set<string>();
  const tiers: PriceListTier[] = [];
  const active: { tier: PriceListTier; number: number }[] = [];
  let activeCount = 0;
  form.tiers.forEach((s, index) => {
    // Nummer wie in der Kartenüberschrift: aktive Stufen zählen nur unter sich.
    if (!s.archived) activeCount += 1;
    const n = s.archived ? index + 1 : activeCount;
    if (s.label.trim() === '') problems.push(t('einstellungen.pricesErrLabel', { n }));
    if (!KEY_PATTERN.test(s.key)) problems.push(t('einstellungen.pricesErrKey', { n }));
    else if (seen.has(s.key)) {
      problems.push(t('einstellungen.pricesErrKeyDuplicate', { n, key: s.key }));
    }
    seen.add(s.key);

    const amounts = [s.monthly, s.halfYearly, s.yearly, s.setup].map((v) => {
      const cent = centFromInput(v);
      return cent !== null && cent >= 0 ? cent : null;
    });
    if (amounts.some((c) => c === null)) problems.push(t('einstellungen.pricesErrAmount', { n }));

    let maxPersons: number | null = null;
    if (s.maxPersons.trim() !== '') {
      maxPersons = wholeNumber(s.maxPersons, 1, 1_000_000);
      if (maxPersons === null) problems.push(t('einstellungen.pricesErrMaxPersons', { n }));
    }

    const [monthly, halfYearly, yearly, setup] = amounts as (number | null)[];
    const tier: PriceListTier = {
      key: s.key,
      label: s.label.trim(),
      maxPersons,
      monthlyCent: monthly ?? 0,
      halfYearlyCent: halfYearly ?? 0,
      yearlyCent: yearly ?? 0,
      setupCent: setup ?? 0,
      archived: s.archived,
    };
    tiers.push(tier);
    if (!s.archived) {
      active.push({ tier, number: n });
      if (monthly !== null && yearly !== null && yearly >= monthly * 12 && monthly > 0) {
        warnings.push(t('einstellungen.pricesWarnYearly', { n }));
      }
      if (monthly !== null && halfYearly !== null && halfYearly >= monthly * 6 && monthly > 0) {
        warnings.push(t('einstellungen.pricesWarnHalfYearly', { n }));
      }
    }
  });

  if (active.length === 0) {
    problems.push(t('einstellungen.pricesErrNoTier'));
  } else {
    const open = active.filter((a) => a.tier.maxPersons === null);
    if (open.length !== 1) {
      problems.push(t('einstellungen.pricesErrOpenCount', { count: open.length }));
    } else if (active[active.length - 1]?.tier.maxPersons !== null) {
      problems.push(t('einstellungen.pricesErrOpenLast'));
    }
    let previous: number | null = null;
    for (const a of active) {
      if (a.tier.maxPersons === null) continue;
      if (previous !== null && a.tier.maxPersons <= previous) {
        problems.push(t('einstellungen.pricesErrAscending', { n: a.number }));
      }
      previous = a.tier.maxPersons;
    }
  }

  if (problems.length > 0 || taxRate === null || paymentTerm === null || averageDays === null) {
    return { problems, warnings, list: null };
  }
  return {
    problems,
    warnings,
    list: {
      taxRatePercent: taxRate,
      paymentTermDays: paymentTerm,
      averageDays,
      currency: 'EUR',
      tiers,
    },
  };
}

/** Die Personenbereiche der aktiven Stufen, z. B. „bis 10 · 11 bis 30 · ab 31". */
export function coverage(tiers: PriceListTier[], t: TFunction): string {
  const parts: string[] = [];
  let previous = 0;
  for (const s of tiers.filter((x) => !x.archived)) {
    if (s.maxPersons === null) {
      parts.push(t('einstellungen.pricesCoverageFrom', { n: previous + 1 }));
    } else if (previous === 0) {
      parts.push(t('einstellungen.pricesCoverageUpTo', { n: s.maxPersons }));
      previous = s.maxPersons;
    } else {
      parts.push(
        t('einstellungen.pricesCoverageRange', { from: previous + 1, to: s.maxPersons }),
      );
      previous = s.maxPersons;
    }
  }
  return parts.join(' · ');
}

/** Netto in Cent → Brutto in Cent (kaufmännisch gerundet). */
export function grossCent(netCent: number, taxRatePercent: number): number {
  return netCent + Math.round((netCent * Math.round(taxRatePercent * 100)) / 10_000);
}


/** Schlüssel eines Feldes der Stufe → Name im Serverpfad (`tiers.0.monthlyCent`). */
const SERVER_FIELDS: Record<string, keyof TierForm> = {
  label: 'label',
  key: 'key',
  maxPersons: 'maxPersons',
  monthlyCent: 'monthly',
  halfYearlyCent: 'halfYearly',
  yearlyCent: 'yearly',
  setupCent: 'setup',
};

/** Ein Eingabefeld in einer Zeile: Beschriftung nur mobil sichtbar, am Tisch die Kopfzeile. */
function Cell({
  id,
  label,
  error,
  className = '',
  below,
  ...rest
}: {
  id: string;
  label: string;
  error?: string;
  className?: string;
  below?: ReactNode;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>) {
  const errorId = error ? `${id}-fehler` : undefined;
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-text @3xl:sr-only">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className="w-full rounded-lg border border-rahmen-ui bg-flaeche px-3 py-2 text-text placeholder:text-still focus:border-primaer"
        {...rest}
      />
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-sm text-gefahr">
          {error}
        </p>
      )}
      {below}
    </div>
  );
}

/** Mobil 44 px Trefferfläche (inline-flex zentriert den Text darin), ab `sm` kompakt. */
const LINK_BUTTON =
  'mt-1 inline-flex min-h-11 items-center text-sm text-primaer underline-offset-2 hover:underline focus-visible:underline sm:min-h-6';

/**
 * Einstellungen → Preise.
 *
 * Die Liste wird als Ganzes geladen und als Ganzes gespeichert. Speichern
 * verlangt den zweiten Faktor wie das Festschreiben: Preise gehen in jede
 * künftige Rechnung ein. Stufen werden nie gelöscht, sondern archiviert —
 * Organisationen und Rechnungsposten verweisen auf ihren Schlüssel. Deshalb
 * ändert sich der Schlüssel einer gespeicherten Stufe nie; nur neue Stufen
 * bekommen einen aus ihrem Namen erzeugten.
 */
export function PricesCard({ totpPossible = false }: { totpPossible?: boolean }) {
  const t = useT();
  const toast = useToast();
  const evidenceState = useSecondFactorEvidence();
  const [saved, setSaved] = useState<PriceList | null>(null);
  const [form, setForm] = useState<PricesForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Prüfmeldungen des Servers: `„<Zeile>.<Feld>"` → Text; der Rest als Liste. */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverSummary, setServerSummary] = useState<string[]>([]);

  const { dirty, baseline, isDirty, markSaved } = useDirtyState(form);
  useUnsavedChanges(isDirty);

  useEffect(() => {
    let active = true;
    fetchPrices()
      .then((list) => {
        if (!active) return;
        const loaded = formFrom(list);
        setSaved(list);
        setForm(loaded);
        markSaved(() => loaded);
      })
      .catch(() => active && setLoadError(t('einstellungen.pricesLoadError')));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = useMemo(() => (form ? validate(form, t) : null), [form, t]);

  const change = useCallback((fn: (f: PricesForm) => PricesForm) => {
    setForm((f) => (f ? fn(f) : f));
    setError(null);
    setFieldErrors({});
    setServerSummary([]);
  }, []);

  function changeTier(index: number, part: Partial<TierForm>) {
    change((f) => ({
      ...f,
      tiers: f.tiers.map((s, i) => {
        if (i !== index) return s;
        const next = { ...s, ...part };
        // Der Schlüssel einer NEUEN Stufe folgt dem Namen, bis jemand ihn selbst setzt.
        if (next.isNew && !next.keyEdited && part.label !== undefined) {
          const taken = new Set(f.tiers.filter((_, j) => j !== index).map((x) => x.key));
          next.key = keyFromLabel(next.label, taken);
        }
        return next;
      }),
    }));
  }

  function addTier() {
    change((f) => {
      const activeTiers = f.tiers.filter((s) => !s.archived);
      const open = activeTiers.find((s) => s.maxPersons.trim() === '');
      const closed = activeTiers
        .map((s) => Number(s.maxPersons))
        .filter((n) => Number.isFinite(n) && n > 0);
      const nextThreshold = String((closed.length > 0 ? Math.max(...closed) : 0) + 10);
      const added: TierForm = {
        key: keyFromLabel('', new Set(f.tiers.map((s) => s.key))),
        label: '',
        maxPersons: nextThreshold,
        monthly: open?.monthly ?? '0.00',
        halfYearly: open?.halfYearly ?? '0.00',
        yearly: open?.yearly ?? '0.00',
        setup: open?.setup ?? '0.00',
        archived: false,
        isNew: true,
      };
      // Vor die offene Stufe, damit die Reihenfolge der Schwellen stimmt.
      const at = open ? f.tiers.indexOf(open) : f.tiers.length;
      return { ...f, tiers: [...f.tiers.slice(0, at), added, ...f.tiers.slice(at)] };
    });
  }

  /** Neue Stufen verschwinden ganz, gespeicherte werden archiviert (nie gelöscht). */
  function removeTier(index: number) {
    const tier = form?.tiers[index];
    if (!tier) return;
    if (tier.isNew) change((f) => ({ ...f, tiers: f.tiers.filter((_, i) => i !== index) }));
    else changeTier(index, { archived: true });
  }

  /** Zurückholen: an die Stelle, die ihre Schwelle unter den aktiven Stufen hat. */
  function restoreTier(index: number) {
    change((f) => {
      const tier = f.tiers[index];
      if (!tier) return f;
      const rest = f.tiers.filter((_, i) => i !== index);
      const restored = { ...tier, archived: false };
      const limit = tier.maxPersons.trim() === '' ? Infinity : Number(tier.maxPersons);
      let at = rest.length;
      for (let i = 0; i < rest.length; i += 1) {
        const other = rest[i]!;
        if (other.archived) continue;
        const otherLimit = other.maxPersons.trim() === '' ? Infinity : Number(other.maxPersons);
        if (otherLimit > limit || (otherLimit === Infinity && limit === Infinity)) {
          at = i;
          break;
        }
      }
      return { ...f, tiers: [...rest.slice(0, at), restored, ...rest.slice(at)] };
    });
  }

  function calculate(index: number, part: 'halfYearly' | 'yearly') {
    const tier = form?.tiers[index];
    const cent = tier ? centFromInput(tier.monthly) : null;
    if (!tier || cent === null || cent < 0) return;
    changeTier(index, {
      [part]: centAsFieldValue(
        part === 'halfYearly' ? halfYearlyFromMonthly(cent) : yearlyFromMonthly(cent),
      ),
    });
  }

  /** Meldungen des Servers an Feld und Zeile; `false`, wenn es keine Eingabeprüfung war. */
  function showServerIssues(f: unknown): boolean {
    const names = (i: number) => form?.tiers[i]?.label.trim() || t('einstellungen.pricesUnnamed');
    const issues = validationIssues(f);
    if (issues.length > 0) {
      const errors: Record<string, string> = {};
      const rest: string[] = [];
      for (const issue of issues) {
        const part = issue.field ? SERVER_FIELDS[issue.field] : undefined;
        if (issue.index !== null && part !== undefined) {
          errors[`${issue.index}.${part}`] ??= issue.message;
          rest.push(`${names(issue.index)}: ${issue.message}`);
        } else rest.push(issueLine(issue));
      }
      setFieldErrors(errors);
      setServerSummary(rest);
      return true;
    }
    if (f instanceof ApiError && f.error.code === 'prices_invalid') {
      const detail = f.error.detail as { issues?: unknown } | null | undefined;
      const list = Array.isArray(detail?.issues)
        ? detail.issues.filter((m): m is string => typeof m === 'string')
        : [];
      if (list.length > 0) {
        setFieldErrors({});
        setServerSummary(list);
        return true;
      }
    }
    return false;
  }

  async function save(evidence?: SecondFactorEvidence) {
    if (!check?.list) {
      setError(t('einstellungen.pricesFixFirst'));
      return;
    }
    setSaving(true);
    setError(null);
    setFieldErrors({});
    setServerSummary([]);
    try {
      const result = await savePrices(check.list, evidence);
      evidenceState.close();
      const next = formFrom(result);
      setSaved(result);
      setForm(next);
      markSaved(() => next);
      toast.show(t('einstellungen.pricesSaved'));
    } catch (f) {
      if (evidenceState.handle(f, evidence)) return;
      evidenceState.close();
      if (!showServerIssues(f)) setError(errorText(f, t('einstellungen.pricesSaveFailed')));
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <p role="alert" className="text-sm text-gefahr">
        {loadError}
      </p>
    );
  }
  if (form === null || check === null) return <Skeleton className="h-48 w-full" />;

  const taxRate = taxRateFrom(form.taxRate) ?? 0;
  const activeIndexes = form.tiers.map((s, i) => (s.archived ? -1 : i)).filter((i) => i >= 0);
  const archivedIndexes = form.tiers.map((s, i) => (s.archived ? i : -1)).filter((i) => i >= 0);
  const previewList = check.list ?? null;

  function grossText(value: string): string {
    const cent = centFromInput(value);
    return cent === null || cent < 0 ? '—' : formatAmountCent(grossCent(cent, taxRate));
  }

  function netText(value: string): string {
    const cent = centFromInput(value);
    return cent === null || cent < 0 ? '—' : formatAmountCent(cent);
  }

  /** „bis 10 Personen" aus der Schwelle — nur, wenn der Name die Zahl nicht schon trägt. */
  function rangeHint(index: number): string | null {
    const s = form!.tiers[index]!;
    if (/\d/.test(s.label)) return null;
    const max = s.maxPersons.trim();
    if (max === '') {
      let previous = 0;
      for (const i of activeIndexes) {
        if (i >= index) break;
        const n = Number(form!.tiers[i]!.maxPersons);
        if (Number.isFinite(n)) previous = n;
      }
      return previous > 0 ? t('einstellungen.pricesFromPersons', { n: previous + 1 }) : null;
    }
    return wholeNumber(max, 1, 1_000_000) === null
      ? null
      : t('einstellungen.pricesUpToPersons', { n: Number(max) });
  }

  function tierRow(index: number) {
    const s = form!.tiers[index]!;
    const id = `preis-${index}`;
    const err = (part: keyof TierForm) => fieldErrors[`${index}.${part}`];
    const hint = rangeHint(index);
    return (
      <li
        key={`${s.key}-${index}`}
        className="grid grid-cols-2 gap-x-3 gap-y-3 rounded-lg border border-rahmen bg-flaeche p-4 @3xl:grid-cols-[minmax(7rem,1.5fr)_minmax(5rem,0.8fr)_repeat(4,minmax(5.5rem,1fr))_auto] @3xl:items-start @3xl:rounded-none @3xl:border-0 @3xl:border-b @3xl:bg-transparent @3xl:px-0 @3xl:py-3"
      >
        <Cell
          id={`${id}-label`}
          label={t('einstellungen.pricesLabel')}
          className="col-span-2 @3xl:col-span-1"
          value={s.label}
          maxLength={120}
          placeholder={t('einstellungen.pricesNamePlaceholder')}
          error={err('label')}
          onChange={(e) => changeTier(index, { label: e.target.value })}
          below={hint ? <p className="mt-1 text-sm text-leise">{hint}</p> : undefined}
        />
        <Cell
          id={`${id}-max`}
          label={t('einstellungen.pricesMaxPersons')}
          className="col-span-2 @3xl:col-span-1"
          inputMode="numeric"
          value={s.maxPersons}
          placeholder={t('einstellungen.pricesOpenPlaceholder')}
          error={err('maxPersons')}
          onChange={(e) => changeTier(index, { maxPersons: e.target.value })}
        />
        <Cell
          id={`${id}-monthly`}
          label={t('einstellungen.pricesMonthly')}
          inputMode="decimal"
          value={s.monthly}
          error={err('monthly')}
          onChange={(e) => changeTier(index, { monthly: e.target.value })}
        />
        <Cell
          id={`${id}-half`}
          label={t('einstellungen.pricesHalfYearly')}
          inputMode="decimal"
          value={s.halfYearly}
          error={err('halfYearly')}
          onChange={(e) => changeTier(index, { halfYearly: e.target.value })}
          below={
            <button
              type="button"
              className={LINK_BUTTON}
              aria-label={t('einstellungen.pricesCalcHalfLabel')}
              onClick={() => calculate(index, 'halfYearly')}
            >
              {t('einstellungen.pricesCalcShortHalf')}
            </button>
          }
        />
        <Cell
          id={`${id}-yearly`}
          label={t('einstellungen.pricesYearly')}
          inputMode="decimal"
          value={s.yearly}
          error={err('yearly')}
          onChange={(e) => changeTier(index, { yearly: e.target.value })}
          below={
            <button
              type="button"
              className={LINK_BUTTON}
              aria-label={t('einstellungen.pricesCalcYearLabel')}
              onClick={() => calculate(index, 'yearly')}
            >
              {t('einstellungen.pricesCalcShortYear')}
            </button>
          }
        />
        <Cell
          id={`${id}-setup`}
          label={t('einstellungen.pricesSetup')}
          inputMode="decimal"
          value={s.setup}
          error={err('setup')}
          onChange={(e) => changeTier(index, { setup: e.target.value })}
        />
        <p className="ziffern-tabellarisch col-span-2 text-sm text-leise @3xl:col-span-full @3xl:row-start-2">
          {t('einstellungen.pricesGrossPreview', {
            monthly: grossText(s.monthly),
            halfYearly: grossText(s.halfYearly),
            yearly: grossText(s.yearly),
            setup: grossText(s.setup),
          })}
        </p>
        <div className="col-span-2 flex justify-end @3xl:col-span-1 @3xl:col-start-7 @3xl:row-start-1 @3xl:pt-6">
          <Button
            variant="secondary"
            size="sm"
            className="min-h-11 sm:min-h-8"
            onClick={() => removeTier(index)}
          >
            {s.isNew ? t('einstellungen.pricesRemoveNew') : t('einstellungen.pricesArchive')}
            <span className="sr-only"> {s.label.trim() || t('einstellungen.pricesUnnamed')}</span>
          </Button>
        </div>
      </li>
    );
  }

  const coverageText = previewList ? coverage(previewList.tiers, t) : '';
  const problemLines = [...check.problems, ...serverSummary];
  const columns = [
    t('einstellungen.pricesLabel'),
    t('einstellungen.pricesMaxPersons'),
    t('einstellungen.pricesMonthly'),
    t('einstellungen.pricesHalfYearly'),
    t('einstellungen.pricesYearly'),
    t('einstellungen.pricesSetup'),
  ];

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold text-text">{t('einstellungen.pricesHeading')}</h2>
      <p className="mb-4 text-sm text-leise">{t('einstellungen.pricesIntro')}</p>

      <Card className="mb-4 p-5">
        <h3 className="mb-3 text-base font-semibold text-text">
          {t('einstellungen.pricesGeneralHeading')}
        </h3>
        <div className="grid gap-x-4 sm:grid-cols-3">
          <InputField
            label={t('einstellungen.pricesTaxRate')}
            id="preis-steuersatz"
            inputMode="decimal"
            value={form.taxRate}
            onChange={(e) => change((f) => ({ ...f, taxRate: e.target.value }))}
          />
          <InputField
            label={t('einstellungen.pricesPaymentTerm')}
            id="preis-zahlungsziel"
            inputMode="numeric"
            value={form.paymentTerm}
            onChange={(e) => change((f) => ({ ...f, paymentTerm: e.target.value }))}
          />
          <InputField
            label={t('einstellungen.pricesAverageDays')}
            id="preis-durchschnitt"
            inputMode="numeric"
            value={form.averageDays}
            helperText={t('einstellungen.pricesAverageHint')}
            onChange={(e) => change((f) => ({ ...f, averageDays: e.target.value }))}
          />
        </div>
      </Card>

      <h3 className="mb-1 text-base font-semibold text-text">
        {t('einstellungen.pricesTiersHeading')}
      </h3>
      <p className="mb-2 text-sm text-leise">
        {t('einstellungen.pricesMaxPersonsHint')} {t('einstellungen.pricesCalcHint')}
      </p>
      <div className="@container">
        <div
          aria-hidden="true"
          className="hidden grid-cols-[minmax(7rem,1.5fr)_minmax(5rem,0.8fr)_repeat(4,minmax(5.5rem,1fr))_auto] gap-x-3 border-b border-rahmen pb-2 text-sm font-medium text-leise @3xl:grid"
        >
          {columns.map((c) => (
            <span key={c}>{c}</span>
          ))}
          <span className="invisible">{t('einstellungen.pricesArchive')}</span>
        </div>
        <ul className="space-y-3 @3xl:space-y-0">{activeIndexes.map((i) => tierRow(i))}</ul>
      </div>
      <div className="mt-3">
        <Button variant="secondaryGreen" onClick={addTier}>
          {t('einstellungen.pricesAddTier')}
        </Button>
      </div>
      {coverageText !== '' && (
        <p className="mt-3 text-sm text-leise">
          {t('einstellungen.pricesCoverage', { text: coverageText })}
        </p>
      )}

      {archivedIndexes.length > 0 && (
        <details className="mt-6 rounded-lg border border-rahmen bg-flaeche-2 p-4">
          <summary className="cursor-pointer text-base font-semibold text-text">
            {t('einstellungen.pricesArchivedSummary', { count: archivedIndexes.length })}
          </summary>
          <p className="mb-3 mt-2 text-sm text-leise">{t('einstellungen.pricesArchivedHint')}</p>
          <ul className="divide-y divide-rahmen">
            {archivedIndexes.map((i) => {
              const s = form.tiers[i]!;
              const name = s.label.trim() || t('einstellungen.pricesUnnamed');
              return (
                <li
                  key={`${s.key}-${i}`}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-text">{name}</p>
                    <p className="ziffern-tabellarisch text-sm text-leise">
                      {t('einstellungen.pricesArchivedRow', {
                        monthly: netText(s.monthly),
                        halfYearly: netText(s.halfYearly),
                        yearly: netText(s.yearly),
                        setup: netText(s.setup),
                      })}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => restoreTier(i)}>
                    {t('einstellungen.pricesRestore')}
                    <span className="sr-only"> {name}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      <details className="mt-4 rounded-lg border border-rahmen bg-flaeche-2 p-4">
        <summary className="cursor-pointer text-base font-semibold text-text">
          {t('einstellungen.pricesTechTitle')}
        </summary>
        <p className="mb-3 mt-2 text-sm text-leise">{t('einstellungen.pricesTechHint')}</p>
        <ul className="space-y-2">
          {form.tiers.map((s, i) => {
            const name = s.label.trim() || t('einstellungen.pricesUnnamed');
            return (
              <li key={`${s.key}-${i}`} className="text-sm">
                {s.isNew ? (
                  <Cell
                    id={`preis-${i}-key`}
                    label={t('einstellungen.pricesTechKeyLabel', { name })}
                    value={s.key}
                    maxLength={KEY_MAX}
                    error={fieldErrors[`${i}.key`]}
                    onChange={(e) =>
                      changeTier(i, { key: e.target.value.trim(), keyEdited: true })
                    }
                  />
                ) : (
                  <p className="text-text">
                    {name}: <code className="rounded bg-flaeche px-1">{s.key}</code>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </details>

      {problemLines.length > 0 && (
        <div role="alert" className="mt-6 rounded-lg border border-rahmen bg-flaeche-2 p-4 text-sm">
          <p className="font-medium text-gefahr">{t('einstellungen.pricesProblemsHeading')}</p>
          <ul className="mt-1 list-disc pl-5 text-text">
            {problemLines.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {check.warnings.length > 0 && (
        <div className="mt-4 rounded-lg border border-rahmen bg-flaeche-2 p-4 text-sm">
          <p className="font-medium text-text">{t('einstellungen.pricesWarningsHeading')}</p>
          <ul className="mt-1 list-disc pl-5 text-leise">
            {check.warnings.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {saved?.updatedAt && (
        <p className="mt-4 text-sm text-leise">
          {t('einstellungen.pricesUpdatedAt', {
            date: new Date(saved.updatedAt).toLocaleDateString('de-DE', {
              timeZone: 'Europe/Berlin',
            }),
          })}
        </p>
      )}

      <StickySaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        label={t('einstellungen.pricesSave')}
        saveLabel={t('einstellungen.pricesSave')}
        onSave={() => save()}
        onDiscard={() => {
          if (baseline) setForm(baseline);
          setError(null);
          setFieldErrors({});
          setServerSummary([]);
        }}
      />

      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={t('einstellungen.pricesSaveTitle')}
        declaration={t('einstellungen.pricesSaveDeclaration')}
        totpPossible={totpPossible}
        loading={saving}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => void save(evidence)}
      />
    </div>
  );
}
