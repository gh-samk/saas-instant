import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  emptyIssuerProfile,
  validateIssuerProfile,
  type IssuerIssue,
  type IssuerProfile,
  type LegalForm,
} from '@saas-instant/shared';
import { Button, Card, Skeleton, useToast } from '@saas-instant/ui';
import { CheckCircle2, ListChecks } from 'lucide-react';
import { fetchIssuer, saveIssuer, type IssuerSettings } from '../lib/api';
import { errorText } from '../lib/api-client';
import { DEFAULT_ACCENT } from '../lib/accent';
import {
  LEGAL_FORM_ORDER,
  fieldId,
  planFields,
  setPathValue,
} from '../lib/issuer-fields';
import { useProduct } from '../context/ProductContext';
import { useT } from '../i18n';
import { FormSection, IssuerField } from './IssuerFormParts';
import { IssuerBranding, accentCheck } from './IssuerBranding';

/** Ergänzt fehlende Teile einer Serverantwort mit den Vorgaben, damit das Formular nie auf `undefined` trifft. */
export function normalizeProfile(profile: Partial<IssuerProfile> | null | undefined): IssuerProfile {
  const base = emptyIssuerProfile(profile?.legalForm ?? 'einzelunternehmen');
  return {
    ...base,
    ...(profile ?? {}),
    partners: profile?.partners ?? [],
    managingPersons: profile?.managingPersons ?? [],
    generalPartner: {
      ...base.generalPartner,
      ...(profile?.generalPartner ?? {}),
      managingDirectors: profile?.generalPartner?.managingDirectors ?? [],
    },
  };
}

/** Springt zum Feld (oder zu dessen erstem Eingabeelement) und setzt den Fokus. */
export function focusField(path: string): void {
  const target =
    document.getElementById(fieldId(path)) ??
    document.querySelector<HTMLElement>(`[data-field="${path}"] input, [data-field="${path}"] button`);
  if (!target) return;
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
  target.focus();
}

function sameAs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Einstellungen → Firmendaten.
 *
 * Die Angaben der Rechnungsstellerin hängen von der Rechtsform ab
 * (`REQUIREMENTS` in shared, begründet in
 * `docs/operations/invoice-legal-requirements.md`). Gespeichert wird auch ein
 * unvollständiger Stand; erst das Festschreiben einer Rechnung verlangt alles.
 * Die Vollständigkeitsanzeige oben rechnet mit derselben Funktion wie der
 * Server (`validateIssuerProfile`), deshalb stimmt sie schon beim Tippen.
 */
export function IssuerProfileCard() {
  const t = useT();
  const toast = useToast();
  const product = useProduct();
  const [saved, setSaved] = useState<IssuerSettings | null>(null);
  const [profile, setProfile] = useState<IssuerProfile | null>(null);
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [afterSave, setAfterSave] = useState<number | null>(null);

  function adopt(result: IssuerSettings) {
    const normalized = normalizeProfile(result.profile);
    setSaved({ ...result, profile: normalized });
    setProfile(normalized);
    setAccent(result.accentColor || DEFAULT_ACCENT);
  }

  useEffect(() => {
    let active = true;
    fetchIssuer()
      .then((result) => {
        if (active) adopt(result);
      })
      .catch(() => active && setLoadError(t('firma.loadError')));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const issues: IssuerIssue[] = useMemo(
    () => (profile ? validateIssuerProfile(profile) : []),
    [profile],
  );
  const check = accentCheck(accent);
  const dirty =
    saved !== null &&
    profile !== null &&
    (!sameAs(profile, saved.profile) ||
      accent.toLowerCase() !== (saved.accentColor || DEFAULT_ACCENT).toLowerCase());

  const change = useCallback((fn: (p: IssuerProfile) => IssuerProfile) => {
    setProfile((p) => (p ? fn(p) : p));
    setError(null);
    setAfterSave(null);
  }, []);

  async function save() {
    if (!profile || !check.valid) return;
    setSaving(true);
    setError(null);
    try {
      const result = await saveIssuer({ profile, accentColor: accent.toLowerCase() });
      adopt(result);
      setShowErrors(true);
      setAfterSave(result.missing.length);
      toast.show(t('firma.saved'));
      product.refresh();
    } catch (f) {
      setError(errorText(f, t('firma.saveFailed')));
    } finally {
      setSaving(false);
    }
  }

  const refreshLogo = useCallback(async () => {
    const result = await fetchIssuer();
    // Nur das Logo übernehmen: ungespeicherte Eingaben im Formular bleiben stehen.
    setSaved((s) => (s ? { ...s, logo: result.logo } : s));
    product.refresh();
  }, [product]);

  if (loadError) {
    return (
      <p role="alert" className="text-sm text-gefahr">
        {loadError}
      </p>
    );
  }
  if (profile === null || saved === null) return <Skeleton className="h-48 w-full" />;

  const form = profile.legalForm;
  const sections = planFields(profile);
  const issueFor = (path: string): IssuerIssue | undefined =>
    issues.find((i) => i.field === path);
  /** Fehlertext eines Feldes: „fehlt" erst nach dem ersten Speichern, Formatfehler sofort. */
  const errorFor = (path: string): string | undefined => {
    const issue = issueFor(path);
    if (!issue) return undefined;
    if (issue.code === 'missing') {
      if (path === 'vatId' || path === 'taxNumber') return undefined;
      return showErrors ? t('firma.fieldRequired') : undefined;
    }
    return t(`firma.issue_${issue.code}`);
  };
  const taxEitherError =
    showErrors && issues.some((i) => i.field === 'vatId' && i.code === 'missing')
      ? t('firma.taxEither')
      : null;

  function changeForm(next: LegalForm) {
    change((p) => ({ ...p, legalForm: next }));
  }

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold text-text">{t('firma.heading')}</h2>
      <p className="mb-4 text-sm text-leise">{t('firma.intro')}</p>

      <Completeness issues={issues} afterSave={afterSave} />

      <Card className="mb-4 p-5">
        <fieldset data-field="legalForm">
          <legend className="text-base font-semibold text-text">{t('firma.legalFormLegend')}</legend>
          <p id="firma-rechtsform-hinweis" className="mb-3 mt-1 text-sm text-leise">
            {t('firma.legalFormHint')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {LEGAL_FORM_ORDER.map((value) => {
              const checked = value === form;
              return (
                <label
                  key={value}
                  htmlFor={`firma-form-${value}`}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                    checked
                      ? 'border-primaer bg-primaer-softer'
                      : 'border-rahmen hover:bg-flaeche-3'
                  }`}
                >
                  <input
                    type="radio"
                    id={`firma-form-${value}`}
                    name="legalForm"
                    value={value}
                    checked={checked}
                    aria-labelledby={`firma-form-${value}-name`}
                    aria-describedby={`firma-form-${value}-info`}
                    onChange={() => changeForm(value)}
                    className="mt-1 h-4 w-4 shrink-0 accent-primaer"
                  />
                  <span>
                    <span
                      id={`firma-form-${value}-name`}
                      className="block text-sm font-semibold text-text"
                    >
                      {t(`firma.legalForm_${value}`)}
                    </span>
                    <span id={`firma-form-${value}-info`} className="block text-sm text-leise">
                      {t(`firma.legalFormInfo_${value}`)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </Card>

      <p className="mb-3 text-sm text-leise">{t('firma.legend')}</p>

      {sections.map((section) => {
        const title =
          section.id === 'legal'
            ? t(`firma.legalSection_${form}`)
            : t(`firma.section_${section.id}`);
        const hint =
          section.id === 'generalPartner'
            ? t('firma.section_generalPartnerHint')
            : section.id === 'contact'
              ? t('firma.section_contactHint')
              : section.id === 'tax'
                ? t('firma.section_taxHint')
                : undefined;
        const extraErrors = section.id === 'tax' ? taxEitherError : null;
        return (
          <FormSection key={section.id} id={section.id} title={title} {...(hint ? { hint } : {})}>
            <div className={section.id === 'address' ? 'grid gap-x-4 sm:grid-cols-2' : undefined}>
              {section.fields.map((spec) => (
                <IssuerField
                  key={spec.path}
                  spec={spec}
                  form={form}
                  profile={profile}
                  error={errorFor(spec.path)}
                  onChange={(path, value) => change((p) => setPathValue(p, path, value))}
                />
              ))}
            </div>
            {extraErrors && (
              <p role="alert" className="text-sm text-gefahr">
                {extraErrors}
              </p>
            )}
          </FormSection>
        );
      })}

      <div className="mb-4">
        <IssuerBranding
          logo={saved.logo}
          accent={accent}
          onAccentChange={(hex) => {
            setAccent(hex);
            setError(null);
          }}
          onLogoChanged={refreshLogo}
        />
      </div>

      <p className="mb-4 text-sm text-still">{t('firma.noAdvice')}</p>

      {error && (
        <p role="alert" className="mb-3 text-sm text-gefahr">
          {error}
        </p>
      )}
      {!check.valid && (
        <p className="mb-3 text-sm text-gefahr">{t('firma.accentBlocked')}</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!dirty || !check.valid || saving} loading={saving} onClick={() => void save()}>
          {t('firma.save')}
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              adopt(saved);
              setError(null);
            }}
          >
            {t('firma.discard')}
          </Button>
        )}
        <span role="status" data-testid="issuer-status" className="text-sm text-leise">
          {afterSave !== null && !dirty
            ? afterSave === 0
              ? t('firma.savedComplete')
              : t('firma.savedIncomplete', { count: afterSave })
            : !dirty
              ? t('firma.noChanges')
              : ''}
        </span>
      </div>
    </div>
  );
}

/** „N Pflichtangaben fehlen" mit Liste; ein Klick springt zum Feld. */
function Completeness({ issues, afterSave }: { issues: IssuerIssue[]; afterSave: number | null }) {
  const t = useT();
  if (issues.length === 0) {
    return (
      <div
        data-testid="issuer-complete"
        className="mb-4 flex items-start gap-3 rounded-lg border border-erfolg-rahmen bg-erfolg-bg p-4 text-sm text-erfolg-text"
      >
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <p>
          <span className="font-semibold">{t('firma.completeTitle')}</span> {t('firma.completeText')}
        </p>
      </div>
    );
  }
  return (
    <section
      aria-labelledby="firma-vollstaendigkeit"
      data-testid="issuer-incomplete"
      data-after-save={afterSave ?? undefined}
      className="mb-4 rounded-lg border border-warnung-rahmen bg-warnung-bg p-4 text-sm text-warnung-text"
    >
      <h3 id="firma-vollstaendigkeit" className="flex items-center gap-2 font-semibold">
        <ListChecks className="h-5 w-5 shrink-0" aria-hidden="true" />
        {t('firma.incompleteTitle', { count: issues.length })}
      </h3>
      <p className="mb-2 mt-1">{t('firma.incompleteHint')}</p>
      <ul className="list-disc pl-5">
        {issues.map((issue) => (
          <li key={`${issue.field}-${issue.code}`}>
            <button
              type="button"
              className="text-left underline underline-offset-2 hover:no-underline"
              onClick={() => focusField(issue.field)}
            >
              {issue.label}
            </button>
            {issue.code !== 'missing' && <span>{`: ${t(`firma.issue_${issue.code}`)}`}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
