import { useEffect, useState } from 'react';
import { Card, Switch, Skeleton, useToast } from '@saas-instant/ui';
import {
  fetchFeatureFlags,
  setFeatureFlag,
  type FeatureFlag,
} from '../lib/api';
import { ApiError } from '../lib/api-client';
import { useT } from '../i18n';

function dayFrom(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
}

/**
 * Reiter „Funktionen" der Einstellungen: Betriebsschalter, die für ALLE
 * Kundeninstanzen gelten.
 *
 * Kein Bestätigungsdialog: Ein Schalter lässt sich sofort zurückstellen, und
 * jede Änderung steht im Audit-Log. Der Zustand wechselt erst, wenn der
 * Server ihn bestätigt hat — sonst zeigte der Schalter einen Stand, den die
 * Instanzen nie zu sehen bekommen.
 */
export function FeatureFlagManagement() {
  const t = useT();
  const toast = useToast();
  const [entries, setEntries] = useState<FeatureFlag[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    fetchFeatureFlags()
      .then((list) => active && setEntries(list))
      .catch(() => active && setLoadError(t('components.featureFlagManagement.text')));
    return () => {
      active = false;
    };
  }, []);

  async function toggle(entry: FeatureFlag, newValue: boolean) {
    setRunning(entry.key);
    setError(null);
    try {
      const updated = await setFeatureFlag(entry.key, newValue);
      setEntries((alt) =>
        (alt ?? []).map((e) => (e.key === updated.key ? updated : e)),
      );
      toast.show(
        `${updated.label}: ${updated.active ? 'eingeschaltet' : 'ausgeschaltet'}.`,
      );
    } catch (e) {
      setError({
        key: entry.key,
        text:
          e instanceof ApiError
            ? e.error.message
            : t('components.featureFlagManagement.text2'),
      });
    } finally {
      setRunning(null);
    }
  }

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold text-text">{t('components.featureFlagManagement.heading')}</h2>
      <p className="mb-4 text-sm text-leise">
        {t('components.featureFlagManagement.text3')}</p>

      {loadError && (
        <p role="alert" className="text-sm text-gefahr">
          {loadError}
        </p>
      )}
      {!loadError && entries === null && <Skeleton className="h-24 w-full" />}

      <div className="space-y-4">
        {entries?.map((e) => {
          const titleId = `schalter-${e.key}-titel`;
          const descriptionId = `schalter-${e.key}-beschreibung`;
          return (
            <Card key={e.key} className="p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 id={titleId} className="text-base font-semibold text-text">
                    {e.label}
                  </h3>
                  <p id={descriptionId} className="mt-1 text-sm text-leise">
                    {e.description}
                  </p>
                  <p className="mt-2 text-xs text-leise">
                    {e.changedAt
                      ? t('components.featureFlagManagement.text4', { value: dayFrom(e.changedAt) })
                      : t('components.featureFlagManagement.text5', { value: e.defaultValue ? t('components.featureFlagManagement.defaultOn') : t('components.featureFlagManagement.defaultOff') })}
                  </p>
                  {error?.key === e.key && (
                    <p role="alert" className="mt-2 text-sm text-gefahr">
                      {error.text}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm font-medium text-text" aria-hidden="true">
                    {e.active ? t('components.featureFlagManagement.label') : t('components.featureFlagManagement.label2')}
                  </span>
                  <Switch
                    on={e.active}
                    label={e.label}
                    disabled={running === e.key}
                    onToggle={(newValue) => void toggle(e, newValue)}
                  />
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
