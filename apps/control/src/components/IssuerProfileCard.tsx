import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  inlineIssue,
  layoutRows,
  planFields,
  requiredTotal,
  sectionOf,
  sectionProgress,
  setPathValue,
} from '../lib/issuer-fields';
import { useDirtyState, useUnsavedChanges } from '../lib/unsaved-changes';
import { useProduct } from '../context/ProductContext';
import { useT } from '../i18n';
import { FieldRow, FormSection, IssuerField } from './IssuerFormParts';
import { SelectField } from './FormFields';
import { StickySaveBar } from './StickySaveBar';
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

/**
 * Einstellungen → Firmendaten.
 *
 * Die Angaben der Rechnungsstellerin hängen von der Rechtsform ab
 * (`REQUIREMENTS` in shared, begründet in
 * `docs/operations/invoice-legal-requirements.md`). Gespeichert wird auch ein
 * unvollständiger Stand; erst das Festschreiben einer Rechnung verlangt alles.
 * Die Fortschrittsanzeige oben rechnet mit derselben Funktion wie der
 * Server (`validateIssuerProfile`), deshalb stimmt sie schon beim Tippen.
 *
 * Abschnitte ohne Pflichtangabe (Kontakt, Logo und Farbe) stehen eingeklappt;
 * die Steuer bleibt offen, weil „USt-IdNr. oder Steuernummer" Pflicht ist.
 * Der Änderungsstand umfasst Profil und Akzentfarbe. Das Logo wird dagegen
 * sofort beim Hochladen oder Entfernen gespeichert (eigene Schnittstelle) und
 * ist deshalb nicht Teil davon.
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
  /** Felder, die schon einmal verlassen wurden: ihre Formatfehler erscheinen sofort. */
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  /** Optionale Abschnitte, die aufgeklappt sind. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const { dirty, baseline, isDirty, markSaved } = useDirtyState<{
    profile: IssuerProfile | null;
    accent: string;
  }>({ profile, accent: accent.toLowerCase() });
  useUnsavedChanges(isDirty);

  function adopt(result: IssuerSettings) {
    const normalized = normalizeProfile(result.profile);
    const nextAccent = result.accentColor || DEFAULT_ACCENT;
    setSaved({ ...result, profile: normalized });
    setProfile(normalized);
    setAccent(nextAccent);
    markSaved(() => ({ profile: normalized, accent: nextAccent.toLowerCase() }));
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
      clearTimeout(jumpTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const issues: IssuerIssue[] = useMemo(
    () => (profile ? validateIssuerProfile(profile) : []),
    [profile],
  );
  const check = accentCheck(accent);

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

  function discard() {
    if (!baseline.profile) return;
    setProfile(baseline.profile);
    setAccent(baseline.accent);
    setError(null);
    setAfterSave(null);
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
  /**
   * Fehlertext eines Feldes: „fehlt" erst nach dem ersten Speichern,
   * Formatfehler nach dem Verlassen des Feldes (oder nach dem Speichern).
   */
  const errorFor = (path: string): string | undefined => {
    const issue = issueFor(path);
    if (issue?.code === 'missing') {
      if (path === 'vatId' || path === 'taxNumber') return undefined;
      return showErrors ? t('firma.fieldRequired') : undefined;
    }
    if (!touched.has(path) && !showErrors) return undefined;
    if (issue) return t(`firma.issue_${issue.code}`);
    const inline = inlineIssue(profile, path);
    if (!inline) return undefined;
    return inline.code === 'registerPrefix'
      ? t('firma.issue_registerPrefix', { prefix: inline.prefixes.join(' / ') })
      : t(`firma.issue_${inline.code}`);
  };
  const taxEitherError =
    showErrors && issues.some((i) => i.field === 'vatId' && i.code === 'missing')
      ? t('firma.taxEither')
      : null;

  const brandingFilled = (saved.logo?.hasLogo ? 1 : 0) + (accent.toLowerCase() !== DEFAULT_ACCENT ? 1 : 0);
  const sectionHasError = (id: string): boolean =>
    id === 'branding'
      ? !check.valid
      : (sections.find((s) => s.id === id)?.fields.some((f) => errorFor(f.path)) ?? false);
  // Ein Abschnitt mit sichtbarem Fehler klappt auf und bleibt offen.
  for (const section of sections) {
    if (section.optional && !opened.has(section.id) && sectionHasError(section.id)) {
      setOpened(new Set(opened).add(section.id));
    }
  }
  if (!opened.has('branding') && sectionHasError('branding')) {
    setOpened(new Set(opened).add('branding'));
  }
  const toggle = (id: string, open: boolean) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Springt zum Feld und klappt vorher den Abschnitt auf, falls er eingeklappt ist. */
  function jumpTo(path: string) {
    const section = sectionOf(sections, path);
    if (section?.optional && !opened.has(section.id)) {
      toggle(section.id, true);
      clearTimeout(jumpTimer.current);
      jumpTimer.current = setTimeout(() => focusField(path), 0);
      return;
    }
    focusField(path);
  }
  // Erstes offenes Feld in der Reihenfolge der Seite (nicht der Prüfung).
  const firstOpen =
    sections.flatMap((s) => s.fields).find((f) => issues.some((i) => i.field === f.path))?.path ??
    issues[0]?.field;

  function changeForm(next: LegalForm) {
    change((p) => ({ ...p, legalForm: next }));
  }
  function markTouched(path: string) {
    setTouched((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
  }

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold text-text">{t('firma.heading')}</h2>
      <p className="mb-4 text-sm text-leise">{t('firma.intro')}</p>

      <Progress
        issues={issues}
        total={requiredTotal(profile)}
        afterSave={afterSave}
        dirty={dirty}
        firstOpen={firstOpen}
        onJump={jumpTo}
      />

      <Card className="mb-4 p-5" data-field="legalForm">
        <SelectField
          label={t('firma.legalFormLegend')}
          id="firma-rechtsform"
          value={form}
          onChange={(value) => changeForm(value as LegalForm)}
          helperText={`${t(`firma.legalFormInfo_${form}`)} ${t('firma.legalFormHint')}`}
        >
          {LEGAL_FORM_ORDER.map((value) => (
            <option key={value} value={value}>
              {t(`firma.legalForm_${value}`)}
            </option>
          ))}
        </SelectField>
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
        const progress = sectionProgress(profile, section);
        const collapse = section.optional
          ? {
              open: opened.has(section.id),
              onToggle: (open: boolean) => toggle(section.id, open),
              status: t('firma.sectionStatus', progress),
            }
          : {};
        return (
          <FormSection
            key={section.id}
            id={section.id}
            title={title}
            {...(hint ? { hint } : {})}
            {...collapse}
          >
            {layoutRows(section.fields).map((row) => (
              <FieldRow key={row[0]!.path} count={row.length}>
                {row.map((spec) => (
                  <IssuerField
                    key={spec.path}
                    spec={spec}
                    form={form}
                    profile={profile}
                    error={errorFor(spec.path)}
                    onChange={(path, value) => change((p) => setPathValue(p, path, value))}
                    onBlur={markTouched}
                  />
                ))}
              </FieldRow>
            ))}
            {extraErrors && (
              <p role="alert" className="text-sm text-gefahr">
                {extraErrors}
              </p>
            )}
          </FormSection>
        );
      })}

      <div className="mb-4">
        <FormSection
          id="branding"
          title={t('firma.section_branding')}
          open={opened.has('branding')}
          onToggle={(open) => toggle('branding', open)}
          status={t('firma.sectionStatus', { filled: brandingFilled, total: 2 })}
        >
          <IssuerBranding
            logo={saved.logo}
            accent={accent}
            onAccentChange={(hex) => {
              setAccent(hex);
              setError(null);
            }}
            onLogoChanged={refreshLogo}
          />
        </FormSection>
      </div>

      <p className="mb-4 text-sm text-still">{t('firma.noAdvice')}</p>

      <StickySaveBar
        dirty={dirty}
        saving={saving}
        error={error ?? (!check.valid ? t('firma.accentBlocked') : null)}
        label={t('firma.saveRegion')}
        onSave={save}
        onDiscard={discard}
      />
    </div>
  );
}

/** Höhe der Kopfleiste: Die Anzeige haftet direkt darunter (`top-[58px]`). */
const HEADER_OFFSET = 58;

/**
 * Fortschritt der Pflichtangaben: „Pflichtangaben vollständig" bzw. „Noch N
 * Pflichtangaben offen", dazu ein Sprung zum ersten offenen Feld und die
 * Liste aller offenen Angaben.
 *
 * ZWEI ZUSTÄNDE. In Ruhe steht die ganze Anzeige da (Status, Balken, Hinweis,
 * aufklappbare Liste). Sobald sie unter der Kopfleiste haftet, schrumpft sie
 * auf EINE Zeile: Kurzstatus und Sprung-Knopf; der dünne Balken liegt mobil
 * als Streifen am unteren Rand, ab `sm` zwischen beiden. Gemessen bei 375 px belegte die volle Anzeige dauerhaft
 * 114 px von 812 — ein Siebtel des Fensters, das beim Ausfüllen fehlte.
 *
 * Erkannt wird das Haften mit einem unsichtbaren Marker (`IntersectionObserver`)
 * an der Stelle, an der die Anzeige in Ruhe steht: Er verlässt den Sichtbereich
 * unterhalb der Kopfleiste genau dann, wenn die Anzeige zu haften beginnt.
 * Der Marker liegt außerhalb der Anzeige, ihre Höhe ändert ihn nicht — es gibt
 * kein Hin und Her. Ohne `IntersectionObserver` bleibt die volle Anzeige. Es
 * gibt keine Animation, `prefers-reduced-motion` ist damit erfüllt.
 */
function Progress({
  issues,
  total,
  afterSave,
  dirty,
  firstOpen,
  onJump,
}: {
  issues: IssuerIssue[];
  total: number;
  afterSave: number | null;
  dirty: boolean;
  firstOpen: string | undefined;
  onJump: (path: string) => void;
}) {
  const t = useT();
  const complete = issues.length === 0;
  const done = Math.max(0, total - issues.length);
  const savedNote =
    afterSave !== null && !dirty
      ? afterSave === 0
        ? t('firma.savedComplete')
        : t('firma.savedIncomplete', { count: afterSave })
      : '';

  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Oberhalb der Kopfleiste verschwunden = haftet. Unterhalb des
        // Fensters (noch nicht erreicht) ist es keine Haftung.
        setStuck(!entry.isIntersecting && entry.boundingClientRect.top < HEADER_OFFSET);
      },
      { rootMargin: `-${HEADER_OFFSET}px 0px 0px 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinel} aria-hidden="true" />
      <section
        aria-labelledby="firma-vollstaendigkeit"
        data-testid={complete ? 'issuer-complete' : 'issuer-incomplete'}
        data-after-save={afterSave ?? undefined}
        data-stuck={stuck || undefined}
        className={`sticky top-[58px] z-10 mb-4 rounded-lg border text-sm ${
          stuck ? 'p-2' : 'p-3'
        } ${
          complete
            ? 'border-erfolg-rahmen bg-erfolg-bg text-erfolg-text'
            : 'border-warnung-rahmen bg-warnung-bg text-warnung-text'
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 id="firma-vollstaendigkeit" className="flex items-center gap-2 font-semibold">
            {complete ? (
              <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : (
              <ListChecks className="h-5 w-5 shrink-0" aria-hidden="true" />
            )}
            {complete
              ? t('firma.progressComplete')
              : t(stuck ? 'firma.progressOpenShort' : 'firma.progressOpen', {
                  count: issues.length,
                })}
          </h3>
          <div
            role="progressbar"
            aria-label={t('firma.progressLabel')}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            className={`min-w-20 flex-1 overflow-hidden rounded-full bg-black/10 ${
              stuck ? 'h-1 max-sm:absolute max-sm:inset-x-2 max-sm:bottom-1' : 'h-2'
            }`}
          >
            <div
              className="h-full rounded-full bg-current transition-[width] motion-reduce:transition-none"
              style={{ width: `${Math.round((done / total) * 100)}%` }}
            />
          </div>
          {!complete && firstOpen && (
            <Button
              variant="secondary"
              size="sm"
              className={`min-h-11 sm:min-h-8 ${stuck ? 'ml-auto sm:ml-0' : ''}`}
              onClick={() => onJump(firstOpen)}
            >
              {t('firma.progressJump')}
            </Button>
          )}
        </div>
        <p
          role="status"
          data-testid="issuer-status"
          className={savedNote && !stuck ? 'mt-1' : 'sr-only'}
        >
          {savedNote}
        </p>
        {!complete && !stuck && (
          <details className="mt-2">
            <summary className="min-h-11 cursor-pointer py-3 underline underline-offset-2 sm:min-h-0 sm:py-0">
              {t('firma.progressList')}
            </summary>
            <p className="mb-2 mt-1">{t('firma.incompleteHint')}</p>
            <ul className="max-h-48 list-disc overflow-y-auto pl-5">
              {issues.map((issue) => (
                <li key={`${issue.field}-${issue.code}`}>
                  <button
                    type="button"
                    className="text-left underline underline-offset-2 hover:no-underline"
                    onClick={() => onJump(issue.field)}
                  >
                    {issue.label}
                  </button>
                  {issue.code !== 'missing' && <span>{`: ${t(`firma.issue_${issue.code}`)}`}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </>
  );
}
