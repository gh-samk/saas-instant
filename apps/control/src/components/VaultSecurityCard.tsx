import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, LifeBuoy, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card, Dialog, InputField, Skeleton, useToast } from '@saas-instant/ui';
import { PassphraseFields } from './PassphraseFields';
import { RecoveryKeyPanel } from './RecoveryKeyPanel';
import { SecondFactorEvidenceDialog } from './SecondFactorEvidenceDialog';
import { useAuth } from '../context/AuthContext';
import {
  fetchVaultEntries,
  fetchVaultLegacyPlaintext,
  vaultAddPassphrase,
  vaultChangePassphrase,
  vaultRegenerateRecovery,
  vaultRemovePassphrase,
} from '../lib/api';
import type { SecondFactorEvidence, VaultEntry } from '../lib/api';
import { ApiError, ERROR_CODE, errorText } from '../lib/api-client';
import { useSecondFactorEvidence } from '../lib/second-factor';
import { passphrasePairValid } from '../lib/vault';
import { formatDate } from '../utils/date';
import { useT } from '../i18n';

type Action =
  | { kind: 'change'; entry: VaultEntry }
  | { kind: 'add' }
  | { kind: 'remove'; entry: VaultEntry }
  | { kind: 'regenerate' };

/**
 * Einstellungen → Sicherheit: Stand der Datenverschlüsselung und die drei
 * Handlungen Passphrase ändern, weitere Passphrase hinzufügen und
 * Wiederherstellungsschlüssel neu erzeugen. Jede packt nur den Schlüssel neu
 * ein, die Daten selbst bleiben unverändert. Alle drei verlangen wie die
 * anderen sensiblen Handlungen einen frischen zweiten Faktor.
 */
export function VaultSecurityCard() {
  const t = useT();
  const toast = useToast();
  const { state } = useAuth();
  const evidenceState = useSecondFactorEvidence();
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Belege und Protokolleinträge aus der Zeit vor dem Tresor (unveränderlich, Klartext).
  const [legacy, setLegacy] = useState<{ invoices: number; auditEntries: number } | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [current, setCurrent] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [label, setLabel] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const list = await fetchVaultEntries();
      if (!Array.isArray(list)) throw new Error('unexpected response');
      if (alive.current) setEntries(list);
    } catch {
      if (alive.current) setLoadError(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    // Reine Information: scheitert sie, fehlt nur der Hinweis.
    fetchVaultLegacyPlaintext()
      .then((counts) => {
        if (alive.current) setLegacy(counts);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
    };
  }, [load]);

  function open(next: Action): void {
    setCurrent('');
    setPassphrase('');
    setRepeat('');
    setLabel('');
    setNewKey(null);
    setConfirmed(false);
    setError(null);
    setAction(next);
  }

  function close(): void {
    setAction(null);
    setCurrent('');
    setPassphrase('');
    setRepeat('');
    setNewKey(null);
    setConfirmed(false);
    setError(null);
    evidenceState.close();
  }

  async function perform(evidence?: SecondFactorEvidence): Promise<void> {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      if (action.kind === 'change') {
        await vaultChangePassphrase(action.entry.id, current, passphrase, evidence);
        evidenceState.close();
        toast.show(t('vault.changeDone'));
        close();
      } else if (action.kind === 'remove') {
        await vaultRemovePassphrase(action.entry.id, evidence);
        evidenceState.close();
        toast.show(t('vault.removeDone'));
        close();
      } else if (action.kind === 'add') {
        await vaultAddPassphrase(passphrase, label.trim() || undefined, evidence);
        evidenceState.close();
        toast.show(t('vault.addDone'));
        close();
      } else {
        const result = await vaultRegenerateRecovery(evidence);
        evidenceState.close();
        setNewKey(result.recoveryKey);
      }
      void load();
    } catch (e) {
      if (evidenceState.handle(e, evidence)) return;
      const fallback =
        action.kind === 'change'
          ? t('vault.changeFailed')
          : action.kind === 'add'
            ? t('vault.addFailed')
            : action.kind === 'remove'
              ? t('vault.removeFailed')
              : t('vault.regenerateFailed');
      setError(
        action.kind === 'change' &&
          e instanceof ApiError &&
          e.error.code === ERROR_CODE.vaultWrongSecret
          ? t('vault.changeWrongCurrent')
          : action.kind === 'remove' &&
              e instanceof ApiError &&
              e.error.code === ERROR_CODE.vaultLastEntry
            ? t('vault.removeLastEntry')
            : errorText(e, fallback),
      );
    } finally {
      setBusy(false);
    }
  }

  const totpPossible = state?.totpSetUp ?? false;
  const pairOk = passphrasePairValid(passphrase, repeat);

  return (
    <Card className="mt-6 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-primaer" aria-hidden="true" />
        <h2 className="text-lg font-semibold text-text">{t('vault.cardTitle')}</h2>
        <Badge className="bg-flaeche-3 text-text">{t('vault.cardStatusUnlocked')}</Badge>
      </div>
      <p className="mt-1 text-sm text-leise">{t('vault.cardIntro')}</p>

      {loadError ? (
        <div className="mt-4" role="alert">
          <p className="mb-2 text-sm text-gefahr">{t('vault.cardLoadError')}</p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            {t('vault.cardRetry')}
          </Button>
        </div>
      ) : entries === null ? (
        <Skeleton className="mt-4 h-16 w-full" />
      ) : (
        <ul className="mt-4 divide-y divide-rahmen rounded-lg border border-rahmen">
          {entries.map((entry) => {
            const isKey = entry.kind === 'recovery';
            const own = entry.userId !== null && entry.userId === state?.user.id;
            // Die erste Passphrase trägt die Bezeichnung „Passphrase“ selbst:
            // dann nicht „Passphrase von Passphrase“.
            const unnamed = entry.label.trim().toLowerCase() === 'passphrase';
            const name = isKey
              ? t('vault.entryRecovery')
              : unnamed
                ? t('vault.entryPassphraseDefault')
                : t('vault.entryPassphrase', { label: entry.label });
            return (
              <li
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {isKey ? (
                    <LifeBuoy className="h-4 w-4 shrink-0 text-leise" aria-hidden="true" />
                  ) : (
                    <KeyRound className="h-4 w-4 shrink-0 text-leise" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text">
                      {name}
                      {own && <span className="font-normal text-leise"> · {t('vault.entryOwn')}</span>}
                    </p>
                    <p className="text-sm text-leise">
                      {isKey
                        ? t('vault.entryRecoveryCreated', { date: formatDate(entry.createdAt) })
                        : t('vault.entryPassphraseCreated', { date: formatDate(entry.createdAt) })}
                    </p>
                  </div>
                </div>
                {isKey ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={t('vault.regenerateAria')}
                    onClick={() => open({ kind: 'regenerate' })}
                  >
                    {t('vault.regenerateButton')}
                  </Button>
                ) : (
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={
                        unnamed
                          ? t('vault.changeAriaDefault')
                          : t('vault.changeAria', { label: entry.label })
                      }
                      onClick={() => open({ kind: 'change', entry })}
                    >
                      {t('vault.changeButton')}
                    </Button>
                    {entries.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={
                          unnamed
                            ? t('vault.removeAriaDefault')
                            : t('vault.removeAria', { label: entry.label })
                        }
                        onClick={() => open({ kind: 'remove', entry })}
                      >
                        {t('vault.removeButton')}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {legacy !== null && (legacy.invoices > 0 || legacy.auditEntries > 0) && (
        <div
          role="note"
          className="mt-4 flex items-start gap-2 rounded-lg border border-rahmen bg-flaeche-2 p-3 text-sm text-text"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-leise" aria-hidden="true" />
          <div>
            <p>
              {t('vault.legacyIntro', {
                invoices: legacy.invoices,
                invoicesText: t(
                  legacy.invoices === 1 ? 'vault.legacyInvoices_one' : 'vault.legacyInvoices_other',
                  { count: legacy.invoices },
                ),
                entries: legacy.auditEntries,
                entriesText: t(
                  legacy.auditEntries === 1 ? 'vault.legacyEntries_one' : 'vault.legacyEntries_other',
                  { count: legacy.auditEntries },
                ),
              })}
            </p>
            <p className="mt-1 text-leise">{t('vault.legacyWhy')}</p>
          </div>
        </div>
      )}

      <div className="mt-4">
        <Button variant="secondary" onClick={() => open({ kind: 'add' })}>
          {t('vault.addButton')}
        </Button>
      </div>

      {/* --- Passphrase ändern ------------------------------------------- */}
      <Dialog
        open={action?.kind === 'change'}
        title={t('vault.changeTitle')}
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={close}>{t('vault.cancel')}</Button>
            <Button
              loading={busy}
              disabled={current === '' || !pairOk}
              onClick={() => void perform()}
            >
              {t('vault.changeSubmit')}
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-leise">{t('vault.changeNote')}</p>
        <InputField
          id="vault-change-current"
          label={t('vault.changeCurrentLabel')}
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <PassphraseFields
          idPrefix="vault-change"
          label={t('vault.passphraseNewLabel')}
          value={passphrase}
          onValueChange={setPassphrase}
          repeat={repeat}
          onRepeatChange={setRepeat}
          disabled={busy}
        />
        {error && action?.kind === 'change' && (
          <p role="alert" className="text-sm text-gefahr">{error}</p>
        )}
      </Dialog>

      {/* --- Passphrase entziehen ----------------------------------------- */}
      <Dialog
        open={action?.kind === 'remove'}
        title={t('vault.removeTitle')}
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={close}>{t('vault.cancel')}</Button>
            <Button variant="danger" loading={busy} onClick={() => void perform()}>
              {t('vault.removeSubmit')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-text">
          {action?.kind === 'remove'
            ? t('vault.removeNote', {
                name:
                  action.entry.label.trim().toLowerCase() === 'passphrase'
                    ? t('vault.entryPassphraseDefault')
                    : t('vault.entryPassphrase', { label: action.entry.label }),
              })
            : ''}
        </p>
        <p className="mt-2 text-sm text-leise">{t('vault.removeLimit')}</p>
        {error && action?.kind === 'remove' && (
          <p role="alert" className="mt-3 text-sm text-gefahr">{error}</p>
        )}
      </Dialog>

      {/* --- Weitere Passphrase ------------------------------------------ */}
      <Dialog
        open={action?.kind === 'add'}
        title={t('vault.addTitle')}
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={close}>{t('vault.cancel')}</Button>
            <Button loading={busy} disabled={!pairOk} onClick={() => void perform()}>
              {t('vault.addSubmit')}
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-leise">{t('vault.addNote')}</p>
        <InputField
          id="vault-add-label"
          label={t('vault.addLabelLabel')}
          helperText={t('vault.addLabelHint')}
          maxLength={80}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <PassphraseFields
          idPrefix="vault-add"
          value={passphrase}
          onValueChange={setPassphrase}
          repeat={repeat}
          onRepeatChange={setRepeat}
          disabled={busy}
        />
        {error && action?.kind === 'add' && (
          <p role="alert" className="text-sm text-gefahr">{error}</p>
        )}
      </Dialog>

      {/* --- Wiederherstellungsschlüssel neu erzeugen --------------------- */}
      <Dialog
        open={action?.kind === 'regenerate'}
        title={t('vault.regenerateTitle')}
        onClose={close}
        footer={
          newKey === null ? (
            <>
              <Button variant="ghost" onClick={close}>{t('vault.cancel')}</Button>
              <Button loading={busy} onClick={() => void perform()}>
                {t('vault.regenerateSubmit')}
              </Button>
            </>
          ) : (
            <Button disabled={!confirmed} onClick={close}>
              {t('vault.regenerateDone')}
            </Button>
          )
        }
      >
        {newKey === null ? (
          <>
            <p className="text-sm text-leise">{t('vault.regenerateNote')}</p>
            {error && action?.kind === 'regenerate' && (
              <p role="alert" className="mt-3 text-sm text-gefahr">{error}</p>
            )}
          </>
        ) : (
          <RecoveryKeyPanel
            recoveryKey={newKey}
            confirmed={confirmed}
            onConfirmedChange={setConfirmed}
          />
        )}
      </Dialog>

      <SecondFactorEvidenceDialog
        open={evidenceState.open}
        title={t('vault.evidenceTitle')}
        declaration={t('vault.evidenceReason')}
        totpPossible={totpPossible}
        loading={busy}
        error={evidenceState.error}
        onCancel={evidenceState.close}
        onConfirm={(evidence) => void perform(evidence)}
      />
    </Card>
  );
}
