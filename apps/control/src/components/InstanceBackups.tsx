import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Skeleton, StatusPill, Table, useToast } from '@saas-instant/ui';
import {
  adoptInstanceRestore,
  fetchBackupJob,
  fetchInstanceBackups,
  fetchInstanceRestores,
  startInstanceBackup,
  type BackupJobView,
  type InstanceBackupRow,
  type InstanceRestore,
  type SecondFactorEvidence,
} from '../lib/api';
import { errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import { tableRow, tableText } from '../lib/density';
import { formatDate } from '../utils/date';
import { formatSize } from '../utils/size';
import { useT } from '../i18n';
import { RestoreInstanceDialog } from './RestoreInstanceDialog';
import { RestoreStatus } from './RestoreStatus';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';

const ACTIVE_RESTORE = ['provisioning', 'restoring'];

/**
 * Sicherungen einer Instanz: Liste, „Jetzt sichern" mit Jobstatus,
 * Wiederherstellung als NEUE Instanz samt Stand und „Übernehmen".
 *
 * Nichts davon löscht etwas: Die Wiederherstellung legt zusätzlich an, die
 * Übernahme stoppt die alte Instanz (der Server löscht nie).
 */
export function InstanceBackups({
  instanceId,
  subdomain,
  totpPossible,
  onAdopted,
  pollMs = 3000,
}: {
  instanceId: string;
  subdomain: string;
  totpPossible: boolean;
  /** Nach erfolgreicher Übernahme: Instanzdaten neu laden. */
  onAdopted?: () => void;
  pollMs?: number;
}) {
  const t = useT();
  const toast = useToast();
  const backupEvidence = useSecondFactorEvidence();
  const adoptEvidence = useSecondFactorEvidence();
  const [backups, setBackups] = useState<InstanceBackupRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restores, setRestores] = useState<InstanceRestore[]>([]);
  const [restoreLoadError, setRestoreLoadError] = useState<string | null>(null);
  const [job, setJob] = useState<BackupJobView | null>(null);
  const [jobMessage, setJobMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreFor, setRestoreFor] = useState<InstanceBackupRow | null>(null);
  const [adoptFor, setAdoptFor] = useState<InstanceRestore | null>(null);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [adoptLoading, setAdoptLoading] = useState(false);
  const lives = useRef(true);

  const loadBackups = useCallback(async () => {
    try {
      const response = await fetchInstanceBackups(instanceId);
      if (!lives.current) return;
      setBackups(Array.isArray(response?.backups) ? response.backups : []);
      setLoadError(null);
    } catch (e) {
      if (!lives.current) return;
      setLoadError(errorText(e, t('backup.instanceLoadError')));
    }
  }, [instanceId, t]);

  const loadRestores = useCallback(async () => {
    try {
      const response = await fetchInstanceRestores(instanceId);
      if (!lives.current) return;
      setRestores(Array.isArray(response) ? response : []);
      setRestoreLoadError(null);
    } catch (e) {
      if (!lives.current) return;
      setRestoreLoadError(errorText(e, t('backup.restoreLoadError')));
    }
  }, [instanceId, t]);

  useEffect(() => {
    lives.current = true;
    void loadBackups();
    void loadRestores();
    return () => {
      lives.current = false;
    };
  }, [loadBackups, loadRestores]);

  // Läuft eine Wiederherstellung, nachfragen, bis sie bereit oder gescheitert ist.
  const restoreRunning = restores.some((r) => ACTIVE_RESTORE.includes(r.status));
  useEffect(() => {
    if (!restoreRunning) return;
    const clock = setInterval(() => void loadRestores(), pollMs);
    return () => clearInterval(clock);
  }, [restoreRunning, loadRestores, pollMs]);

  // Läuft ein Sicherungsauftrag, seinen Stand abfragen.
  const jobId = job?.id ?? null;
  const jobOpen = job !== null && (job.status === 'queued' || job.status === 'running');
  useEffect(() => {
    if (jobId === null || !jobOpen) return;
    const clock = setInterval(() => {
      void (async () => {
        try {
          const view = await fetchBackupJob(instanceId, jobId);
          if (!lives.current) return;
          setJob(view);
          setJobMessage(null);
          if (view.status === 'succeeded' || view.status === 'deferred') void loadBackups();
        } catch (e) {
          if (!lives.current) return;
          setJobMessage(errorText(e, t('backup.jobPollFailed')));
        }
      })();
    }, pollMs);
    return () => clearInterval(clock);
  }, [jobId, jobOpen, instanceId, pollMs, loadBackups, t]);

  async function backupNow(evidence?: SecondFactorEvidence) {
    setBusy(true);
    setError(null);
    try {
      const { jobId: id } = await startInstanceBackup(instanceId, evidence);
      backupEvidence.close();
      setJob({ id, kind: 'backup', status: 'queued', startedAt: null, finishedAt: null, message: null, result: null });
    } catch (e) {
      if (backupEvidence.handle(e, evidence)) return;
      setError(errorText(e, t('backup.jobStartFailed')));
    } finally {
      setBusy(false);
    }
  }

  async function adopt(evidence: SecondFactorEvidence) {
    if (adoptFor === null) return;
    setAdoptLoading(true);
    setAdoptError(null);
    try {
      await adoptInstanceRestore(instanceId, adoptFor.id, evidence);
      adoptEvidence.close();
      setAdoptFor(null);
      toast.show(t('backup.adoptDone'));
      void loadRestores();
      onAdopted?.();
    } catch (e) {
      if (adoptEvidence.handle(e, evidence)) return;
      setAdoptError(errorText(e, t('backup.adoptFailed')));
    } finally {
      setAdoptLoading(false);
    }
  }

  const jobText =
    job === null
      ? null
      : job.status === 'queued'
        ? t('backup.jobQueued')
        : job.status === 'running'
          ? t('backup.jobRunning')
          : job.status === 'succeeded'
            ? t('backup.jobSucceeded')
            : job.status === 'deferred'
              ? t('backup.jobDeferred')
              : job.message
              ? t('backup.jobFailedWithMessage', { message: job.message })
              : t('backup.jobFailed');

  const columns = [
    t('backup.columnDate'),
    t('backup.columnSize'),
    t('backup.columnVerified'),
    t('backup.columnAction'),
  ];

  return (
    <section aria-labelledby="sicherungen-titel" className="mt-6 border-t border-rahmen pt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 id="sicherungen-titel" className="text-base font-semibold text-text">
          {t('backup.instanceHeading')}
        </h3>
        <Button variant="secondary" loading={busy} disabled={jobOpen} onClick={() => void backupNow()}>
          {t('backup.backupNow')}
        </Button>
      </div>

      {jobText !== null && (
        <p role="status" className={`mb-3 text-sm ${job?.status === 'failed' ? 'text-gefahr' : 'text-text'}`}>
          {jobText}
        </p>
      )}
      {jobMessage !== null && <p role="alert" className="mb-3 text-sm text-gefahr">{jobMessage}</p>}
      {error !== null && <p role="alert" className="mb-3 text-sm text-gefahr">{error}</p>}

      {loadError !== null ? (
        <p role="alert" className="text-sm text-gefahr">{loadError}</p>
      ) : backups === null ? (
        <div aria-busy="true"><Skeleton className="h-16 w-full rounded-lg" /></div>
      ) : backups.length === 0 ? (
        <p className="text-sm text-leise">{t('backup.instanceEmpty')}</p>
      ) : (
        <Table columns={columns} label={t('backup.tableCaption')}>
          {backups.map((b) => (
            <tr key={b.id} className="transition-colors hover:bg-flaeche-3">
              <td className={`${tableRow.compact} ${tableText.compact.primary}`}>{formatDate(b.date)}</td>
              <td className={`${tableRow.compact} ziffern-tabellarisch ${tableText.compact.data}`}>{formatSize(b.sizeBytes)}</td>
              <td className={`${tableRow.compact} ${tableText.compact.secondary}`}>
                {b.verified ? (
                  <StatusPill kind="confirmed">{t('backup.verifiedYes')}</StatusPill>
                ) : (
                  <>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">{t('backup.verifiedNo')}</span>
                  </>
                )}
              </td>
              <td className={tableRow.compact}>
                {b.restorable ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={t('backup.restoreRowLabel', { date: formatDate(b.date) })}
                    onClick={() => setRestoreFor(b)}
                  >
                    {t('backup.restoreRow')}
                  </Button>
                ) : (
                  <span className={tableText.compact.secondary}>{t('backup.notRestorable')}</span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {restoreLoadError !== null && <p role="alert" className="mt-3 text-sm text-gefahr">{restoreLoadError}</p>}
      {restores.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-2 text-sm font-semibold text-text">{t('backup.restoreStatusHeading')}</h4>
          <ul className="flex flex-col gap-2">
            {restores.map((r) => (
              <RestoreStatus
                key={r.id}
                restore={r}
                onAdopt={(restore) => {
                  setAdoptError(null);
                  setAdoptFor(restore);
                }}
              />
            ))}
          </ul>
        </div>
      )}

      <RestoreInstanceDialog
        open={restoreFor !== null}
        instanceId={instanceId}
        subdomain={subdomain}
        backup={restoreFor}
        totpPossible={totpPossible}
        onClose={() => setRestoreFor(null)}
        onStarted={(restore) => {
          setRestoreFor(null);
          setRestores((previous) => [restore, ...previous.filter((r) => r.id !== restore.id)]);
          toast.show(t('backup.restoreStarted'));
        }}
      />

      <SecondFactorEvidenceDialog
        open={backupEvidence.open}
        title={t('backup.evidenceTitleBackup')}
        declaration={t('backup.evidenceReasonBackup')}
        totpPossible={totpPossible}
        loading={busy}
        error={backupEvidence.error}
        onCancel={backupEvidence.close}
        onConfirm={(evidence) => void backupNow(evidence)}
      />

      <SecondFactorEvidenceDialog
        open={adoptFor !== null}
        title={t('backup.adoptTitle')}
        declaration={`${t('backup.adoptExplanation')} ${t('backup.adoptEvidenceReason')}`}
        totpPossible={totpPossible}
        loading={adoptLoading}
        error={adoptEvidence.error ?? adoptError ?? undefined}
        onCancel={() => {
          setAdoptFor(null);
          setAdoptError(null);
          adoptEvidence.close();
        }}
        onConfirm={(evidence) => void adopt(evidence)}
      />
    </section>
  );
}
