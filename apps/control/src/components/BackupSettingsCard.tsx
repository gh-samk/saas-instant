import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
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
import { useDirtyState, useUnsavedChanges } from '../lib/unsaved-changes';
import { SelectField } from './FormFields';
import { StickySaveBar } from './StickySaveBar';
import { AgeKeyDialog } from './AgeKeyDialog';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';

/**
 * Anbieter-Vorlagen für S3-Ziele. Sie füllen nur Endpunkt, Region und
 * Path-Style vor und werden nicht gespeichert: Beim Laden erkennt
 * `detectProvider` sie wieder an den Werten.
 */
export type S3Provider = 'hetzner' | 'aws' | 'minio' | 'other';

/**
 * Hetzner Object Storage: Standorte fsn1, nbg1, hel1; Endpunkt
 * `https://<standort>.your-objectstorage.com`, der Standort ist zugleich die
 * Region; Adressierung virtual-host (Quelle: docs.hetzner.com/storage/object-storage).
 */
export const HETZNER_LOCATIONS = ['fsn1', 'nbg1', 'hel1'] as const;
/** AWS S3: regionaler Endpunkt `https://s3.<region>.amazonaws.com`, virtual-host (Quelle: AWS General Reference, S3-Endpunkte). */
const AWS_DEFAULT_REGION = 'eu-central-1';
/** MinIO: Path-Style, Standardregion us-east-1. */
const MINIO_DEFAULT_REGION = 'us-east-1';
const DEFAULT_RETENTION = '30';

function hetznerEndpoint(location: string): string {
  return `https://${location}.your-objectstorage.com`;
}
function awsEndpoint(region: string): string {
  return `https://s3.${region.trim()}.amazonaws.com`;
}
function isHetznerLocation(value: string): boolean {
  return (HETZNER_LOCATIONS as readonly string[]).includes(value);
}

/** Erkennt die Vorlage aus den gespeicherten Werten; passt keine, gilt „Anderer“. */
export function detectProvider(endpoint: string, region: string, pathStyle: boolean): S3Provider {
  if (!pathStyle && isHetznerLocation(region) && endpoint === hetznerEndpoint(region)) return 'hetzner';
  if (!pathStyle && region !== '' && endpoint === awsEndpoint(region)) return 'aws';
  if (pathStyle) return 'minio';
  return 'other';
}

/** Wendet eine Vorlage an: setzt Endpunkt, Region und Path-Style; Präfix und Rest bleiben. */
export function applyProvider(form: BackupForm, provider: S3Provider): BackupForm {
  const previousDerived =
    form.provider === 'hetzner' || form.provider === 'aws' ? form.endpoint : '';
  const keepRegion = form.region !== '' && !(form.provider === 'hetzner' && provider !== 'hetzner');
  if (provider === 'hetzner') {
    const region = isHetznerLocation(form.region) ? form.region : HETZNER_LOCATIONS[0];
    return { ...form, provider, region, endpoint: hetznerEndpoint(region), pathStyle: false };
  }
  if (provider === 'aws') {
    const region = keepRegion ? form.region : AWS_DEFAULT_REGION;
    return { ...form, provider, region, endpoint: awsEndpoint(region), pathStyle: false };
  }
  if (provider === 'minio') {
    return {
      ...form,
      provider,
      region: keepRegion ? form.region : MINIO_DEFAULT_REGION,
      endpoint: form.endpoint === previousDerived ? '' : form.endpoint,
      pathStyle: true,
    };
  }
  return {
    ...form,
    provider,
    region: keepRegion ? form.region : '',
    endpoint: form.endpoint === previousDerived ? '' : form.endpoint,
  };
}

/** Region geändert: bei Hetzner und AWS folgt der Endpunkt der Region. */
function withRegion(form: BackupForm, region: string): BackupForm {
  if (form.provider === 'hetzner') return { ...form, region, endpoint: hetznerEndpoint(region) };
  if (form.provider === 'aws') return { ...form, region, endpoint: awsEndpoint(region) };
  return { ...form, region };
}

export interface BackupForm {
  provider: S3Provider;
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
  /** Optional: SSH-Host-Key-Fingerabdruck (SHA256:…); leer = der Agent pinnt beim Verbindungstest. */
  hostKeyFingerprint: string;
}

/** Formularstand aus den gespeicherten Metadaten (auch Präfix, Pfad-Stil, Anmeldeart); Geheimfelder bleiben immer leer. */
export function formFrom(settings: BackupSettings | null): BackupForm {
  const target = settings?.target ?? null;
  const isBox = target?.type === 'storagebox';
  const endpoint = target?.endpoint ?? '';
  const region = target?.region ?? '';
  const pathStyle = target?.pathStyle ?? false;
  return {
    provider: target?.type === 's3' ? detectProvider(endpoint, region, pathStyle) : 'other',
    type: target?.type ?? 's3',
    schedule: target?.schedule === 'twice_daily' ? 'twice_daily' : 'daily',
    retentionDays: target?.retentionDays != null ? String(target.retentionDays) : DEFAULT_RETENTION,
    objectLock: settings?.agent.objectLock ?? false,
    endpoint,
    region,
    bucket: target?.bucket ?? '',
    prefix: target?.type === 's3' ? (target.prefix ?? target.path ?? '') : '',
    pathStyle,
    accessKeyId: '',
    secretAccessKey: '',
    host: target?.host ?? '',
    port: String(target?.port ?? 23),
    username: target?.username ?? '',
    path: isBox ? (target?.path ?? '') : '',
    authType: target?.authType ?? 'key',
    privateKey: '',
    password: '',
    hostKeyFingerprint: '',
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
    // Gespeicherte Zugangsdaten bleiben nur bei gleichem Endpunkt und Bucket (der Agent prüft dasselbe).
    const sameS3Type = existing?.type === 's3';
    const keepS3 = sameS3Type && existing.endpoint === form.endpoint.trim() && existing.bucket === form.bucket.trim();
    const hasId = form.accessKeyId !== '';
    const hasSecret = form.secretAccessKey !== '';
    if (hasId !== hasSecret && keepS3) {
      problems.push(t('backup.errSecretPair'));
    } else if (!keepS3 || hasId || hasSecret) {
      if (!hasId) problems.push(t('backup.errAccessKeyId'));
      if (!hasSecret) problems.push(t('backup.errSecretAccessKey'));
      if (sameS3Type && !keepS3 && !(hasId && hasSecret)) problems.push(t('backup.errSecretAgain'));
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
  const sameBoxType =
    existing?.type === 'storagebox' &&
    (existing.authType === null || existing.authType === form.authType);
  // Passwort bzw. Schlüssel bleiben nur bei gleichem Host, Port und Benutzer (der Agent prüft dasselbe).
  const keepBox =
    sameBoxType &&
    existing.host === form.host.trim() &&
    existing.port === port &&
    existing.username === form.username.trim();
  const hostKeyFingerprint = form.hostKeyFingerprint.trim();
  if (hostKeyFingerprint !== '' && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKeyFingerprint)) problems.push(t('backup.errHostKey'));
  if (form.authType === 'key' && form.privateKey.trim() === '' && !keepBox) {
    problems.push(t('backup.errPrivateKey'));
  }
  if (form.authType === 'password' && form.password === '' && !keepBox) {
    problems.push(t('backup.errPassword'));
  }
  const secretMissing = form.authType === 'key' ? form.privateKey.trim() === '' : form.password === '';
  if (sameBoxType && !keepBox && secretMissing) problems.push(t('backup.errSecretAgain'));
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
        ...(hostKeyFingerprint !== '' ? { hostKeyFingerprint } : {}),
      },
    },
  };
}

type Pending = 'saveTest' | 'test';

/** Felder, die nach dem Speichern leer sind (Geheimnisse sind write-only). */
function withoutSecrets(form: BackupForm): BackupForm {
  return { ...form, accessKeyId: '', secretAccessKey: '', privateKey: '', password: '', hostKeyFingerprint: '' };
}

/** Zwei Spalten ab `sm`, mobil untereinander. */
const GRID = 'grid gap-x-4 sm:grid-cols-2';

/**
 * Einstellungen → Sicherung.
 *
 * Geheimfelder sind write-only: Sie werden nie vorbelegt, nach dem Speichern
 * geleert und gehen ausschließlich im PUT an den Server, der sie an den Agent
 * weiterreicht. Speichern und Testen liegen hinter dem zweiten Faktor.
 * „Speichern und testen“ ist EIN Ablauf: erst speichern, dann testen, mit
 * demselben Nachweis. Verlangt der Server den Nachweis erst beim Test, fragt der
 * Dialog dort nach und wiederholt nur den Test.
 */
export function BackupSettingsCard({ totpPossible = false }: { totpPossible?: boolean }) {
  const t = useT();
  const toast = useToast();
  const evidenceState = useSecondFactorEvidence();
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<BackupForm>(() => formFrom(null));
  const { dirty, baseline, isDirty, markSaved } = useDirtyState(form);
  useUnsavedChanges(isDirty);
  const [showProblems, setShowProblems] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pending, setPending] = useState<Pending>('saveTest');
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
      const next = formFrom(response);
      setSettings(response);
      setForm(next);
      markSaved(() => next);
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
  }, [t, markSaved]);

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

  async function runTest(evidence?: SecondFactorEvidence): Promise<boolean> {
    try {
      const result = await testBackupTarget(evidence);
      evidenceState.close();
      setTestResult({ ok: result.ok, message: result.message });
      return true;
    } catch (e) {
      // Der Nachweis fehlt erst beim Test: Dialog dort, danach nur der Test.
      setPending('test');
      if (evidenceState.handle(e, evidence)) return false;
      setActionError(
        e instanceof ApiError && e.error.code === 'backup_agent_unavailable'
          ? t('backup.agentUnavailable')
          : errorText(e, t('backup.testRequestFailed')),
      );
      return false;
    }
  }

  async function run(action: Pending, evidence?: SecondFactorEvidence) {
    setBusy(true);
    setActionError(null);
    try {
      if (action === 'saveTest' && check.input !== null) {
        const input = check.input;
        let response: BackupSettings;
        try {
          response = await saveBackupSettings(input, evidence);
        } catch (e) {
          if (evidenceState.handle(e, evidence)) return;
          setActionError(
            e instanceof ApiError && e.error.code === 'backup_agent_unavailable'
              ? t('backup.agentUnavailable')
              : errorText(e, t('backup.saveFailed')),
          );
          return;
        }
        setSettings(response);
        // Geheimnisse sofort aus dem Speicher der Ansicht räumen.
        const next = withoutSecrets(formFrom(response));
        setForm(next);
        markSaved(() => next);
        toast.show(t('backup.saved'));
        if (response.ageIdentity) setAgeIdentity(response.ageIdentity);
      }
      await runTest(evidence);
    } finally {
      setBusy(false);
    }
  }

  function start(action: Pending) {
    setPending(action);
    setTestResult(null);
    if (action === 'saveTest') {
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
  const provider = form.provider;

  // „Erweitert“ ist offen, wenn der Nutzer es öffnet, ein Fehler darin steckt
  // oder ein Wert von der Vorgabe der Vorlage abweicht.
  const retentionBad = showProblems && check.problems.includes(t('backup.errRetention'));
  const defaultPathStyle = provider === 'minio';
  const deviates =
    form.retentionDays !== DEFAULT_RETENTION ||
    (isS3 && (form.prefix !== '' || form.pathStyle !== defaultPathStyle)) ||
    (!isS3 && form.hostKeyFingerprint !== '');
  const advancedShown = advancedOpen || retentionBad || deviates;

  const endpointHint =
    provider === 'hetzner'
      ? t('backup.s3EndpointHintHetzner')
      : provider === 'aws'
        ? t('backup.s3EndpointHintAws')
        : provider === 'minio'
          ? t('backup.s3EndpointHintMinio')
          : t('backup.s3EndpointHint');

  const barError =
    actionError ?? (showProblems && check.problems.length > 0 ? t('backup.errorsInForm') : null);

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
          if (!busy && agent?.configured !== false) start('saveTest');
        }}
        noValidate
      >
        <div className={GRID}>
          <SelectField
            id="sicherung-typ"
            label={t('backup.targetTypeLabel')}
            value={form.type}
            onChange={(value) => set('type', value === 'storagebox' ? 'storagebox' : 's3')}
          >
            <option value="s3">{t('backup.targetTypeS3')}</option>
            <option value="storagebox">{t('backup.targetTypeStoragebox')}</option>
          </SelectField>
          {isS3 && (
            <SelectField
              id="sicherung-anbieter"
              label={t('backup.providerLabel')}
              value={provider}
              onChange={(value) =>
                setForm((previous) =>
                  applyProvider(
                    previous,
                    value === 'hetzner' || value === 'aws' || value === 'minio' ? value : 'other',
                  ),
                )
              }
            >
              <option value="hetzner">{t('backup.providerHetzner')}</option>
              <option value="aws">{t('backup.providerAws')}</option>
              <option value="minio">{t('backup.providerMinio')}</option>
              <option value="other">{t('backup.providerOther')}</option>
            </SelectField>
          )}
        </div>

        {isS3 ? (
          <>
            <InputField id="sicherung-endpunkt" label={t('backup.s3Endpoint')} helperText={endpointHint} value={form.endpoint} onChange={(e) => set('endpoint', e.target.value)} autoComplete="off" />
            <div className={GRID}>
              {provider === 'hetzner' ? (
                <SelectField
                  id="sicherung-region"
                  label={t('backup.s3Location')}
                  value={form.region}
                  onChange={(value) => setForm((previous) => withRegion(previous, value))}
                >
                  <option value="fsn1">{t('backup.locationFsn1')}</option>
                  <option value="nbg1">{t('backup.locationNbg1')}</option>
                  <option value="hel1">{t('backup.locationHel1')}</option>
                </SelectField>
              ) : (
                <InputField
                  id="sicherung-region"
                  label={t('backup.s3Region')}
                  helperText={provider === 'minio' ? t('backup.s3RegionHintMinio') : provider === 'aws' ? t('backup.s3RegionHint') : undefined}
                  value={form.region}
                  onChange={(e) => setForm((previous) => withRegion(previous, e.target.value))}
                  autoComplete="off"
                />
              )}
              <InputField id="sicherung-bucket" label={t('backup.s3Bucket')} value={form.bucket} onChange={(e) => set('bucket', e.target.value)} autoComplete="off" />
              <InputField id="sicherung-schluessel-id" label={t('backup.s3AccessKeyId')} placeholder={secretPlaceholder} value={form.accessKeyId} onChange={(e) => set('accessKeyId', e.target.value)} autoComplete="off" />
              <InputField id="sicherung-geheimschluessel" label={t('backup.s3SecretAccessKey')} type="password" placeholder={secretPlaceholder} value={form.secretAccessKey} onChange={(e) => set('secretAccessKey', e.target.value)} autoComplete="new-password" />
            </div>
          </>
        ) : (
          <>
            <div className={GRID}>
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
              {form.authType === 'password' && (
                <InputField id="sicherung-passwort" label={t('backup.boxPassword')} type="password" placeholder={secretPlaceholder} value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
              )}
            </div>
            {form.authType === 'key' && (
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

        <div className={GRID}>
          <SelectField
            id="sicherung-zeitplan"
            label={t('backup.schedule')}
            value={form.schedule}
            onChange={(value) => set('schedule', value === 'twice_daily' ? 'twice_daily' : 'daily')}
          >
            <option value="daily">{t('backup.scheduleDaily')}</option>
            <option value="twice_daily">{t('backup.scheduleTwiceDaily')}</option>
          </SelectField>
        </div>

        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text">{t('backup.objectLockTitle')}</p>
            <p className="text-sm text-leise">{isS3 ? t('backup.objectLockHint') : t('backup.objectLockOnlyS3')}</p>
          </div>
          <Switch on={isS3 && form.objectLock} disabled={!isS3} onToggle={(v) => set('objectLock', v)} label={t('backup.objectLock')} />
        </div>

        <div className="mb-4 rounded-lg border border-rahmen">
          <button
            type="button"
            aria-expanded={advancedShown}
            aria-controls="sicherung-erweitert"
            disabled={retentionBad || deviates}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-text sm:min-h-0"
          >
            <ChevronRight className={`h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none ${advancedShown ? 'rotate-90' : ''}`} aria-hidden="true" />
            {t('backup.advancedTitle')}
          </button>
          {advancedShown && (
            <div id="sicherung-erweitert" className="border-t border-rahmen px-3 pt-3">
              <p className="mb-3 text-sm text-leise">{t('backup.advancedHint')}</p>
              <div className={GRID}>
                {isS3 && (
                  <InputField id="sicherung-praefix" label={t('backup.s3Prefix')} helperText={t('backup.s3PrefixHint')} value={form.prefix} onChange={(e) => set('prefix', e.target.value)} autoComplete="off" />
                )}
                <InputField id="sicherung-aufbewahrung" label={t('backup.retentionDays')} helperText={t('backup.retentionHint')} inputMode="numeric" value={form.retentionDays} onChange={(e) => set('retentionDays', e.target.value)} autoComplete="off" />
              </div>
              {!isS3 && (
                <InputField id="sicherung-hostkey" label={t('backup.hostKeyInput')} helperText={t('backup.hostKeyInputHint')} value={form.hostKeyFingerprint} onChange={(e) => set('hostKeyFingerprint', e.target.value)} placeholder="SHA256:…" autoComplete="off" spellCheck={false} />
              )}
              {isS3 && (
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">{t('backup.s3PathStyle')}</p>
                    <p className="text-sm text-leise">{t('backup.s3PathStyleHint')}</p>
                  </div>
                  <Switch on={form.pathStyle} onToggle={(v) => set('pathStyle', v)} label={t('backup.s3PathStyle')} />
                </div>
              )}
            </div>
          )}
        </div>

        {showProblems && check.problems.length > 0 && (
          <div role="alert" className="mb-4 text-sm text-gefahr">
            <p className="font-medium">{t('backup.errorsTitle')}</p>
            <ul className="list-disc pl-5">
              {check.problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
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
        {configured && !dirty && (
          <Button
            type="button"
            variant="ghost"
            loading={busy && pending === 'test'}
            disabled={busy || agent?.configured === false}
            onClick={() => start('test')}
          >
            {t('backup.testButton')}
          </Button>
        )}

        <StickySaveBar
          dirty={dirty}
          saving={busy}
          error={barError}
          label={t('backup.barRegion')}
          saveLabel={t('backup.saveTestButton')}
          onSave={() => {
            if (!busy && agent?.configured !== false) start('saveTest');
          }}
          onDiscard={() => {
            setForm(baseline);
            setShowProblems(false);
            setActionError(null);
          }}
        />
      </form>

      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={pending === 'saveTest' ? t('backup.evidenceTitleSave') : t('backup.evidenceTitleTest')}
        declaration={pending === 'saveTest' ? t('backup.evidenceReasonSave') : t('backup.evidenceReasonTest')}
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
