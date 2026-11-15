import { useRef, useState } from 'react';
import { validateAccentColor } from '@saas-instant/shared';
import { Button, useToast } from '@saas-instant/ui';
import { deleteIssuerLogo, publicLogoUrl, uploadIssuerLogo, type IssuerLogoInfo } from '../lib/api';
import { errorText } from '../lib/api-client';
import {
  DEFAULT_ACCENT,
  PREVIEW_DARK_BACKGROUND,
  PREVIEW_LIGHT_BACKGROUND,
  formatRatio,
  lightAccentTokens,
  darkAccentTokens,
} from '../lib/accent';
import { validateLogoFile } from '../lib/issuer-logo';
import { useT } from '../i18n';

/** Normalisiert Eingaben wie „0369A1" zu „#0369a1" (nur das Raute-Zeichen wird ergänzt). */
export function normalizeHexInput(raw: string): string {
  const v = raw.trim();
  return v === '' || v.startsWith('#') ? v : `#${v}`;
}

/** Ergebnis der Akzentprüfung für die Anzeige und die Speichersperre. */
export function accentCheck(hex: string) {
  return validateAccentColor(hex);
}

export function IssuerBranding({
  logo,
  accent,
  onAccentChange,
  onLogoChanged,
}: {
  logo: IssuerLogoInfo | null;
  accent: string;
  onAccentChange: (hex: string) => void;
  /** Nach Hochladen oder Entfernen: Elternkomponente lädt den Stand neu. */
  onLogoChanged: () => Promise<void> | void;
}) {
  const t = useT();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = accentCheck(accent);
  const hexValid = check.error !== 'format';
  const accentError =
    check.error === 'format'
      ? t('firma.accentErrFormat')
      : check.error === 'contrast'
        ? t('firma.accentErrContrast', { ratio: formatRatio(check.contrastOnWhite ?? 0) })
        : null;
  const pickerValue = hexValid ? accent.toLowerCase() : DEFAULT_ACCENT;

  const previewLight = hexValid ? lightAccentTokens(accent.toLowerCase()) : null;
  const previewDark =
    hexValid && check.accentOnDark ? darkAccentTokens(check.accentOnDark) : null;

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    const problem = validateLogoFile(file);
    if (problem) {
      setLogoError(
        problem === 'type'
          ? t('firma.logoErrType')
          : problem === 'size'
            ? t('firma.logoErrSize')
            : t('firma.logoErrEmpty'),
      );
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setLogoError(null);
    setBusy(true);
    try {
      await uploadIssuerLogo(file);
      await onLogoChanged();
      toast.show(t('firma.logoUploaded'));
    } catch (f) {
      setLogoError(errorText(f, t('firma.logoUploadFailed')));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function removeLogo() {
    setLogoError(null);
    setBusy(true);
    try {
      await deleteIssuerLogo();
      await onLogoChanged();
      toast.show(t('firma.logoRemoved'));
    } catch (f) {
      setLogoError(errorText(f, t('firma.logoRemoveFailed')));
    } finally {
      setBusy(false);
    }
  }

  const hasLogo = logo?.present === true;
  const logoSrc = hasLogo ? publicLogoUrl(logo?.sha256) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section
        aria-labelledby="firma-logo-titel"
        className="rounded-lg border border-rahmen bg-flaeche p-5"
      >
        <h3 id="firma-logo-titel" className="text-base font-semibold text-text">
          {t('firma.logoHeading')}
        </h3>
        <p id="firma-logo-hinweis" className="mb-3 mt-1 text-sm text-leise">
          {t('firma.logoHint')}
        </p>
        {logoSrc ? (
          <div className="mb-3 grid grid-cols-2 gap-3">
            {[
              { id: 'hell', label: t('firma.logoPreviewLight'), background: PREVIEW_LIGHT_BACKGROUND },
              { id: 'dunkel', label: t('firma.logoPreviewDark'), background: PREVIEW_DARK_BACKGROUND },
            ].map((box) => (
              <figure key={box.id} className="m-0">
                <div
                  className="grid h-24 place-items-center rounded-md border border-rahmen p-2"
                  style={{ background: box.background }}
                >
                  <img
                    src={logoSrc}
                    alt={t('firma.logoPreviewAlt')}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
                <figcaption className="mt-1 text-xs text-leise">{box.label}</figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <p className="mb-3 text-sm text-leise">{t('firma.logoNone')}</p>
        )}
        <input
          ref={fileInput}
          id="firma-logo-datei"
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={(e) => void chooseFile(e.target.files?.[0])}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            loading={busy}
            onClick={() => fileInput.current?.click()}
          >
            {hasLogo ? t('firma.logoReplace') : t('firma.logoChoose')}
          </Button>
          {hasLogo && (
            <Button variant="ghost" disabled={busy} onClick={() => void removeLogo()}>
              {t('firma.logoRemove')}
            </Button>
          )}
        </div>
        {logoError && (
          <p role="alert" className="mt-2 text-sm text-gefahr">
            {logoError}
          </p>
        )}
      </section>

      <section
        aria-labelledby="firma-akzent-titel"
        className="rounded-lg border border-rahmen bg-flaeche p-5"
      >
        <h3 id="firma-akzent-titel" className="text-base font-semibold text-text">
          {t('firma.accentHeading')}
        </h3>
        <p className="mb-3 mt-1 text-sm text-leise">{t('firma.accentHint')}</p>
        <label htmlFor="firma-akzent" className="mb-1 block text-sm font-medium text-text">
          {t('firma.accentHex')}
        </label>
        <div className="flex items-center gap-2">
          <input
            id="firma-akzent"
            value={accent}
            maxLength={7}
            spellCheck={false}
            autoCapitalize="off"
            aria-invalid={accentError ? true : undefined}
            aria-describedby={accentError ? 'firma-akzent-meldung' : 'firma-akzent-ok'}
            onChange={(e) => onAccentChange(normalizeHexInput(e.target.value))}
            className="w-32 rounded-lg border border-rahmen-ui bg-flaeche px-3 py-2 font-mono text-text focus:border-primaer"
          />
          <input
            type="color"
            aria-label={t('firma.accentPicker')}
            value={pickerValue}
            onChange={(e) => onAccentChange(e.target.value)}
            className="h-10 w-12 cursor-pointer rounded-md border border-rahmen-ui bg-flaeche p-1"
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={accent.toLowerCase() === DEFAULT_ACCENT}
            onClick={() => onAccentChange(DEFAULT_ACCENT)}
          >
            {t('firma.accentReset')}
          </Button>
        </div>
        {accentError ? (
          <p id="firma-akzent-meldung" role="alert" className="mt-2 text-sm text-gefahr">
            {accentError}
          </p>
        ) : (
          <p id="firma-akzent-ok" className="mt-2 text-sm text-leise">
            {t('firma.accentOk', { ratio: formatRatio(check.contrastOnWhite ?? 0) })}
          </p>
        )}

        {previewLight && (
          <div className="mt-4" role="group" aria-label={t('firma.accentPreview')}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-still">
              {t('firma.accentPreview')}
            </p>
            <div
              className="flex flex-wrap items-center gap-3 rounded-md border border-rahmen p-3"
              style={{ background: PREVIEW_LIGHT_BACKGROUND }}
            >
              <span
                data-testid="accent-preview-button"
                className="rounded-md px-4 py-2 text-sm font-semibold"
                style={{
                  background: previewLight['--farbe-primaer']!,
                  color: previewLight['--farbe-primaer-text']!,
                }}
              >
                {t('firma.accentPreviewButton')}
              </span>
              <span
                data-testid="accent-preview-chip"
                className="rounded-full border px-3 py-1 text-xs font-semibold"
                style={{
                  background: previewLight['--farbe-primaer-soft']!,
                  color: previewLight['--farbe-primaer-softtext']!,
                  borderColor: previewLight['--farbe-primaer-softrahmen']!,
                }}
              >
                {t('firma.accentPreviewChip')}
              </span>
            </div>
            {previewDark && (
              <div
                className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-rahmen p-3"
                style={{ background: PREVIEW_DARK_BACKGROUND }}
              >
                <span
                  className="rounded-md px-4 py-2 text-sm font-semibold"
                  style={{
                    background: previewDark['--farbe-primaer']!,
                    color: previewDark['--farbe-primaer-text']!,
                  }}
                >
                  {t('firma.accentPreviewDark')}
                </span>
                <span
                  className="rounded-full border px-3 py-1 text-xs font-semibold"
                  style={{
                    background: previewDark['--farbe-primaer-soft']!,
                    color: previewDark['--farbe-primaer-softtext']!,
                    borderColor: previewDark['--farbe-primaer-softrahmen']!,
                  }}
                >
                  {t('firma.accentPreviewChip')}
                </span>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
