import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, InputField, Skeleton, useToast } from '@saas-instant/ui';
import {
  fetchPrices,
  savePrices,
  type PriceList,
  type PriceListTier,
  type SecondFactorEvidence,
} from '../lib/api';
import { errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import { centAsFieldValue, centFromInput, formatAmountCent } from '../utils/amount';
import { useT, type TFunction } from '../i18n';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';

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
  /** Noch nicht gespeichert: nur dann ist der Schlüssel editierbar. */
  isNew: boolean;
}

export interface PricesForm {
  taxRate: string;
  paymentTerm: string;
  averageDays: string;
  tiers: TierForm[];
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

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

function sameAs(a: PricesForm, b: PricesForm): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Einstellungen → Preise.
 *
 * Die Liste wird als Ganzes geladen und als Ganzes gespeichert. Speichern
 * verlangt den zweiten Faktor wie das Festschreiben: Preise gehen in jede
 * künftige Rechnung ein. Stufen werden nie gelöscht, sondern archiviert —
 * Organisationen und Rechnungsposten verweisen auf ihren Schlüssel.
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

  useEffect(() => {
    let active = true;
    fetchPrices()
      .then((list) => {
        if (!active) return;
        setSaved(list);
        setForm(formFrom(list));
      })
      .catch(() => active && setLoadError(t('einstellungen.pricesLoadError')));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const baseline = useMemo(() => (saved ? formFrom(saved) : null), [saved]);
  const check = useMemo(() => (form ? validate(form, t) : null), [form, t]);
  const dirty = form !== null && baseline !== null && !sameAs(form, baseline);

  const change = useCallback((fn: (f: PricesForm) => PricesForm) => {
    setForm((f) => (f ? fn(f) : f));
    setError(null);
  }, []);

  function changeTier(index: number, part: Partial<TierForm>) {
    change((f) => ({
      ...f,
      tiers: f.tiers.map((s, i) => (i === index ? { ...s, ...part } : s)),
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
      let number = f.tiers.length + 1;
      while (f.tiers.some((s) => s.key === `stufe${number}`)) number += 1;
      const added: TierForm = {
        key: `stufe${number}`,
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

  async function save(evidence?: SecondFactorEvidence) {
    if (!check?.list) return;
    setSaving(true);
    setError(null);
    try {
      const result = await savePrices(check.list, evidence);
      evidenceState.close();
      setSaved(result);
      setForm(formFrom(result));
      toast.show(t('einstellungen.pricesSaved'));
    } catch (f) {
      if (evidenceState.handle(f, evidence)) return;
      setError(errorText(f, t('einstellungen.pricesSaveFailed')));
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

  function tierCard(index: number) {
    const s = form!.tiers[index]!;
    const id = `preis-${index}`;
    const position = activeIndexes.indexOf(index) + 1;
    return (
      <Card key={`${s.key}-${index}`} className="p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-text">
            {t('einstellungen.pricesTierTitle', { n: s.archived ? index + 1 : position })}
            {s.maxPersons.trim() === '' && !s.archived && (
              <span className="ml-2 text-sm font-normal text-leise">
                ({t('einstellungen.pricesOpenTier')})
              </span>
            )}
          </h3>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => changeTier(index, { archived: !s.archived })}
          >
            {s.archived ? t('einstellungen.pricesRestore') : t('einstellungen.pricesArchive')}
          </Button>
        </div>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <InputField
            label={t('einstellungen.pricesLabel')}
            id={`${id}-label`}
            value={s.label}
            onChange={(e) => changeTier(index, { label: e.target.value })}
            maxLength={120}
          />
          <InputField
            label={t('einstellungen.pricesKey')}
            id={`${id}-key`}
            value={s.key}
            readOnly={!s.isNew}
            disabled={!s.isNew}
            helperText={s.isNew ? undefined : t('einstellungen.pricesKeyHint')}
            onChange={(e) => changeTier(index, { key: e.target.value.trim() })}
            maxLength={60}
          />
          <InputField
            label={t('einstellungen.pricesMaxPersons')}
            id={`${id}-max`}
            inputMode="numeric"
            value={s.maxPersons}
            helperText={t('einstellungen.pricesMaxPersonsHint')}
            onChange={(e) => changeTier(index, { maxPersons: e.target.value })}
          />
        </div>
        <div className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-4">
          <InputField
            label={t('einstellungen.pricesMonthly')}
            id={`${id}-monthly`}
            inputMode="decimal"
            value={s.monthly}
            onChange={(e) => changeTier(index, { monthly: e.target.value })}
          />
          <InputField
            label={t('einstellungen.pricesHalfYearly')}
            id={`${id}-half`}
            inputMode="decimal"
            value={s.halfYearly}
            onChange={(e) => changeTier(index, { halfYearly: e.target.value })}
          />
          <InputField
            label={t('einstellungen.pricesYearly')}
            id={`${id}-yearly`}
            inputMode="decimal"
            value={s.yearly}
            onChange={(e) => changeTier(index, { yearly: e.target.value })}
          />
          <InputField
            label={t('einstellungen.pricesSetup')}
            id={`${id}-setup`}
            inputMode="decimal"
            value={s.setup}
            onChange={(e) => changeTier(index, { setup: e.target.value })}
          />
        </div>
        <p className="ziffern-tabellarisch text-sm text-leise">
          {t('einstellungen.pricesGrossPreview', {
            monthly: grossText(s.monthly),
            halfYearly: grossText(s.halfYearly),
            yearly: grossText(s.yearly),
            setup: grossText(s.setup),
          })}
        </p>
      </Card>
    );
  }

  const coverageText = previewList ? coverage(previewList.tiers, t) : '';

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

      <h3 className="mb-2 text-base font-semibold text-text">
        {t('einstellungen.pricesTiersHeading')}
      </h3>
      <div className="space-y-4">{activeIndexes.map((i) => tierCard(i))}</div>
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
        <div className="mt-6">
          <h3 className="mb-1 text-base font-semibold text-text">
            {t('einstellungen.pricesArchivedHeading')}
          </h3>
          <p className="mb-2 text-sm text-leise">{t('einstellungen.pricesArchivedHint')}</p>
          <div className="space-y-4">{archivedIndexes.map((i) => tierCard(i))}</div>
        </div>
      )}

      {check.problems.length > 0 && (
        <div role="alert" className="mt-6 rounded-lg border border-rahmen bg-flaeche-2 p-4 text-sm">
          <p className="font-medium text-gefahr">{t('einstellungen.pricesProblemsHeading')}</p>
          <ul className="mt-1 list-disc pl-5 text-text">
            {check.problems.map((m) => (
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
      {error && (
        <p role="alert" className="mt-4 text-sm text-gefahr">
          {error}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button
          disabled={!dirty || check.list === null || saving}
          onClick={() => void save()}
        >
          {t('einstellungen.pricesSave')}
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => baseline && setForm(baseline)}
          >
            {t('einstellungen.pricesDiscard')}
          </Button>
        )}
        <span className="text-sm text-leise">
          {!dirty
            ? saved?.updatedAt
              ? t('einstellungen.pricesUpdatedAt', {
                  date: new Date(saved.updatedAt).toLocaleDateString('de-DE', {
                    timeZone: 'Europe/Berlin',
                  }),
                })
              : t('einstellungen.pricesNoChanges')
            : ''}
        </span>
      </div>

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
