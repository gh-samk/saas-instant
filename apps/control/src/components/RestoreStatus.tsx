import { Button, StatusPill } from '@saas-instant/ui';
import type { StatusKind } from '@saas-instant/ui';
import type { InstanceRestore } from '../lib/api';
import { useT } from '../i18n';

const STEPS = ['provisioning', 'restoring', 'ready'] as const;

/** Anzeigeart je Status: bereit/übernommen grün, fehlgeschlagen rot, sonst laufend. */
function kindOf(status: string): StatusKind {
  if (status === 'ready' || status === 'adopted') return 'confirmed';
  if (status === 'failed') return 'problem';
  if (status === 'provisioning' || status === 'restoring') return 'attention';
  return 'neutral';
}

/**
 * Stand einer Wiederherstellung: Anlegen → Einspielen → bereit (oder
 * fehlgeschlagen). Nur im Status „bereit" bietet sie „Übernehmen" an.
 */
export function RestoreStatus({
  restore,
  onAdopt,
  adoptDisabled = false,
}: {
  restore: InstanceRestore;
  onAdopt: (restore: InstanceRestore) => void;
  adoptDisabled?: boolean;
}) {
  const t = useT();
  const label: Record<string, string> = {
    provisioning: t('backup.restoreStatusProvisioning'),
    restoring: t('backup.restoreStatusRestoring'),
    ready: t('backup.restoreStatusReady'),
    failed: t('backup.restoreStatusFailed'),
    adopted: t('backup.restoreStatusAdopted'),
  };
  const currentIndex = STEPS.indexOf(restore.status as (typeof STEPS)[number]);

  return (
    <li className="rounded-lg border border-rahmen p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-words text-sm font-medium text-text">
          {t('backup.restoreStatusLine', { subdomain: restore.newSubdomain })}
        </p>
        <StatusPill kind={kindOf(restore.status)}>
          {label[restore.status] ?? t('backup.restoreStatusUnknown')}
        </StatusPill>
      </div>
      {currentIndex >= 0 && (
        <ol aria-label={t('backup.restoreStepsLabel')} className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-leise">
          {STEPS.map((step, index) => (
            <li
              key={step}
              aria-current={index === currentIndex ? 'step' : undefined}
              className={index === currentIndex ? 'font-semibold text-text' : index < currentIndex ? 'text-text' : ''}
            >
              {index + 1}. {label[step]}
            </li>
          ))}
        </ol>
      )}
      {restore.message && (
        <p
          role={restore.status === 'failed' ? 'alert' : undefined}
          className={`mt-2 break-words text-sm ${restore.status === 'failed' ? 'text-gefahr' : 'text-leise'}`}
        >
          {restore.message}
        </p>
      )}
      {restore.status === 'ready' && (
        <div className="mt-3">
          <Button disabled={adoptDisabled} onClick={() => onAdopt(restore)}>
            {t('backup.adoptButton')}
          </Button>
        </div>
      )}
    </li>
  );
}
