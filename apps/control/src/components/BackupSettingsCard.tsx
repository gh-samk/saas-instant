import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  InputField,
  NoticeBar,
  Skeleton,
  Switch,
  useToast,
} from '@saas-instant/ui';
import {
  fetchBackupSettings,
  saveBackupSettings,
  testBackupTarget,
  type BackupSettings,
  type BackupSettingsInput,
  type SecondFactorEvidence,
} from '../lib/api';
import { ApiError, errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import { formatDate } from '../utils/date';
import { useT, type TFunction } from '../i18n';
import { SelectField } from './FormFields';
import { AgeKeyDialog } from './AgeKeyDialog';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';

export interface BackupForm {
  type: 's3' | 'storagebox';
  schedule: 'daily' | 'twice_daily';
  retentionDays: string;
  objectLock: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  host: string;
  port: string;
  username: string;
  path: string;
  authType: 'key' | 'password';
  privateKey: string;
  password: string;
}

/** Formularstand aus den gespeicherten Metadaten (auch Präfix, Pfad-Stil, Anmeldeart); Geheimfelder bleiben immer leer. */
export function formFrom(settings: BackupSettings | null): BackupForm {
  const target = settings?.target ?? null;
  const isBox = target?.type === 'storagebox';
  return {
    type: target?.type ?? 's3',
    schedule: target?.schedule === 'twice_daily' ? 'twice_daily' : 'daily',
    retentionDays: String(target?.retentionDays ?? 30),
    objectLock: settings?.agent.objectLock ?? false,
    endpoint: target?.endpoint ?? '',
    region: target?.region ?? '',
    bucket: target?.bucket ?? '',
    prefix: target?.type === 's3' ? (target.prefix ?? target.path ?? '') : '',
    pathStyle: target?.pathStyle ?? false,
    accessKeyId: '',
    secretAccessKey: '',
    host: target?.host ?? '',
    port: String(target?.port ?? 23),
    username: target?.username ?? '',
    path: isBox ? (target?.path ?? '') : '',
    authType: target?.authType ?? 'key',
    privateKey: '',
    password: '',
  };
}

/**
 * Prüft das Formular wie der Server und liefert die Eingabe fürs Speichern.
 *
 * Mit gespeichertem Ziel gleichen Typs (bei der Storage Box auch gleicher
 * Anmeldeart) dürfen die Geheimfelder leer bleiben: Sie werden dann nicht
 * gesendet, und der Agent behält die gespeicherten Werte.
 */
export function validate(
  form: BackupForm,
  t: TFunction,
  existing: BackupSettings['target'] = null,
): { problems: string[]; input: BackupSettingsInput | null } {
  const problems: string[] = [];
  const retention = /^\d+$/.test(form.retentionDays.trim())
    ? Number(form.retentionDays.trim())
    : NaN;
  if (!(retention >= 1 && retention <= 3650)) problems.push(t('backup.errRetention'));

  const base = {
    type: form.type,
    schedule: form.schedule,
    retentionDays: retention,
    objectLock: form.type === 's3' && form.objectLock,
  };

  if (form.type === 's3') {
    if (!/^https?:\/\/[^\s/]+/.test(form.endpoint.trim())) problems.push(t('backup.errEndpoint'));
    if (form.region.trim() === '') problems.push(t('backup.errRegion'));
    if (form.bucket.trim() === '') problems.push(t('backup.errBucket'));
    const keepS3 = existing?.type === 's3';
    const hasId = form.accessKeyId !== '';
    const hasSecret = form.secretAccessKey !== '';
    if (hasId !== hasSecret && keepS3) {
      problems.push(t('backup.errSecretPair'));
    } else if (!keepS3 || hasId || hasSecret) {
      if (!hasId) problems.push(t('backup.errAccessKeyId'));
      if (!hasSecret) problems.push(t('backup.errSecretAccessKey'));
    }
    if (problems.length > 0) return { problems, input: null };
    return {
      problems,
      input: {
        ...base,
        s3: {
          endpoint: form.endpoint.trim(),
          region: form.region.trim(),
          bucket: form.bucket.trim(),
          prefix: form.prefix.trim(),
          pathStyle: form.pathStyle,
          ...(hasId && hasSecret
            ? { accessKeyId: form.accessKeyId, secretAccessKey: form.secretAccessKey }
            : {}),
        },
      },
    };
  }

  const port = /^\d+$/.test(form.port.trim()) ? Number(form.port.trim()) : NaN;
  if (form.host.trim() === '') problems.push(t('backup.errHost'));
  if (!(port >= 1 && port <= 65535)) problems.push(t('backup.errPort'));
  if (form.username.trim() === '') problems.push(t('backup.errUsername'));
  if (form.path.trim() === '') problems.push(t('backup.errPath'));
  const keepBox =
    existing?.type === 'storagebox' &&
    (existing.authType === null || existing.authType === form.authType);
  if (form.authType === 'key' && form.privateKey.trim() === '' && !keepBox) {
    problems.push(t('backup.errPrivateKey'));
  }
  if (form.authType === 'password' && form.password === '' && !keepBox) {
    problems.push(t('backup.errPassword'));
  }
  if (problems.length > 0) return { problems, input: null };
  return {
    problems,
    input: {
      ...base,
      storagebox: {
        host: form.host.trim(),
        port,
        username: form.username.trim(),
        path: form.path.trim(),
        authType: form.authType,
        ...(form.authType === 'key'
          ? form.privateKey.trim() === ''
            ? {}
            : { privateKey: form.privateKey }
          : form.password === ''
            ? {}
            : { password: form.password }),
      },
    },
  };
}

type Pending = 'save' | 'test';

/**
 * Einstellungen → Sicherung.
 *
 * Geheimfelder sind write-only: Sie werden nie vorbelegt, nach dem Speichern
 * geleert und gehen ausschließlich im PUT an den Server, der sie an den Agent
 * weiterreicht. Speichern und Testen liegen hinter dem zweiten Faktor.
 */
export function BackupSettingsCard({ totpPossible = false }: { totpPossible?: boolean }) {
  const t = useT();
  const toast = useToast();
  const evidenceState = useSecondFactorEvidence();
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<BackupForm>(() => formFrom(null));
  const [showProblems, setShowProblems] = useState(false);
  const [pending, setPending] = useState<Pending>('save');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [ageIdentity, setAgeIdentity] = useState<string | null>(null);
  const lives = useRef(true);

  const load = useCallback(async () => {
    setLoaded(false);
    setLoadError(null);
    try {
      const response = await fetchBackupSettings();
      if (!lives.current) return;
      setSettings(response);
      setForm(formFrom(response));
    } catch (e) {
      if (!lives.current) return;
      setLoadError(
        e instanceof ApiError && e.error.code === 'backup_agent_unavailable'
          ? t('backup.agentUnavailable')
          : errorText(e, t('backup.loadError')),
      );
    } finally {
      if (lives.current) setLoaded(true);
    }
  }, [t]);

  useEffect(() => {
    lives.current = true;
    void load();
    return () => {
      lives.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function set<K extends keyof BackupForm>(key: K, value: BackupForm[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  const check = validate(form, t, settings?.target ?? null);

  async function run(action: Pending, evidence?: SecondFactorEvidence) {
    setBusy(true);
    setActionError(null);
    try {
      if (action === 'test') {
        const result = await testBackupTarget(evidence);
        evidenceState.close();
        setTestResult({ ok: result.ok, message: result.message });
      } else if (check.input !== null) {
        const response = await saveBackupSettings(check.input, evidence);
        evidenceState.close();
        setSettings(response);
        // Geheimnisse sofort aus dem Speicher der Ansicht räumen.
        setForm({ ...formFrom(response), accessKeyId: '', secretAccessKey: '', privateKey: '', password: '' });
        toast.show(t('backup.saved'));
        if (response.ageIdentity) setAgeIdentity(response.ageIdentity);
      }
    } catch (e) {
      if (evidenceState.handle(e, evidence)) return;
      setActionError(
        e instanceof ApiError && e.error.code === 'backup_agent_unavailable'
          ? t('backup.agentUnavailable')
          : errorText(e, action === 'save' ? t('backup.saveFailed') : t('backup.testRequestFailed')),
      );
    } finally {
      setBusy(false);
    }
  }

  function start(action: Pending) {
    setPending(action);
    setTestResult(null);
    if (action === 'save') {
      setShowProblems(true);
      if (check.input === null) return;
    }
    void run(action);
  }

  if (!loaded) {
    return (
      <Card className="p-6" aria-busy="true">
        <Skeleton className="mb-4 h-6 w-40" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </Card>
    );
  }

  if (loadError !== null) {
    return (
      <Card className="p-6">
        <p role="alert" className="mb-3 text-sm text-text">{loadError}</p>
        <Button variant="secondary" onClick={() => void load()}>{t('backup.retry')}</Button>
      </Card>
    );
  }

  const configured = settings?.target != null;
  const agent = settings?.agent;
  const target = settings?.target ?? null;
  const secretPlaceholder =
    configured && target?.type === form.type ? t('backup.secretSetPlaceholder') : undefined;
  const isS3 = form.type === 's3';

  return (
    <Card className="p-6">
      <h2 className="mb-1 text-lg font-semibold text-text">{t('backup.settingsTitle')}</h2>
      <p className="mb-4 text-sm text-leise">{t('backup.settingsIntro')}</p>

      {agent && !agent.configured ? (
        <NoticeBar kind="problem" className="mb-4">{t('backup.agentNotConfigured')}</NoticeBar>
      ) : agent && !agent.reachable ? (
        <NoticeBar kind="problem" className="mb-4">{t('backup.agentUnavailable')}</NoticeBar>
      ) : agent ? (
        <NoticeBar kind="confirmed" className="mb-4">
          {agent.version
            ? t('backup.agentOk', { version: agent.version })
            : t('backup.agentOkNoVersion')}
        </NoticeBar>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          start('save');
        }}
        noValidate
      >
        <SelectField
          id="sicherung-typ"
          label={t('backup.targetTypeLabel')}
          value={form.type}
          onChange={(value) => set('type', value === 'storagebox' ? 'storagebox' : 's3')}
        >
          <option value="s3">{t('backup.targetTypeS3')}</option>
          <option value="storagebox">{t('backup.targetTypeStoragebox')}</option>
        </SelectField>

        {isS3 ? (
          <>
            <InputField id="sicherung-endpunkt" label={t('backup.s3Endpoint')} helperText={t('backup.s3EndpointHint')} value={form.endpoint} onChange={(e) => set('endpoint', e.target.value)} autoComplete="off" />
            <InputField id="sicherung-region" label={t('backup.s3Region')} value={form.region} onChange={(e) => set('region', e.target.value)} autoComplete="off" />
            <InputField id="sicherung-bucket" label={t('backup.s3Bucket')} value={form.bucket} onChange={(e) => set('bucket', e.target.value)} autoComplete="off" />
            <InputField id="sicherung-praefix" label={t('backup.s3Prefix')} helperText={t('backup.s3PrefixHint')} value={form.prefix} onChange={(e) => set('prefix', e.target.value)} autoComplete="off" />
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">{t('backup.s3PathStyle')}</p>
                <p className="text-sm text-leise">{t('backup.s3PathStyleHint')}</p>
              </div>
              <Switch on={form.pathStyle} onToggle={(v) => set('pathStyle', v)} label={t('backup.s3PathStyle')} />
            </div>
            <InputField id="sicherung-schluessel-id" label={t('backup.s3AccessKeyId')} placeholder={secretPlaceholder} value={form.accessKeyId} onChange={(e) => set('accessKeyId', e.target.value)} autoComplete="off" />
            <InputField id="sicherung-geheimschluessel" label={t('backup.s3SecretAccessKey')} type="password" placeholder={secretPlaceholder} value={form.secretAccessKey} onChange={(e) => set('secretAccessKey', e.target.value)} autoComplete="new-password" />
          </>
        ) : (
          <>
            <InputField id="sicherung-host" label={t('backup.boxHost')} value={form.host} onChange={(e) => set('host', e.target.value)} autoComplete="off" />
            <InputField id="sicherung-port" label={t('backup.boxPort')} inputMode="numeric" value={form.port} onChange={(e) => set('port', e.target.value)} autoComplete="off" />
            <InputField id="sicherung-benutzer" label={t('backup.boxUsername')} value={form.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
            <InputField id="sicherung-pfad" label={t('backup.boxPath')} value={form.path} onChange={(e) => set('path', e.target.value)} autoComplete="off" />
            <SelectField
              id="sicherung-auth"
              label={t('backup.boxAuthType')}
              value={form.authType}
              onChange={(value) => set('authType', value === 'password' ? 'password' : 'key')}
            >
              <option value="key">{t('backup.boxAuthKey')}</option>
              <option value="password">{t('backup.boxAuthPassword')}</option>
            </SelectField>
            {form.authType === 'key' ? (
              <div className="mb-4 text-left">
                <label htmlFor="sicherung-privater-schluessel" className="mb-1 block text-sm font-medium text-text">
                  {t('backup.boxPrivateKey')}
                </label>
                <textarea
                  id="sicherung-privater-schluessel"
                  rows={4}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={secretPlaceholder}
                  value={form.privateKey}
                  onChange={(e) => set('privateKey', e.target.value)}
                  className="w-full rounded-lg border border-rahmen-ui bg-flaeche px-3 py-2 font-mono text-sm text-text placeholder:text-still focus:border-primaer"
                />
              </div>
            ) : (
              <InputField id="sicherung-passwort" label={t('backup.boxPassword')} type="password" placeholder={secretPlaceholder} value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
            )}
          </>
        )}

        <p className="mb-4 text-sm text-leise">
          {configured ? t('backup.secretKeepHint') : t('backup.secretRequiredHint')}
        </p>
        {!isS3 && configured && target?.type === 'storagebox' && (
          <div className="mb-4 text-sm">
            <p className="font-medium text-text">{t('backup.hostKeyLabel')}</p>
            <p className="break-all font-mono text-text" data-testid="host-key-fingerprint">
              {target.hostKeyFingerprint ?? t('backup.hostKeyUnknown')}
            </p>
            <p className="text-leise">{t('backup.hostKeyHint')}</p>
          </div>
        )}

        <SelectField
          id="sicherung-zeitplan"
          label={t('backup.schedule')}
          value={form.schedule}
          onChange={(value) => set('schedule', value === 'twice_daily' ? 'twice_daily' : 'daily')}
        >
          <option value="daily">{t('backup.scheduleDaily')}</option>
          <option value="twice_daily">{t('backup.scheduleTwiceDaily')}</option>
        </SelectField>
        <InputField id="sicherung-aufbewahrung" label={t('backup.retentionDays')} helperText={t('backup.retentionHint')} inputMode="numeric" value={form.retentionDays} onChange={(e) => set('retentionDays', e.target.value)} autoComplete="off" />

        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id="sicherung-objectlock-label" className="text-sm font-medium text-text">{t('backup.objectLock')}</p>
            <p className="text-sm text-leise">{isS3 ? t('backup.objectLockHint') : t('backup.objectLockOnlyS3')}</p>
          </div>
          <Switch on={isS3 && form.objectLock} disabled={!isS3} onToggle={(v) => set('objectLock', v)} label={t('backup.objectLock')} />
        </div>

        {showProblems && check.problems.length > 0 && (
          <div role="alert" className="mb-4 text-sm text-gefahr">
            <p className="font-medium">{t('backup.errorsTitle')}</p>
            <ul className="list-disc pl-5">
              {check.problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
        )}
        {actionError !== null && (
          <p role="alert" className="mb-4 text-sm text-gefahr">{actionError}</p>
        )}
        {testResult !== null && (
          <NoticeBar kind={testResult.ok ? 'confirmed' : 'problem'} className="mb-4">
            <span role="status">
              {testResult.ok
                ? t('backup.testOk', { message: testResult.message })
                : t('backup.testFailed', { message: testResult.message })}
            </span>
          </NoticeBar>
        )}
        {target?.lastTestAt && testResult === null && (
          <p className="mb-4 text-sm text-leise">
            {t('backup.lastTest', {
              date: formatDate(target.lastTestAt),
              result: target.lastTestOk ? t('backup.lastTestOk') : t('backup.lastTestFailed'),
            })}
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={busy && pending === 'save'} disabled={busy || (agent?.configured === false)}>
            {t('backup.saveButton')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            loading={busy && pending === 'test'}
            disabled={busy || !configured}
            onClick={() => start('test')}
          >
            {t('backup.testButton')}
          </Button>
        </div>
      </form>

      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={pending === 'save' ? t('backup.evidenceTitleSave') : t('backup.evidenceTitleTest')}
        declaration={pending === 'save' ? t('backup.evidenceReasonSave') : t('backup.evidenceReasonTest')}
        totpPossible={totpPossible}
        loading={busy}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => void run(pending, evidence)}
      />

      <AgeKeyDialog identity={ageIdentity} onClose={() => setAgeIdentity(null)} />
    </Card>
  );
}
